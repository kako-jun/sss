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

/// `ignore_rules` の主キーが既に `(pattern, rule_type)` の複合キーになっているか
/// （`pragma_table_info` の `pk` 列は主キー内の並び1始まり、非主キーは0）。
fn ignore_rules_has_composite_pk(conn: &Connection) -> Result<bool> {
    let pk: i32 = conn.query_row(
        "SELECT COALESCE(MAX(pk), 0) FROM pragma_table_info('ignore_rules') WHERE name = 'rule_type'",
        [],
        |row| row.get(0),
    )?;
    Ok(pk > 0)
}

/// `file_metadata` の1行（path, modified_time, file_size）
type FileMetadataRow = (String, i64, i64);

/// `exif_cache` の1行（path, captured_date, file_mtime）
type ExifCacheRow = (String, Option<String>, i64);

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
        // ファイルメタデータキャッシュ（ディスク上の物理的な事実のみを保持する。
        // 撮影日は #61 で `exif_cache` テーブルへ分離した。除外ルールで対象外になった
        // ファイルもここには残り続ける＝「削除」とは区別する。#61 レビュー M2/S1）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS file_metadata (
                path TEXT PRIMARY KEY,
                modified_time INTEGER NOT NULL,
                file_size INTEGER NOT NULL,
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
        // 主キーは (pattern, rule_type) の複合キー（#61 レビュー nit: 同じ文字列の glob
        // ルールと date ルールが衝突しないように）。#61 以前のDBには rule_type 列自体が
        // 無いため、既存行は run_migrations で 'glob' 補完し複合キーへ作り直す）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS ignore_rules (
                pattern TEXT NOT NULL,
                rule_type TEXT NOT NULL DEFAULT 'glob',
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (pattern, rule_type)
            )",
            [],
        )?;

        // 撮影日キャッシュ（#61 レビュー M2/S1）。file_metadata から分離し、
        // mark_deleted の対象外にする（ファイルが一時的に消えても撮影日は失わない。
        // 例: USBメモリの一時取り外し）。file_mtime を保持し、再スキャン時に
        // 実際のファイルの mtime と食い違っていれば EXIF 再取得の候補にする。
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS exif_cache (
                path TEXT PRIMARY KEY,
                captured_date TEXT,
                file_mtime INTEGER
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

        // #61 レビュー M1(must): 旧スキーマDB（ignore_rules に rule_type 列が無い等）を
        // 開いた場合、この直後の「デフォルト除外ルール挿入」が rule_type 列を参照するため、
        // マイグレーションより先に実行すると起動時エラー（列が存在しない）になる。
        // 必ず CREATE TABLE 群の直後・データ操作（is_valid 掃除やデフォルトルール挿入）
        // より前に呼ぶこと。
        self.run_migrations()?;

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

        Ok(())
    }

    /// `PRAGMA user_version` に基づく汎用スキーママイグレーション。バージョンを
    /// インクリメントしながら段階的に適用する（#61 の骨組みを #62 以降でも再利用する）。
    fn run_migrations(&self) -> Result<()> {
        let version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 1 {
            self.migrate_to_v1()?;
        }

        Ok(())
    }

    /// v1: `ignore_rules.rule_type` の追加＋複合主キー化、`exif_cache` テーブルの新設（#61）。
    /// 新規DBは `CREATE TABLE` で既に最終形を持つため、各ステップとも冪等（既存なら何もしない）。
    ///
    /// #61 レビュー S6: 各マイグレーションステップは1トランザクションに包み、
    /// 途中で失敗した場合に `user_version` だけが進んでスキーマが半端な状態になることを防ぐ
    /// （`rusqlite::Transaction` が `BEGIN`/`COMMIT` に相当。#62 で v2 を足す際もこの型に倣う）。
    fn migrate_to_v1(&self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;

        add_column_if_missing(
            &tx,
            "ignore_rules",
            "rule_type",
            "TEXT NOT NULL DEFAULT 'glob'",
        )?;

        // pattern 単独主キー → (pattern, rule_type) の複合主キーへ作り直す
        // （#61 レビュー nit: 同一文字列の glob ルールと date ルールが主キー衝突しないように）。
        // 既に複合主キーなら何もしない。
        if !ignore_rules_has_composite_pk(&tx)? {
            tx.execute_batch(
                "CREATE TABLE ignore_rules_new (
                    pattern TEXT NOT NULL,
                    rule_type TEXT NOT NULL DEFAULT 'glob',
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (pattern, rule_type)
                );
                INSERT INTO ignore_rules_new (pattern, rule_type, added_at)
                    SELECT pattern, rule_type, added_at FROM ignore_rules;
                DROP TABLE ignore_rules;
                ALTER TABLE ignore_rules_new RENAME TO ignore_rules;",
            )?;
        }

        tx.execute(
            "CREATE TABLE IF NOT EXISTS exif_cache (
                path TEXT PRIMARY KEY,
                captured_date TEXT,
                file_mtime INTEGER
            )",
            [],
        )?;

        tx.execute("PRAGMA user_version = 1", [])?;
        tx.commit()?;
        Ok(())
    }

    /// ファイルメタデータを挿入または更新
    ///
    /// `INSERT OR REPLACE` ではなく `ON CONFLICT DO UPDATE` を使う（#61）。
    /// `REPLACE` は既存行を一度削除してから再挿入するため、`added_at` が毎回
    /// リセットされてしまう。
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

    /// ファイルメタデータを取得（ディスク上の物理的な事実のみ。撮影日は `exif_cache` 参照）
    pub fn get_all_file_metadata(&self) -> Result<Vec<FileMetadataRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, modified_time, file_size FROM file_metadata")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// 撮影日キャッシュを全件取得（path, captured_date, file_mtime）。
    /// スキャン時、撮影日ルールが1件以上ある場合にだけ呼ばれ、EXIF再取得が必要な
    /// 候補（未取得 or ファイルのmtimeがキャッシュ時と食い違う）を選ぶのに使う（#61）。
    pub fn get_all_exif_cache(&self) -> Result<Vec<ExifCacheRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, captured_date, file_mtime FROM exif_cache")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// 撮影日キャッシュを1件更新する（表示時の遅延取得用。#61）。
    /// EXIFに撮影日が無い画像も `captured_date=NULL` で記録し、次回スキャンでの
    /// 無駄な再取得（同じ「日付なし」判定の繰り返し）を防ぐ。
    pub fn upsert_exif_cache(
        &self,
        path: &str,
        captured_date: Option<&str>,
        file_mtime: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO exif_cache (path, captured_date, file_mtime)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET
                 captured_date = excluded.captured_date,
                 file_mtime = excluded.file_mtime",
            params![path, captured_date, file_mtime],
        )?;
        Ok(())
    }

    /// 撮影日キャッシュをまとめて更新する（スキャン時、rayon で並列取得した結果の一括書込用）。
    pub fn upsert_exif_cache_batch(&self, entries: &[ExifCacheRow]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for (path, captured_date, file_mtime) in entries {
            tx.execute(
                "INSERT INTO exif_cache (path, captured_date, file_mtime)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(path) DO UPDATE SET
                     captured_date = excluded.captured_date,
                     file_mtime = excluded.file_mtime",
                params![path, captured_date, file_mtime],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 指定の撮影日（`YYYY-MM-DD`）とキャッシュ済み撮影日が一致するパス一覧を返す。
    /// 撮影日ルール追加時（`exclude_image` の `date`）に、既にわかっている画像を
    /// 即座にプレイリストから外すために使う（#61）。
    pub fn get_paths_with_captured_date(&self, date: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM exif_cache WHERE captured_date = ?1")?;
        let rows = stmt.query_map([date], |row| row.get::<_, String>(0))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// 削除されたファイルをDBから物理削除する。
    /// `exif_cache` は対象外（#61 レビュー M2: ファイルが一時的に消えても撮影日
    /// キャッシュは失わない。再スキャン時にファイルが復活すれば mtime 一致で再利用される）。
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

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト専用の一意なDBファイルパス（並列テストでも衝突しない。process::id() だけでは
    /// 同一プロセス内の複数テストが衝突するため tag を組み合わせる）。
    fn temp_db_path(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sss_database_test_{tag}_{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// #61 レビュー M1(must) 回帰テスト: 旧スキーマ（`ignore_rules` に `rule_type` 列が
    /// 無い）かつ **空の** `ignore_rules` テーブルを持つDBを `Database::new` で開いても
    /// パニック/エラーにならないこと。マイグレーションがデフォルトルール挿入より先に
    /// 走っていないと、`INSERT INTO ignore_rules (pattern, rule_type) ...` が
    /// 「no such column: rule_type」で失敗し起動時エラーになっていた。
    #[test]
    fn migrating_old_schema_db_with_empty_ignore_rules_does_not_error_and_seeds_defaults() {
        let path = temp_db_path("old_schema_empty_rules");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE ignore_rules (
                    pattern TEXT PRIMARY KEY,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            )
            .unwrap();
            // 意図的に空のまま（旧スキーマ・ルール0件）
        }

        let db =
            Database::new(path.clone()).expect("旧スキーマ+空ignore_rulesでもエラーにならないはず");

        let rules = db.get_ignore_rules().unwrap();
        assert_eq!(
            rules.len(),
            6,
            "空の旧スキーマDBには既定の6ルールが挿入されるはず"
        );
        assert!(rules.iter().all(|(_, t)| *t == RuleType::Glob));

        let _ = std::fs::remove_file(&path);
    }

    /// #61 マイグレーション状態遷移: 旧スキーマ（`ignore_rules` に `rule_type` 列が無い、
    /// `file_metadata` は当時のまま）のDBを直接構築してから `Database::new` で開いたとき、
    /// 列が追加されつつ既存データ（旧ルール・旧ファイルメタデータ）が失われないこと。
    /// デフォルト除外ルールも「既存ルールが1件でもあれば」重複挿入しない。
    #[test]
    fn migrating_old_schema_db_adds_columns_and_preserves_existing_data() {
        let path = temp_db_path("old_schema");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE file_metadata (
                    path TEXT PRIMARY KEY,
                    modified_time INTEGER NOT NULL,
                    file_size INTEGER NOT NULL,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "CREATE TABLE ignore_rules (
                    pattern TEXT PRIMARY KEY,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO file_metadata (path, modified_time, file_size) VALUES ('/old/a.jpg', 111, 222)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ignore_rules (pattern) VALUES ('*.oldrule')",
                [],
            )
            .unwrap();
        }

        let db = Database::new(path.clone()).unwrap();

        // 旧ファイルメタデータは残っている
        let files = db.get_all_file_metadata().unwrap();
        assert_eq!(
            files.iter().find(|(p, ..)| p == "/old/a.jpg"),
            Some(&("/old/a.jpg".to_string(), 111, 222))
        );

        // 旧ルールは rule_type='glob' 補完で残り、デフォルトルールは重複挿入されない
        let rules = db.get_ignore_rules().unwrap();
        assert_eq!(
            rules,
            vec![("*.oldrule".to_string(), RuleType::Glob)],
            "既存ルールがある旧DBにはデフォルトルールを追加せず、旧ルールだけが残るはず"
        );

        let version: i32 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);

        let _ = std::fs::remove_file(&path);
    }

    /// #61 状態遷移: マイグレーション済みDBを複数回開き直しても（例: アプリの再起動を
    /// 繰り返す）ALTER TABLE / テーブル作り直しの二重実行エラーにならず、データも
    /// 壊れないこと（冪等性）。
    #[test]
    fn reopening_migrated_db_multiple_times_is_idempotent() {
        let path = temp_db_path("idempotent");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE file_metadata (
                    path TEXT PRIMARY KEY,
                    modified_time INTEGER NOT NULL,
                    file_size INTEGER NOT NULL,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO file_metadata (path, modified_time, file_size) VALUES ('/old/b.jpg', 1, 2)",
                [],
            )
            .unwrap();
        }

        {
            let db = Database::new(path.clone()).unwrap();
            db.upsert_exif_cache("/old/b.jpg", Some("2023-05-15"), 1)
                .unwrap();
        }

        // 2回・3回目の再オープンでもエラーにならず、値も保たれる
        for _ in 0..2 {
            let db = Database::new(path.clone()).unwrap();
            let files = db.get_all_file_metadata().unwrap();
            assert!(files.iter().any(|(p, ..)| p == "/old/b.jpg"));

            let cache = db.get_all_exif_cache().unwrap();
            let row = cache.iter().find(|(p, ..)| p == "/old/b.jpg").unwrap();
            assert_eq!(row.1, Some("2023-05-15".to_string()));

            let version: i32 = db
                .conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, 1);
        }

        let _ = std::fs::remove_file(&path);
    }

    /// #61 レビュー M2: `mark_deleted` は `exif_cache` を消さない（ファイルが一時的に
    /// 消えても撮影日キャッシュは保持し、復活時に再利用できるようにする）。
    #[test]
    fn mark_deleted_does_not_remove_exif_cache() {
        let path = temp_db_path("mark_deleted_keeps_exif_cache");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata("/photos/a.jpg", 100, 200).unwrap();
        db.upsert_exif_cache("/photos/a.jpg", Some("2023-05-15"), 100)
            .unwrap();

        db.mark_deleted(&["/photos/a.jpg".to_string()]).unwrap();

        let files = db.get_all_file_metadata().unwrap();
        assert!(
            files.iter().all(|(p, ..)| p != "/photos/a.jpg"),
            "file_metadataからは削除されるはず"
        );

        let cache = db.get_all_exif_cache().unwrap();
        assert!(
            cache.iter().any(|(p, ..)| p == "/photos/a.jpg"),
            "exif_cacheはmark_deletedの対象外のはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #61 レビュー nit: `ignore_rules` の主キーが `(pattern, rule_type)` の複合キーに
    /// なっているため、同じ文字列を glob ルールと date ルールの両方で登録できる
    /// （撮影日 "2020-01-01" という glob ルールと、同じ文字列の date ルールが共存できる）。
    #[test]
    fn ignore_rules_composite_primary_key_allows_same_pattern_with_different_rule_type() {
        let path = temp_db_path("composite_pk");
        let db = Database::new(path.clone()).unwrap();

        db.add_ignore_rule("2020-01-01", RuleType::Glob).unwrap();
        db.add_ignore_rule("2020-01-01", RuleType::Date).unwrap();

        let rules = db.get_ignore_rules().unwrap();
        let matching: Vec<_> = rules.iter().filter(|(p, _)| p == "2020-01-01").collect();
        assert_eq!(
            matching.len(),
            2,
            "同じpattern文字列でもrule_typeが違えば両方残るはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// 同値分割: `exif_cache` に行が無い新規ファイルは空リストのままであること。
    #[test]
    fn get_all_exif_cache_empty_by_default() {
        let path = temp_db_path("exif_cache_empty");
        let db = Database::new(path.clone()).unwrap();

        assert!(db.get_all_exif_cache().unwrap().is_empty());

        let _ = std::fs::remove_file(&path);
    }

    /// `get_paths_with_captured_date` は指定日付に一致するパスだけを返す。
    #[test]
    fn get_paths_with_captured_date_filters_by_exact_date() {
        let path = temp_db_path("paths_with_date");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_exif_cache("/a.jpg", Some("2023-05-15"), 1)
            .unwrap();
        db.upsert_exif_cache("/b.jpg", Some("2023-05-16"), 2)
            .unwrap();
        db.upsert_exif_cache("/c.jpg", Some("2023-05-15"), 3)
            .unwrap();
        db.upsert_exif_cache("/d.jpg", None, 4).unwrap();

        let mut matched = db.get_paths_with_captured_date("2023-05-15").unwrap();
        matched.sort();
        assert_eq!(matched, vec!["/a.jpg".to_string(), "/c.jpg".to_string()]);

        let _ = std::fs::remove_file(&path);
    }
}
