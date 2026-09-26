use crate::ignore::RuleType;
use rusqlite::{params, Connection, Result};
use std::path::PathBuf;

/// `playlist_state` の固定行ID（常に1行だけを更新する）。
const PLAYLIST_STATE_ID: i64 = 1;

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
/// `pub`: `commands::scan::resolve_captured_dates`（pub、tests/exif_resolve_throughput.rs から
/// 直接呼ぶ計測用ベンチ）の公開シグネチャに現れるため、private_interfaces lint を避ける必要がある。
pub type ExifCacheRow = (String, Option<String>, i64);

/// `playlist_state` の保存済み状態（#62）:
/// (directory_path, shuffled_list, current_index, history, history_position)
type PlaylistStateRow = (String, Vec<String>, usize, Vec<String>, usize);

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

        // プレイリスト状態（#62で directory_path/history/history_position を追加し実使用開始。
        // shuffled_list/history は JSON 配列文字列で保存する。詳細は docs/architecture.md 参照）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS playlist_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                directory_path TEXT,
                current_index INTEGER DEFAULT 0,
                shuffled_list TEXT,
                history TEXT,
                history_position INTEGER DEFAULT 0,
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

        if version < 2 {
            self.migrate_to_v2()?;
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

    /// v2: `playlist_state` にプレイリスト永続化用の列を追加する（#62）。
    /// 旧スキーマ（`current_index`/`shuffled_list`/`last_shuffled`/`is_paused` のみ）
    /// は #61 まで一度も実使用されていなかったため、既存データの移行は考えず
    /// 列追加のみでよい。新規DBは `CREATE TABLE` で既に最終形を持つため冪等。
    fn migrate_to_v2(&self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;

        add_column_if_missing(&tx, "playlist_state", "directory_path", "TEXT")?;
        add_column_if_missing(&tx, "playlist_state", "history", "TEXT")?;
        add_column_if_missing(
            &tx,
            "playlist_state",
            "history_position",
            "INTEGER DEFAULT 0",
        )?;

        tx.execute("PRAGMA user_version = 2", [])?;
        tx.commit()?;
        Ok(())
    }

    /// プレイリストのシャッフル確定時（新規作成・巡の再シャッフル・`update_images`）に
    /// `shuffled_list` を含む全状態を1トランザクションで保存する（#62）。
    ///
    /// 10万件規模だと `shuffled_list` の JSON は大きくなるため、advance のたびに
    /// これを書くと重い（`save_playlist_position` が軽量版）。シャッフルが実際に
    /// 変わった瞬間だけ呼ぶこと。
    pub fn save_playlist_full(
        &self,
        directory_path: &str,
        shuffled_list: &[String],
        current_index: usize,
        history: &[String],
        history_position: usize,
    ) -> Result<()> {
        let shuffled_list_json = serde_json::to_string(shuffled_list)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let history_json = serde_json::to_string(history)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO playlist_state
                (id, directory_path, shuffled_list, current_index, history, history_position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 directory_path = excluded.directory_path,
                 shuffled_list = excluded.shuffled_list,
                 current_index = excluded.current_index,
                 history = excluded.history,
                 history_position = excluded.history_position",
            params![
                PLAYLIST_STATE_ID,
                directory_path,
                shuffled_list_json,
                current_index as i64,
                history_json,
                history_position as i64,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// advance/go_back のたびに呼ぶ軽量な永続化（#62）。`shuffled_list` は書かない
    /// （10万件規模で毎回書くと重いため）。`save_playlist_full` が一度も呼ばれておらず
    /// 対象行が無い場合は何も起きない（0行更新、エラーにはならない）。
    pub fn save_playlist_position(
        &self,
        current_index: usize,
        history: &[String],
        history_position: usize,
    ) -> Result<()> {
        let history_json = serde_json::to_string(history)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        self.conn.execute(
            "UPDATE playlist_state SET current_index = ?1, history = ?2, history_position = ?3
             WHERE id = ?4",
            params![
                current_index as i64,
                history_json,
                history_position as i64,
                PLAYLIST_STATE_ID,
            ],
        )?;
        Ok(())
    }

    /// 保存済みのプレイリスト状態を読む（#62）。行が無ければ `None`。
    /// 戻り値: (directory_path, shuffled_list, current_index, history, history_position)
    pub fn load_playlist_state(&self) -> Result<Option<PlaylistStateRow>> {
        let row = self.conn.query_row(
            "SELECT directory_path, shuffled_list, current_index, history, history_position
             FROM playlist_state WHERE id = ?1",
            params![PLAYLIST_STATE_ID],
            |row| {
                let directory_path: Option<String> = row.get(0)?;
                let shuffled_list_json: Option<String> = row.get(1)?;
                let current_index: i64 = row.get(2)?;
                let history_json: Option<String> = row.get(3)?;
                let history_position: i64 = row.get(4)?;
                Ok((
                    directory_path,
                    shuffled_list_json,
                    current_index,
                    history_json,
                    history_position,
                ))
            },
        );

        match row {
            Ok((
                Some(directory_path),
                shuffled_list_json,
                current_index,
                history_json,
                history_position,
            )) => {
                let shuffled_list: Vec<String> = shuffled_list_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                let history: Vec<String> = history_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                Ok(Some((
                    directory_path,
                    shuffled_list,
                    current_index.max(0) as usize,
                    history,
                    history_position.max(0) as usize,
                )))
            }
            // directory_path が無い(=save_playlist_fullが一度も呼ばれていない旧行/空行)場合は
            // 復元対象なしとして扱う
            Ok((None, ..)) => Ok(None),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
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

    /// 指定の撮影日（`YYYY-MM-DD`）とキャッシュ済み撮影日が一致する `(path, file_mtime)`
    /// 一覧を返す。撮影日ルール追加時（`exclude_image` の `date`）に、既にわかっている
    /// 画像を即座にプレイリストから外すために使う（#61）。
    ///
    /// `file_mtime` も返すのは、呼び出し元が現在のファイルの実際のmtimeと突き合わせ、
    /// キャッシュ後にファイルが変更（別の画像で上書き等）されていないことを確認して
    /// から即時除去に使うため（#61レビュー nit: キャッシュが古いまま即時除去すると、
    /// 既に別内容になったファイルを誤って除外するおそれがある）。
    pub fn get_paths_with_captured_date(&self, date: &str) -> Result<Vec<(String, i64)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, file_mtime FROM exif_cache WHERE captured_date = ?1")?;
        let rows = stmt.query_map([date], |row| Ok((row.get(0)?, row.get(1)?)))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// 確定削除（生スキャンで見つからず、除外ルールにも一致しない＝ディレクトリ系除外で
    /// 枝刈りされたのでもない）ファイルをDBから物理削除する。`exif_cache` も含めて消す
    /// （#61レビュー nit: 復活の見込みが薄い確定削除のキャッシュを溜め込まない）。
    ///
    /// ディレクトリ系除外で枝刈りされ存在確認できていないだけの「不明」ファイル
    /// （`ScanResult::unknown_files`）はここに渡さないこと。それらは file_metadata/
    /// image_stats/exif_cache のいずれも保持し続ける（#61レビュー S-a）。
    pub fn mark_deleted(&self, paths: &[String]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for path in paths {
            tx.execute("DELETE FROM file_metadata WHERE path = ?1", [path])?;
            tx.execute("DELETE FROM image_stats WHERE path = ?1", [path])?;
            tx.execute("DELETE FROM exif_cache WHERE path = ?1", [path])?;
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

    /// 除外ルールを削除（`(pattern, rule_type)` の複合キーで指定する）。
    /// #61レビュー nit: 主キーが複合キー化されたため、`pattern` だけでは
    /// 同じ文字列のglob/dateルールが両方消えてしまう（または狙った方が消えない）
    /// おそれがある。必ず `rule_type` も指定して一意に絞り込む。
    pub fn remove_ignore_rule(&self, pattern: &str, rule_type: RuleType) -> Result<()> {
        self.conn.execute(
            "DELETE FROM ignore_rules WHERE pattern = ?1 AND rule_type = ?2",
            params![pattern, rule_type.as_str()],
        )?;
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
        // #62で playlist_state のv2マイグレーションが追加されたため、run_migrationsは
        // 常に最新版まで進む。
        assert_eq!(version, 2);

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
            // #62で playlist_state のv2マイグレーションが追加されたため、最新版は2。
            assert_eq!(version, 2);
        }

        let _ = std::fs::remove_file(&path);
    }

    /// #61 レビュー nit: `mark_deleted`（確定削除）は `exif_cache` の該当行も消す
    /// （復活の見込みが薄い確定削除のキャッシュを溜め込まない）。ディレクトリ系除外で
    /// 枝刈りされ存在確認できていないだけの「不明」ファイルは `mark_deleted` に
    /// 渡らないため、この削除の対象にはならない（#61レビュー S-a、`scanner.rs` 側で保証）。
    #[test]
    fn mark_deleted_also_removes_exif_cache_for_confirmed_deletions() {
        let path = temp_db_path("mark_deleted_removes_exif_cache");
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
            cache.iter().all(|(p, ..)| p != "/photos/a.jpg"),
            "確定削除ではexif_cacheも消えるはず"
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

    /// #61レビュー nit: `remove_ignore_rule` は `(pattern, rule_type)` の複合キーで
    /// 削除する。同じpattern文字列でrule_typeが違うルールは巻き添えで消えない。
    #[test]
    fn remove_ignore_rule_only_deletes_matching_rule_type() {
        let path = temp_db_path("remove_rule_composite_key");
        let db = Database::new(path.clone()).unwrap();

        db.add_ignore_rule("2020-01-01", RuleType::Glob).unwrap();
        db.add_ignore_rule("2020-01-01", RuleType::Date).unwrap();

        db.remove_ignore_rule("2020-01-01", RuleType::Date).unwrap();

        let rules = db.get_ignore_rules().unwrap();
        let matching: Vec<_> = rules.iter().filter(|(p, _)| p == "2020-01-01").collect();
        assert_eq!(
            matching,
            vec![&("2020-01-01".to_string(), RuleType::Glob)],
            "date側だけ削除され、glob側は残るはず"
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
        assert_eq!(
            matched,
            vec![("/a.jpg".to_string(), 1), ("/c.jpg".to_string(), 3)]
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #62: 保存済みの状態が無い（`save_playlist_full` を一度も呼んでいない）新規DBは
    /// `load_playlist_state` が `None` を返す。
    #[test]
    fn load_playlist_state_returns_none_when_never_saved() {
        let path = temp_db_path("playlist_state_none");
        let db = Database::new(path.clone()).unwrap();

        assert!(db.load_playlist_state().unwrap().is_none());

        let _ = std::fs::remove_file(&path);
    }

    /// #62: `save_playlist_full` → `load_playlist_state` の往復で
    /// directory_path/shuffled_list/current_index/history/history_position が
    /// すべて過不足なく復元できる（再起動を跨いだ復元の土台）。
    #[test]
    fn save_and_load_playlist_full_roundtrip_preserves_state() {
        let path = temp_db_path("playlist_full_roundtrip");
        let db = Database::new(path.clone()).unwrap();

        let shuffled_list: Vec<String> = vec!["a.jpg", "b.jpg", "c.jpg"]
            .into_iter()
            .map(String::from)
            .collect();
        let history: Vec<String> = vec!["a.jpg", "b.jpg"]
            .into_iter()
            .map(String::from)
            .collect();

        db.save_playlist_full("/photos", &shuffled_list, 1, &history, 1)
            .unwrap();

        let (dir, list, idx, hist, hist_pos) = db.load_playlist_state().unwrap().unwrap();
        assert_eq!(dir, "/photos");
        assert_eq!(list, shuffled_list);
        assert_eq!(idx, 1);
        assert_eq!(hist, history);
        assert_eq!(hist_pos, 1);

        let _ = std::fs::remove_file(&path);
    }

    /// #62: `save_playlist_position` は `current_index`/履歴だけを更新し、
    /// `shuffled_list`/`directory_path` は直前の `save_playlist_full` の値のまま残る
    /// （advance のたびに全件書き直さない軽量パス）。
    #[test]
    fn save_playlist_position_does_not_touch_shuffled_list_or_directory() {
        let path = temp_db_path("playlist_position_light_update");
        let db = Database::new(path.clone()).unwrap();

        let shuffled_list: Vec<String> = vec!["a.jpg", "b.jpg", "c.jpg"]
            .into_iter()
            .map(String::from)
            .collect();
        db.save_playlist_full("/photos", &shuffled_list, 0, &["a.jpg".to_string()], 0)
            .unwrap();

        let new_history: Vec<String> = vec!["a.jpg", "b.jpg"]
            .into_iter()
            .map(String::from)
            .collect();
        db.save_playlist_position(1, &new_history, 1).unwrap();

        let (dir, list, idx, hist, hist_pos) = db.load_playlist_state().unwrap().unwrap();
        assert_eq!(dir, "/photos", "directory_pathは軽量更新で変わらないはず");
        assert_eq!(
            list, shuffled_list,
            "shuffled_listは軽量更新で書き換わらないはず"
        );
        assert_eq!(idx, 1);
        assert_eq!(hist, new_history);
        assert_eq!(hist_pos, 1);

        let _ = std::fs::remove_file(&path);
    }

    /// #62 マイグレーション: 旧スキーマ（`directory_path`/`history`/`history_position`
    /// 列が無い）の `playlist_state` テーブルを持つDBを開いても、列が追加され
    /// エラーにならない。
    #[test]
    fn migrating_old_playlist_state_schema_adds_v2_columns() {
        let path = temp_db_path("playlist_state_v2_migration");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE playlist_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    current_index INTEGER DEFAULT 0,
                    shuffled_list TEXT,
                    last_shuffled DATETIME,
                    is_paused BOOLEAN DEFAULT 0
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO playlist_state (id, current_index, shuffled_list) VALUES (1, 5, '[\"x.jpg\"]')",
                [],
            )
            .unwrap();
        }

        let db =
            Database::new(path.clone()).expect("旧playlist_stateスキーマでもエラーにならないはず");

        // directory_path列が無かった(NULL)ので、load_playlist_stateはNoneを返す
        // (復元対象が無いのと同じ扱い。#62: directory_pathが無いと復元先を判断できない)。
        assert!(db.load_playlist_state().unwrap().is_none());

        // 新しい列を使って書き込めることを確認する(冪等マイグレーション後に書込可能)。
        db.save_playlist_full("/photos", &["x.jpg".to_string()], 0, &[], 0)
            .unwrap();
        let (dir, ..) = db.load_playlist_state().unwrap().unwrap();
        assert_eq!(dir, "/photos");

        let version: i32 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);

        let _ = std::fs::remove_file(&path);
    }

    /// #62 空・未設定(壊れたJSON): `shuffled_list`/`history` 列の中身がディスク破損や
    /// 途中クラッシュ等で壊れたJSON文字列になっていても、`load_playlist_state` は
    /// エラーにせず空リストへフォールバックする（`directory_path` は健全なままなら
    /// 復元対象ありとして返す）。
    #[test]
    fn load_playlist_state_with_corrupted_json_falls_back_to_empty_lists_not_error() {
        let path = temp_db_path("playlist_state_corrupted_json");
        let db = Database::new(path.clone()).unwrap();

        db.save_playlist_full(
            "/photos",
            &["a.jpg".to_string()],
            0,
            &["a.jpg".to_string()],
            0,
        )
        .unwrap();
        // 保存後にJSON列だけを直接壊れた文字列へ書き換える（部分書き込み破損を模す）。
        db.conn
            .execute(
                "UPDATE playlist_state SET shuffled_list = ?1, history = ?2 WHERE id = 1",
                params!["not-valid-json{{{", "also-not-valid[["],
            )
            .unwrap();

        let (dir, list, idx, hist, hist_pos) = db
            .load_playlist_state()
            .expect("壊れたJSONでもエラーにはならないはず")
            .expect("directory_pathは健全なので復元対象ありのはず");

        assert_eq!(dir, "/photos");
        assert_eq!(
            list,
            Vec::<String>::new(),
            "壊れたJSONのshuffled_listは空リストにフォールバックするはず"
        );
        assert_eq!(
            hist,
            Vec::<String>::new(),
            "壊れたJSONのhistoryは空リストにフォールバックするはず"
        );
        assert_eq!(idx, 0);
        assert_eq!(hist_pos, 0);

        let _ = std::fs::remove_file(&path);
    }

    /// #62 失敗系/空・未設定: `save_playlist_full` を一度も呼んでいない状態で
    /// `save_playlist_position`（軽量更新）だけを呼んでも、対象行が無いだけで
    /// エラーにはならない（0行更新）。呼んだ後も復元対象は増えない。
    #[test]
    fn save_playlist_position_without_prior_full_save_is_noop_not_error() {
        let path = temp_db_path("playlist_position_before_full_save");
        let db = Database::new(path.clone()).unwrap();

        let result = db.save_playlist_position(3, &["a.jpg".to_string()], 0);
        assert!(result.is_ok(), "対象行が無くてもエラーにはならないはず");

        assert!(
            db.load_playlist_state().unwrap().is_none(),
            "save_playlist_fullを呼んでいないので依然として復元対象は無いはず"
        );

        let _ = std::fs::remove_file(&path);
    }
}
