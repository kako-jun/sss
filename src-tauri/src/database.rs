use crate::ignore::RuleType;
use rusqlite::{params, Connection, Result};
use std::path::PathBuf;

/// テーブルに列が無ければ追加する（`PRAGMA user_version` による汎用マイグレーションの
/// 部品。#61 で導入、#62 以降のスキーマ変更でも再利用する）。
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let exists: bool = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
        [],
        |row| row.get::<_, i32>(0),
    )? > 0;
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

/// `file_metadata` の1行（path, modified_time, file_size, captured_date）
type FileMetadataRow = (String, i64, i64, Option<String>);

pub struct Database {
    conn: Connection,
}

impl Database {
    /// データベースを初期化
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        let db = Database { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// データベーススキーマを初期化
    fn init_schema(&self) -> Result<()> {
        // ファイルメタデータキャッシュ
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS file_metadata (
                path TEXT PRIMARY KEY,
                modified_time INTEGER NOT NULL,
                file_size INTEGER NOT NULL,
                captured_date TEXT,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 画像統計情報
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS image_stats (
                path TEXT PRIMARY KEY,
                display_count INTEGER DEFAULT 0,
                last_displayed DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // プレイリスト状態
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS playlist_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                current_index INTEGER DEFAULT 0,
                shuffled_list TEXT,
                last_shuffled DATETIME,
                is_paused BOOLEAN DEFAULT 0
            )",
            [],
        )?;

        // 除外ルール（rule_type: "glob"（末尾 `/` はディレクトリ名照合）| "date"（撮影日）。
        // #61 以前のDBには列が無いため、既存行は run_migrations で 'glob' 補完する）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS ignore_rules (
                pattern TEXT PRIMARY KEY,
                rule_type TEXT NOT NULL DEFAULT 'glob',
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // スキャン履歴
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS scan_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                directory_path TEXT,
                total_files INTEGER,
                new_files INTEGER,
                deleted_files INTEGER,
                scan_duration_ms INTEGER,
                scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // アプリ設定
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // インデックス作成
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_modified_time ON file_metadata(modified_time)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_display_count ON image_stats(display_count)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_last_displayed ON image_stats(last_displayed)",
            [],
        )?;

        // 旧スキーマからのマイグレーション: is_valid カラムが残っている場合は論理削除行を物理削除して廃止
        let has_is_valid: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('file_metadata') WHERE name = 'is_valid'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if has_is_valid {
            // is_valid = 0 の行（論理削除済み）とその image_stats を物理削除
            self.conn.execute(
                "DELETE FROM image_stats WHERE path IN (SELECT path FROM file_metadata WHERE is_valid = 0)",
                [],
            )?;
            self.conn
                .execute("DELETE FROM file_metadata WHERE is_valid = 0", [])?;
            // is_valid インデックスを削除
            self.conn.execute("DROP INDEX IF EXISTS idx_is_valid", [])?;
            // is_valid カラムを削除（SQLite 3.35.0+）
            self.conn
                .execute("ALTER TABLE file_metadata DROP COLUMN is_valid", [])?;
        }

        // ignore_rules が空の場合のみデフォルト除外ルールを挿入
        // （#61: 文字列自体は変更しない。末尾 `/` パターンの判定ロジック側を直したため
        // 既存DBに保存済みの同じ文字列でも新しい挙動が効く＝データ移行は不要）
        let rule_count: i32 = self
            .conn
            .query_row("SELECT COUNT(*) FROM ignore_rules", [], |row| row.get(0))
            .unwrap_or(0);
        if rule_count == 0 {
            let default_rules = [
                "**/.thumbnails/",
                "**/Thumbs.db",
                "**/.DS_Store",
                "**/@eaDir/",
                "**/desktop.ini",
                "**/.**/",
            ];
            for rule in &default_rules {
                self.conn.execute(
                    "INSERT OR IGNORE INTO ignore_rules (pattern, rule_type) VALUES (?1, 'glob')",
                    [rule],
                )?;
            }
        }

        self.run_migrations()?;

        Ok(())
    }

    /// `PRAGMA user_version` に基づく汎用スキーママイグレーション。バージョンを
    /// インクリメントしながら段階的に適用する（#61 の骨組みを #62 以降でも再利用する）。
    fn run_migrations(&self) -> Result<()> {
        let mut version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 1 {
            self.migrate_to_v1()?;
            version = 1;
            self.conn
                .execute(&format!("PRAGMA user_version = {version}"), [])?;
        }

        Ok(())
    }

    /// v1: `ignore_rules.rule_type` と `file_metadata.captured_date` を追加する（#61）。
    /// 新規DBは `CREATE TABLE` で既に列を持つため、両方とも冪等（既存なら何もしない）。
    fn migrate_to_v1(&self) -> Result<()> {
        add_column_if_missing(
            &self.conn,
            "ignore_rules",
            "rule_type",
            "TEXT NOT NULL DEFAULT 'glob'",
        )?;
        add_column_if_missing(&self.conn, "file_metadata", "captured_date", "TEXT")?;
        Ok(())
    }

    /// ファイルメタデータを挿入または更新
    ///
    /// `INSERT OR REPLACE` ではなく `ON CONFLICT DO UPDATE` を使う（#61）。
    /// `REPLACE` は既存行を一度削除してから再挿入するため、対象外の列
    /// （`captured_date`・`added_at`）が毎回リセットされてしまう。特に
    /// `captured_date` は毎回のスキャンで全ファイルに対して呼ばれるため、
    /// `REPLACE` のままだと表示時に取得済みの撮影日が次のスキャンで消えてしまう。
    pub fn upsert_file_metadata(
        &self,
        path: &str,
        modified_time: i64,
        file_size: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO file_metadata (path, modified_time, file_size)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET
                 modified_time = excluded.modified_time,
                 file_size = excluded.file_size",
            params![path, modified_time, file_size],
        )?;
        Ok(())
    }

    /// ファイルメタデータを取得（撮影日込み。#61: 日付除外ルールの判定に使う）
    pub fn get_all_file_metadata(&self) -> Result<Vec<FileMetadataRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, modified_time, file_size, captured_date FROM file_metadata")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// 表示時に取得したEXIF撮影日をDBに保存する（#61: 撮影日除外ルールの判定用）。
    /// `file_metadata` に行が無い（未スキャン等）場合は静かに無視する。
    pub fn set_captured_date(&self, path: &str, captured_date: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE file_metadata SET captured_date = ?1 WHERE path = ?2",
            params![captured_date, path],
        )?;
        Ok(())
    }

    /// 削除されたファイルをDBから物理削除する
    pub fn mark_deleted(&self, paths: &[String]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for path in paths {
            tx.execute("DELETE FROM file_metadata WHERE path = ?1", [path])?;
            tx.execute("DELETE FROM image_stats WHERE path = ?1", [path])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 画像の表示回数を増やす
    pub fn increment_display_count(&self, path: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO image_stats (path, display_count, last_displayed)
             VALUES (?1, 1, datetime('now', 'localtime'))
             ON CONFLICT(path) DO UPDATE SET
                 display_count = display_count + 1,
                 last_displayed = datetime('now', 'localtime')",
            [path],
        )?;
        Ok(())
    }

    /// 画像統計を取得
    pub fn get_image_stats(&self, path: &str) -> Result<(i32, Option<String>)> {
        let mut stmt = self
            .conn
            .prepare("SELECT display_count, last_displayed FROM image_stats WHERE path = ?1")?;
        let result = stmt.query_row([path], |row| Ok((row.get(0)?, row.get(1)?)));

        match result {
            Ok(data) => Ok(data),
            Err(_) => Ok((0, None)),
        }
    }

    /// スキャン履歴を記録
    pub fn record_scan_history(
        &self,
        directory_path: &str,
        total_files: i32,
        new_files: i32,
        deleted_files: i32,
        scan_duration_ms: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO scan_history (directory_path, total_files, new_files, deleted_files, scan_duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                directory_path,
                &total_files.to_string(),
                &new_files.to_string(),
                &deleted_files.to_string(),
                &scan_duration_ms.to_string(),
            ],
        )?;
        Ok(())
    }

    /// 総画像数を取得
    pub fn get_total_image_count(&self) -> Result<i32> {
        let count: i32 = self
            .conn
            .query_row("SELECT COUNT(*) FROM file_metadata", [], |row| row.get(0))?;
        Ok(count)
    }

    /// 表示済み画像数を取得
    pub fn get_displayed_image_count(&self) -> Result<i32> {
        let count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM image_stats WHERE display_count > 0",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// 設定を保存
    pub fn save_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now', 'localtime'))",
            [key, value],
        )?;
        Ok(())
    }

    /// 設定を取得
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let result = self.conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        );

        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// 全画像の表示回数をリセット
    pub fn reset_all_display_counts(&self) -> Result<()> {
        self.conn
            .execute("UPDATE image_stats SET display_count = 0", [])?;
        Ok(())
    }

    /// 除外ルール一覧を取得（パターン文字列 + 種別）。#61: 撮影日ルールは
    /// UI・ignoreフィルタ構築の両方で通常globと区別する必要があるため rule_type も返す。
    pub fn get_ignore_rules(&self) -> Result<Vec<(String, RuleType)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT pattern, rule_type FROM ignore_rules ORDER BY added_at ASC")?;
        let rows = stmt.query_map([], |row| {
            let pattern: String = row.get(0)?;
            let rule_type: String = row.get(1)?;
            Ok((pattern, rule_type))
        })?;
        let mut rules = Vec::new();
        for row in rows {
            let (pattern, rule_type) = row?;
            rules.push((pattern, RuleType::parse(&rule_type)));
        }
        Ok(rules)
    }

    /// 除外ルールを追加（`rule_type`: "glob" | "date"）
    pub fn add_ignore_rule(&self, pattern: &str, rule_type: RuleType) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO ignore_rules (pattern, rule_type) VALUES (?1, ?2)",
            params![pattern, rule_type.as_str()],
        )?;
        Ok(())
    }

    /// 除外ルールを削除
    pub fn remove_ignore_rule(&self, pattern: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM ignore_rules WHERE pattern = ?1", [pattern])?;
        Ok(())
    }

    /// 最近表示した画像一覧を取得（last_displayed 降順、limit件）
    pub fn get_recent_images(&self, limit: i32) -> Result<Vec<(String, i32, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, display_count, last_displayed FROM image_stats
             WHERE last_displayed IS NOT NULL
             ORDER BY last_displayed DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// 過去にスキャンした全ディレクトリパス（重複なし）を取得する。
    /// 起動時に asset scope へ動的許可するために使う（前回ディレクトリだけでなく、
    /// 履歴タブ〔`get_recent_images`〕に残る他ディレクトリの画像も表示できるようにする。
    /// レビュー #73 should2）。
    pub fn get_distinct_scan_directories(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT directory_path FROM scan_history WHERE directory_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// スキャン履歴の上限管理（max_entries件を超える古いレコードを削除）
    pub fn trim_scan_history(&self, max_entries: i32) -> Result<()> {
        self.conn.execute(
            "DELETE FROM scan_history WHERE id NOT IN (
                 SELECT id FROM scan_history ORDER BY scanned_at DESC LIMIT ?1
             )",
            [max_entries],
        )?;
        Ok(())
    }

    /// 全画像の表示回数を取得（グラフ用、パスでソート）
    pub fn get_all_display_counts(&self) -> Result<Vec<(String, i32)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, display_count FROM image_stats ORDER BY path ASC")?;

        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }
}
