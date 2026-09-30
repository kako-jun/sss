use crate::ignore::RuleType;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::PathBuf;

/// `playlist_list`/`playlist_position` の固定行ID（常に1行だけを更新する）。
const PLAYLIST_ROW_ID: i64 = 1;

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

/// `get_file_metadata_under` のディレクトリ境界を範囲クエリの下限/上限文字列として
/// 計算する（#63 PR#77レビューM1(must)）。`sep` を引数に取る純粋関数にすることで、
/// コンパイル時のOS（`std::path::MAIN_SEPARATOR`）に関わらず、Windows形式の区切り文字
/// （`\`）を明示的に渡してユニットテストできる。
///
/// - `lower = dir_trimmed + sep`（`directory` 自身の子孫の最小値。`directory` 自身は
///   このAPIの呼び出し元が別途 `path = dir_trimmed` の等価一致で拾う）
/// - `upper = dir_trimmed + (sepの次のバイト)`（`sep` はASCII、`/`=0x2F・`\`=0x5C なので
///   +1 も必ずASCII範囲に収まり安全。BINARY照合＝バイト単位比較のTEXT主キーに対する
///   `path >= lower AND path < upper` が、区切り文字境界での前方一致（`/p/foo` は
///   `/p/foo/bar.jpg` にマッチし `/p/foobar/x.jpg` にはマッチしない）になる。大文字小文字も
///   区別される（BINARY照合はバイト値そのものを比較するため）
fn directory_scope_bounds(dir_trimmed: &str, sep: char) -> (String, String) {
    let lower = format!("{dir_trimmed}{sep}");
    let sep_next =
        char::from_u32(sep as u32 + 1).expect("MAIN_SEPARATORはASCIIなので+1もASCII範囲に収まる");
    let upper = format!("{dir_trimmed}{sep_next}");
    (lower, upper)
}

/// `file_metadata` へのupsertを1件以上、指定の `conn`（`Connection`/`Transaction` の
/// どちらでも可、`prepare_cached`はどちらにも生えている）上で行う（#63）。
/// トランザクション境界は呼び出し元が管理する（このfnはcommitしない）。
fn upsert_file_metadata_within(conn: &Connection, entries: &[(String, i64, i64)]) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare_cached(
        "INSERT INTO file_metadata (path, modified_time, file_size)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET
             modified_time = excluded.modified_time,
             file_size = excluded.file_size",
    )?;
    for (path, modified_time, file_size) in entries {
        stmt.execute(params![path, modified_time, file_size])?;
    }
    Ok(())
}

/// 指定パス群を `file_metadata`/`image_stats`/`exif_cache` から削除する（確定削除。
/// #63）。`upsert_file_metadata_within` と対で使い、`conn` 上でトランザクション境界は
/// 呼び出し元が管理する。
fn delete_file_metadata_within(conn: &Connection, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut del_fm = conn.prepare_cached("DELETE FROM file_metadata WHERE path = ?1")?;
    let mut del_stats = conn.prepare_cached("DELETE FROM image_stats WHERE path = ?1")?;
    let mut del_exif = conn.prepare_cached("DELETE FROM exif_cache WHERE path = ?1")?;
    for path in paths {
        del_fm.execute([path])?;
        del_stats.execute([path])?;
        del_exif.execute([path])?;
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

/// 既定の除外ルール（`rule_type = "glob"`）。新規DB作成時（`ignore_rules` が空の場合）と
/// `reset_all_data`（#64: 全データ初期化）の両方から再利用する。文字列自体は#61以降
/// 変更していない（末尾 `/` の判定ロジック側の修正のみで新しい挙動が効くため）。
const DEFAULT_IGNORE_RULES: [&str; 6] = [
    "**/.thumbnails/",
    "**/Thumbs.db",
    "**/.DS_Store",
    "**/@eaDir/",
    "**/desktop.ini",
    "**/.**/",
];

/// `reset_to_defaults` がDELETEする対象テーブル（#79レビューshould3で配列化した。
/// 新しいユーザーデータテーブルを追加したら必ずここに追記すること。追記漏れは
/// `reset_to_defaults_user_tables_matches_all_tables_in_sqlite_master`（テスト）が
/// `sqlite_master` の実テーブル一覧と突き合わせて検知する）。
const USER_TABLES: [&str; 8] = [
    "file_metadata",
    "image_stats",
    "playlist_list",
    "playlist_position",
    "ignore_rules",
    "exif_cache",
    "scan_history",
    "app_settings",
];

/// `DEFAULT_IGNORE_RULES` を `ignore_rules` に挿入する（`INSERT OR IGNORE` なので
/// 既存行があっても冪等）。`conn` は `Connection`/`Transaction` のどちらでも可。
fn insert_default_ignore_rules(conn: &Connection) -> Result<()> {
    for rule in &DEFAULT_IGNORE_RULES {
        conn.execute(
            "INSERT OR IGNORE INTO ignore_rules (pattern, rule_type) VALUES (?1, 'glob')",
            [rule],
        )?;
    }
    Ok(())
}

/// `file_metadata` の1行（path, modified_time, file_size）
type FileMetadataRow = (String, i64, i64);

/// `exif_cache` の1行（path, captured_date, file_mtime）
/// `pub`: `commands::scan::resolve_captured_dates`（pub、tests/exif_resolve_throughput.rs から
/// 直接呼ぶ計測用ベンチ）の公開シグネチャに現れるため、private_interfaces lint を避ける必要がある。
pub type ExifCacheRow = (String, Option<String>, i64);

/// 保存済みプレイリスト状態（#62、#62レビューM3で `playlist_list`/`playlist_position`
/// の2テーブルに分割）:
/// (directory_path, shuffled_list, next_index, history, history_position)
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

        // プレイリスト状態（#62で実使用開始。#62レビューM3で2テーブルに分割した:
        // - playlist_list: シャッフル確定時（新規作成・巡の再シャッフル・update_images）
        //   にしか書かない大きい方（shuffled_list、10万件規模でJSONが数MBになりうる）。
        // - playlist_position: advance/go_backのたびに書く小さい方（next_index/history/
        //   history_position）。1テーブルのままだと軽量保存のはずのUPDATEでも
        //   shuffled_list列を含む行を書き直すことになり、SQLiteは行全体を作り直すため
        //   実測で1回あたり数十msかかっていた（レビュー実測）。
        // shuffled_list/history は JSON 配列文字列で保存する。詳細は docs/architecture.md 参照
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS playlist_list (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                directory_path TEXT,
                shuffled_list TEXT
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS playlist_position (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                next_index INTEGER DEFAULT 0,
                history TEXT,
                history_position INTEGER DEFAULT 0
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
            insert_default_ignore_rules(&self.conn)?;
        }

        Ok(())
    }

    /// 全データ初期化（#64）: DBファイルは削除せず、開いた接続のまま**1トランザクション**で
    /// 全ユーザーデータテーブルの中身を空にし、既定除外ルールを再投入する。
    ///
    /// - `PRAGMA user_version` とスキーマ（`CREATE TABLE` 群）はそのまま維持する
    ///   （`DELETE FROM` はテーブル定義に触れない）。
    /// - `app_settings`（`last_directory_path`/`apply_exif_rotation`/`share_directory_path`/
    ///   `display_interval`/`sssignore_migrated` 等）も対象に含める。「設定を初期化」ボタンの
    ///   名の通り、ユーザー設定も含めて工場出荷状態に戻すのが仕様の意図（Issue #64）で、
    ///   ここだけ除外すると再起動後に「初期化したのに前の間隔設定が残る」ことになる。
    /// - 途中で失敗したら丸ごとロールバックされ、中途半端な空テーブルにはならない。
    /// - 対象テーブルは `USER_TABLES` にまとめてある（#79レビューshould3）。加えて
    ///   `scan_history.id`（`AUTOINCREMENT`）の採番カウンタが記録された内部テーブル
    ///   `sqlite_sequence` も明示的にクリアする。`sqlite_sequence` 自体は SQLite の
    ///   内部テーブル（`sqlite_` 接頭辞）のため `USER_TABLES` には含めないが、
    ///   クリアし忘れると初期化後も `scan_history.id` が古い最大値の続きから
    ///   採番されてしまう。
    pub fn reset_to_defaults(&self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for table in USER_TABLES {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.execute("DELETE FROM sqlite_sequence", [])?;
        insert_default_ignore_rules(&tx)?;
        tx.commit()?;
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

    /// v2: プレイリスト永続化用のテーブルを新設する（#62）。
    ///
    /// #62レビューM3(must): 当初案は `playlist_state` 1テーブルに列を追加するだけ
    /// だったが、v2はこのPR内でしか存在しない未リリースの中身のため、リリース後の
    /// 互換性を気にせず設計を作り直した。`shuffled_list`（10万件規模でJSONが
    /// 数MBになりうる）を含む1行を、advanceのたびの軽量更新（`next_index`/`history`だけ
    /// 変える）でも毎回書き直すことになり、SQLiteは行全体をコピーして書くため
    /// 実測で1回あたり数十ms・1日あたり数十GB相当の無駄なI/Oになっていた。
    /// 書込頻度が全く異なる2テーブルに分割する:
    /// - `playlist_list`（directory_path/shuffled_list、シャッフル確定時にしか書かない）
    /// - `playlist_position`（next_index/history/history_position、advance毎に書く）
    ///
    /// 旧 `playlist_state`（#61以前からある未使用テーブル。`current_index`/
    /// `shuffled_list`/`last_shuffled`/`is_paused`。実使用されたことは一度も無い）は
    /// もう不要なのでドロップする。新規DBは `CREATE TABLE` で既に最終形を持つため、
    /// 各ステップとも冪等（`DROP TABLE IF EXISTS`／`CREATE TABLE IF NOT EXISTS`）。
    fn migrate_to_v2(&self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;

        tx.execute("DROP TABLE IF EXISTS playlist_state", [])?;

        tx.execute(
            "CREATE TABLE IF NOT EXISTS playlist_list (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                directory_path TEXT,
                shuffled_list TEXT
            )",
            [],
        )?;
        tx.execute(
            "CREATE TABLE IF NOT EXISTS playlist_position (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                next_index INTEGER DEFAULT 0,
                history TEXT,
                history_position INTEGER DEFAULT 0
            )",
            [],
        )?;

        tx.execute("PRAGMA user_version = 2", [])?;
        tx.commit()?;
        Ok(())
    }

    /// プレイリストのシャッフル確定時（新規作成・巡の再シャッフル・`update_images`）に
    /// `shuffled_list` を含む全状態を1トランザクションで保存する（#62）。
    ///
    /// #62レビューM3: `playlist_list`（directory_path/shuffled_list）と
    /// `playlist_position`（next_index/history/history_position）の2テーブルに書く。
    /// 10万件規模だと `shuffled_list` の JSON は大きくなるため、advance のたびに
    /// これを書くと重い（`save_playlist_position` が軽量版で、`playlist_position` しか
    /// 触らない）。シャッフルが実際に変わった瞬間だけ呼ぶこと。
    pub fn save_playlist_full(
        &self,
        directory_path: &str,
        shuffled_list: &[String],
        next_index: usize,
        history: &[String],
        history_position: usize,
    ) -> Result<()> {
        let shuffled_list_json = serde_json::to_string(shuffled_list)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let history_json = serde_json::to_string(history)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO playlist_list (id, directory_path, shuffled_list)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                 directory_path = excluded.directory_path,
                 shuffled_list = excluded.shuffled_list",
            params![PLAYLIST_ROW_ID, directory_path, shuffled_list_json],
        )?;
        tx.execute(
            "INSERT INTO playlist_position (id, next_index, history, history_position)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 next_index = excluded.next_index,
                 history = excluded.history,
                 history_position = excluded.history_position",
            params![
                PLAYLIST_ROW_ID,
                next_index as i64,
                history_json,
                history_position as i64,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// advance/go_back のたびに呼ぶ軽量な永続化（#62）。`playlist_position` だけを
    /// 更新し、`playlist_list`（`shuffled_list`/`directory_path`）には一切触れない
    /// （#62レビューM3: 10万件規模で毎回 `shuffled_list` を含む行を書き直すと
    /// 実測で1回あたり数十ms・1日あたり数十GB相当の無駄なI/Oになっていたため、
    /// テーブル自体を分けて軽量なUPDATEだけで済むようにした）。
    /// `save_playlist_full` が一度も呼ばれておらず対象行が無い場合は何も起きない
    /// （0行更新、エラーにはならない）。
    pub fn save_playlist_position(
        &self,
        next_index: usize,
        history: &[String],
        history_position: usize,
    ) -> Result<()> {
        let history_json = serde_json::to_string(history)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        self.conn.execute(
            "UPDATE playlist_position SET next_index = ?1, history = ?2, history_position = ?3
             WHERE id = ?4",
            params![
                next_index as i64,
                history_json,
                history_position as i64,
                PLAYLIST_ROW_ID,
            ],
        )?;
        Ok(())
    }

    /// 保存済みのプレイリスト状態を読む（#62）。`playlist_list` に行が無い、または
    /// `directory_path` が無ければ復元対象なし（`None`）として扱う。
    /// 戻り値: (directory_path, shuffled_list, next_index, history, history_position)
    ///
    /// #62レビューS3: `shuffled_list`/`history` のJSONが壊れていても（ディスク破損・
    /// 途中クラッシュ等）エラーにはせず空リストへフォールバックする。特に `history` が
    /// 壊れていても `playlist_position` 行自体（`next_index`）は数値として健全なら
    /// そのまま使う。呼び出し元の `Playlist::from_persisted` は履歴が空でも
    /// `next_index` の続きから正しく再開できる。
    pub fn load_playlist_state(&self) -> Result<Option<PlaylistStateRow>> {
        let list_row: Option<(Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT directory_path, shuffled_list FROM playlist_list WHERE id = ?1",
                params![PLAYLIST_ROW_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let (directory_path, shuffled_list_json) = match list_row {
            Some((Some(directory_path), shuffled_list_json)) => {
                (directory_path, shuffled_list_json)
            }
            // directory_path が無い(=save_playlist_fullが一度も呼ばれていない)、または
            // playlist_list行自体が無い場合は復元対象なしとして扱う
            _ => return Ok(None),
        };
        let shuffled_list: Vec<String> = shuffled_list_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        // playlist_position は save_playlist_full と同じトランザクションで必ず
        // 一緒に作られるはずだが、念のため行が無い/壊れている場合もエラーにせず
        // デフォルト値（next_index=0, history=[]）にフォールバックする。
        let position_row: Option<(i64, Option<String>, i64)> = self
            .conn
            .query_row(
                "SELECT next_index, history, history_position FROM playlist_position
                 WHERE id = ?1",
                params![PLAYLIST_ROW_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (next_index, history_json, history_position) = position_row.unwrap_or((0, None, 0));
        let history: Vec<String> = history_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        Ok(Some((
            directory_path,
            shuffled_list,
            next_index.max(0) as usize,
            history,
            history_position.max(0) as usize,
        )))
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

    /// `perform_scan` Stage 3 の file_metadata 反映本体（#63）。新規/変更分の
    /// upsertと確定削除分の削除（`file_metadata`/`image_stats`/`exif_cache`）を
    /// **1トランザクション**・`prepare_cached`でまとめて行う。
    ///
    /// 以前は生スキャンで見つかった全ファイル（10万件規模なら10万件。大半は
    /// 「変更なし」）を1件ずつ`upsert_file_metadata`していたが、実際にDBへの反映が
    /// 必要なのは新規/変更分だけ（`scanner::ScanResult::new_files`/`modified_files`）
    /// で、無駄なI/O・ロック保持時間の伸長でしかなかった。upsert専用の
    /// `upsert_file_metadata_batch`と削除専用の`mark_deleted`を別々に（＝別
    /// トランザクションで）呼ぶ中間実装を経て、**PR#77レビューS5**で本番未使用に
    /// なった`upsert_file_metadata_batch`を削除しこの1本に統合した（呼び出し元は
    /// 常に新規/変更upsertと確定削除を同時に持っているため、分ける理由が無かった）。
    pub fn apply_file_metadata_changes(
        &self,
        upserts: &[(String, i64, i64)],
        deleted_paths: &[String],
    ) -> Result<()> {
        if upserts.is_empty() && deleted_paths.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        upsert_file_metadata_within(&tx, upserts)?;
        delete_file_metadata_within(&tx, deleted_paths)?;
        tx.commit()?;
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

    /// `directory` 配下（`directory` 自身とその子孫パス）の `file_metadata` だけを取得する
    /// （#63）。
    ///
    /// `perform_scan` の差分比較（前回スキャンとの突き合わせ）は、**今回スキャンする
    /// ディレクトリ配下のパスだけ**を対象にすること。以前は `get_all_file_metadata`
    /// （DB全件）を使っていたため、フォルダA→B→Aと切り替えて使うと、Bをスキャンした
    /// 時点でAの`file_metadata`が「今回の生スキャン（B配下）には存在しない」と判定され
    /// 確定削除されてしまう事故があった（`ignore::IgnoreFilter::has_pruned_ancestor_dir`
    /// も対象外のディレクトリに対しては`starts_with`が偽になり救えない）。
    ///
    /// **PR#77レビューM1(must)**: 当初は `LIKE ... ESCAPE '\'` で前方一致させていたが、
    /// エスケープ文字に `\` を使っているため、区切り文字がバックスラッシュのWindows
    /// （`sep == '\\'`）では `format!("{dir}{sep}%")` が生成するパターンの `\%` が
    /// 「エスケープされたリテラル`%`」と解釈されてしまい、ワイルドカードとして機能せず
    /// 常に0件しかマッチしなかった（Windowsで差分スキャンの範囲限定が事実上死んでいた）。
    /// `path` は主キー（`TEXT PRIMARY KEY`、既定のBINARY照合＝バイト単位比較・大文字小文字
    /// 区別）なので、`LIKE` ではなく **範囲クエリ** `path >= lower AND path < upper`
    /// （`lower = dir + sep`、`upper = dir + (sepの次のバイト)`）に置き換える。エスケープが
    /// 一切不要になるうえ、主キーのインデックスがそのまま効く。
    pub fn get_file_metadata_under(&self, directory: &str) -> Result<Vec<FileMetadataRow>> {
        let dir_trimmed = directory.trim_end_matches(['/', '\\']);
        let (lower, upper) = directory_scope_bounds(dir_trimmed, std::path::MAIN_SEPARATOR);

        let mut stmt = self.conn.prepare(
            "SELECT path, modified_time, file_size FROM file_metadata
             WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        )?;
        let rows = stmt.query_map(params![dir_trimmed, lower, upper], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;

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
        if paths.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        delete_file_metadata_within(&tx, paths)?;
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

    /// 画像の表示回数を1減らす（#65: `get_next_image`/`get_previous_image` は
    /// ファイル存在・キャッシュ変換の成功だけを確認して加算するが、フロント側の
    /// `<img>`/`<video>` の実際のデコード/描画がそれでも失敗する（壊れた
    /// ファイル内容等）ケースがある。そのケースでは既に加算済みのカウントを
    /// フロントの `onError` から取り消す「確定後の取り消しAPI」として使う。
    /// 行が無い/既に0の場合は何もしない（0未満にはならない）。
    pub fn decrement_display_count(&self, path: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE image_stats SET display_count = MAX(display_count - 1, 0) WHERE path = ?1",
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

    /// `path` がアプリの管理下（スキャン済みのプレイリスト構成員 `file_metadata`、
    /// または表示履歴 `image_stats`）に登録されているかを文字列の完全一致で判定する（#87）。
    /// `get_thumbnail`/`pick_image` が任意の絶対パスを受け付けないための照合に使う。
    pub fn is_known_media_path(&self, path: &str) -> Result<bool> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_metadata WHERE path = ?1)
                 OR EXISTS(SELECT 1 FROM image_stats WHERE path = ?1)",
            [path],
            |row| row.get(0),
        )
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

    /// `directory` 配下の全画像の表示回数を取得（グラフ用、パスでソート）。
    ///
    /// #63 PR#77レビューS2: プレイリストの母数と揃えるためディレクトリ配下に限定する
    /// （以前はDB全件を返しており、GraphSectionに他ディレクトリの画像まで混ざって
    /// 表示されうる状態だった）。`commands::stats::get_display_stats`はこの結果を
    /// さらにプレイリストのメンバーシップで絞り込む（PR#77レビュー2巡目 nit:
    /// ディレクトリ配下限定だけでは、表示後に除外ルールが付いたファイルの
    /// `display_count`がまだ数に残ってしまうため）。
    pub fn get_all_display_counts_under(&self, directory: &str) -> Result<Vec<(String, i32)>> {
        let dir_trimmed = directory.trim_end_matches(['/', '\\']);
        let (lower, upper) = directory_scope_bounds(dir_trimmed, std::path::MAIN_SEPARATOR);
        let mut stmt = self.conn.prepare(
            "SELECT path, display_count FROM image_stats
             WHERE path = ?1 OR (path >= ?2 AND path < ?3)
             ORDER BY path ASC",
        )?;

        let rows = stmt.query_map(params![dir_trimmed, lower, upper], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;

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

    /// レビュー指摘(PR#83 M1a): `get_file_metadata_under`/`get_all_display_counts_under`
    /// は `std::path::MAIN_SEPARATOR`（コンパイル時のホストOS依存）でスコープ境界を
    /// 計算するため、テストのパスを `/` 直書きにすると Windows 実行時は区切り文字が
    /// 一致せず常に0件になる。ここで `/` をホストOSの区切り文字に変換してから使う。
    /// Windows形式の区切り文字自体を明示的に検証する
    /// `directory_scope_bounds_computes_correct_range_for_windows_backslash_separator` は
    /// 意図的に対象外（そちらは常に `\` を直接渡す）。
    fn p(s: &str) -> String {
        s.replace('/', std::path::MAIN_SEPARATOR_STR)
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

    /// #62レビュー M3 マイグレーション: 旧スキーマ（`playlist_state` 1テーブルのみ、
    /// `directory_path`/`history`/`history_position` 列も無い #61以前の実際の形）を
    /// 持つDBを開いても、旧テーブルはドロップされ、新しい `playlist_list`/
    /// `playlist_position` の2テーブルに置き換わってエラーにならない。
    #[test]
    fn migrating_old_playlist_state_table_is_dropped_and_replaced_by_v2_tables() {
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

        // 旧テーブルはドロップされている
        let old_table_exists: i32 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='playlist_state'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            old_table_exists, 0,
            "旧playlist_stateテーブルはドロップされるはず"
        );

        // 旧テーブルの中身（current_index=5等）は引き継がず、復元対象なし扱いになる
        // （#61以前は一度も実使用されていない未使用テーブルだったため、移行不要）。
        assert!(db.load_playlist_state().unwrap().is_none());

        // 新しいテーブルに書き込めることを確認する(冪等マイグレーション後に書込可能)。
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

    /// #62 空・未設定(壊れたJSON): `playlist_list.shuffled_list` の中身がディスク破損や
    /// 途中クラッシュ等で壊れたJSON文字列になっていても、`load_playlist_state` は
    /// エラーにせず空リストへフォールバックする（`directory_path` は健全なままなら
    /// 復元対象ありとして返す）。
    #[test]
    fn load_playlist_state_with_corrupted_shuffled_list_json_falls_back_to_empty_list() {
        let path = temp_db_path("playlist_list_corrupted_json");
        let db = Database::new(path.clone()).unwrap();

        db.save_playlist_full(
            "/photos",
            &["a.jpg".to_string()],
            1,
            &["a.jpg".to_string()],
            0,
        )
        .unwrap();
        // 保存後にJSON列だけを直接壊れた文字列へ書き換える（部分書き込み破損を模す）。
        db.conn
            .execute(
                "UPDATE playlist_list SET shuffled_list = ?1 WHERE id = 1",
                params!["not-valid-json{{{"],
            )
            .unwrap();

        let (dir, list, idx, hist, _hist_pos) = db
            .load_playlist_state()
            .expect("壊れたJSONでもエラーにはならないはず")
            .expect("directory_pathは健全なので復元対象ありのはず");

        assert_eq!(dir, "/photos");
        assert_eq!(
            list,
            Vec::<String>::new(),
            "壊れたJSONのshuffled_listは空リストにフォールバックするはず"
        );
        // playlist_position側は無傷なので next_index/history はそのまま読める
        assert_eq!(idx, 1);
        assert_eq!(hist, vec!["a.jpg".to_string()]);

        let _ = std::fs::remove_file(&path);
    }

    /// #62レビュー S3: `playlist_position.history` のJSONだけが壊れていても、
    /// `shuffled_list`/`next_index` は健全なまま読める（`history` だけ失っても、
    /// `Playlist::from_persisted` が `next_index` の続きから再開できるようにするため。
    /// history が空のJSON配列 `[]` にフォールバックすることを別途 `Playlist` 側の
    /// テストで検証している）。
    #[test]
    fn load_playlist_state_with_corrupted_history_json_still_returns_valid_list_and_next_index() {
        let path = temp_db_path("playlist_position_corrupted_history");
        let db = Database::new(path.clone()).unwrap();

        let shuffled_list: Vec<String> = (0..5).map(|i| format!("img{i}.jpg")).collect();
        db.save_playlist_full("/photos", &shuffled_list, 3, &["img2.jpg".to_string()], 0)
            .unwrap();
        db.conn
            .execute(
                "UPDATE playlist_position SET history = ?1 WHERE id = 1",
                params!["also-not-valid[["],
            )
            .unwrap();

        let (dir, list, idx, hist, hist_pos) = db
            .load_playlist_state()
            .expect("historyのJSONが壊れていてもエラーにはならないはず")
            .expect("directory_path/shuffled_listは健全なので復元対象ありのはず");

        assert_eq!(dir, "/photos");
        assert_eq!(
            list, shuffled_list,
            "shuffled_listはhistoryの破損と無関係にそのまま読めるはず"
        );
        assert_eq!(
            idx, 3,
            "next_indexはhistoryの破損と無関係にそのまま読めるはず"
        );
        assert_eq!(
            hist,
            Vec::<String>::new(),
            "壊れたhistoryは空リストにフォールバックするはず"
        );
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

    /// #63: `get_file_metadata_under` は指定ディレクトリ配下のパスだけを返し、他の
    /// ディレクトリ（フォルダA→B→Aの「B」相当）を巻き込まない。差分比較をスキャン対象
    /// ディレクトリ配下に限定する変更の直接的な回帰テスト。
    #[test]
    fn get_file_metadata_under_scopes_to_directory_and_preserves_other_directories() {
        let path = temp_db_path("file_metadata_under_scope");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata(&p("/p/foo/a.jpg"), 100, 10)
            .unwrap();
        db.upsert_file_metadata(&p("/p/foo/sub/b.jpg"), 200, 20)
            .unwrap();
        db.upsert_file_metadata(&p("/p/bar/c.jpg"), 300, 30)
            .unwrap();

        let under_foo = db.get_file_metadata_under(&p("/p/foo")).unwrap();
        let paths: Vec<&str> = under_foo.iter().map(|(p, ..)| p.as_str()).collect();

        assert_eq!(under_foo.len(), 2, "/p/foo配下の2件だけが返るはず");
        assert!(paths.contains(&p("/p/foo/a.jpg").as_str()));
        assert!(paths.contains(&p("/p/foo/sub/b.jpg").as_str()));
        assert!(
            !paths.contains(&p("/p/bar/c.jpg").as_str()),
            "別ディレクトリ(/p/bar)のファイルを巻き込んではいけない"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #63 境界テスト: `/p/foo` を指定したとき、`/p/foo/bar.jpg`（配下）はヒットするが
    /// `/p/foobar/x.jpg`（名前が前方一致するだけの別ディレクトリ）はヒットしない。
    /// 区切り文字境界で前方一致を取ることの直接的な検証。
    #[test]
    fn get_file_metadata_under_respects_path_separator_boundary() {
        let path = temp_db_path("file_metadata_under_boundary");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata(&p("/p/foo/bar.jpg"), 100, 10)
            .unwrap();
        db.upsert_file_metadata(&p("/p/foobar/x.jpg"), 200, 20)
            .unwrap();

        let under_foo = db.get_file_metadata_under(&p("/p/foo")).unwrap();
        let paths: Vec<&str> = under_foo.iter().map(|(p, ..)| p.as_str()).collect();

        assert_eq!(paths, vec![p("/p/foo/bar.jpg").as_str()]);
        assert!(
            !paths.contains(&p("/p/foobar/x.jpg").as_str()),
            "/p/foo と /p/foobar は別ディレクトリとして区別されるはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #63 PR#77レビューM1: `LIKE`のワイルドカード文字と紛らわしい `%`/`_` を含む
    /// ディレクトリパスでも、範囲クエリ（バイト単位比較）は常にリテラルとして扱うため
    /// 誤爆しないこと（LIKEを使っていた頃のエスケープ回帰テストを、実装変更後も
    /// 同じ入力で引き続き通ることを確認する形で残す）。
    #[test]
    fn get_file_metadata_under_treats_percent_and_underscore_as_literal_bytes() {
        let path = temp_db_path("file_metadata_under_escape");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata(&p("/p/100%_done/a.jpg"), 100, 10)
            .unwrap();
        // "%"/"_" が本物のワイルドカードとして働くと、無関係な "/p/100X_done" もヒットする。
        db.upsert_file_metadata(&p("/p/100X_done/a.jpg"), 200, 20)
            .unwrap();

        let under = db.get_file_metadata_under(&p("/p/100%_done")).unwrap();
        let paths: Vec<&str> = under.iter().map(|(p, ..)| p.as_str()).collect();

        assert_eq!(paths, vec![p("/p/100%_done/a.jpg").as_str()]);

        let _ = std::fs::remove_file(&path);
    }

    /// #63 PR#77レビューM1(must) 直接の回帰テスト: `directory_scope_bounds`を
    /// `sep = '\\'`（Windows形式）で明示的に呼び、コンパイル時のホストOSに関わらず
    /// Windowsの区切り文字での境界計算を検証する。修正前は`LIKE ... ESCAPE '\'`の
    /// パターンが`format!("{dir}{sep}%")`＝`"C:\Photos\%"`となり、エスケープ文字と
    /// 区切り文字が一致するWindows環境では`\%`がリテラル`%`と解釈され常に0件だった。
    #[test]
    fn directory_scope_bounds_computes_correct_range_for_windows_backslash_separator() {
        let (lower, upper) = directory_scope_bounds(r"C:\Photos", '\\');
        assert_eq!(lower, "C:\\Photos\\", "下限はディレクトリ+区切り文字のはず");
        assert_eq!(
            upper, "C:\\Photos]",
            "上限は区切り文字(0x5C)の次のバイト(0x5D=']')のはず"
        );

        // 実際にWindows形式のパスをこの境界で絞り込めることも確認する（DBの照合は
        // BINARY＝バイト単位比較なので、区切り文字がバックスラッシュでも問題なく動く）。
        let path = temp_db_path("windows_style_bounds");
        let db = Database::new(path.clone()).unwrap();
        db.upsert_file_metadata(r"C:\Photos\a.jpg", 100, 10)
            .unwrap();
        db.upsert_file_metadata(r"C:\Photos\sub\b.jpg", 200, 20)
            .unwrap();
        // "C:\Photos" に前方一致するだけの別ディレクトリ（境界外）を巻き込まない。
        db.upsert_file_metadata(r"C:\PhotosArchive\c.jpg", 300, 30)
            .unwrap();

        let under: Vec<String> = db
            .conn
            .prepare("SELECT path FROM file_metadata WHERE path = ?1 OR (path >= ?2 AND path < ?3)")
            .unwrap()
            .query_map(params![r"C:\Photos", lower, upper], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(
            under.len(),
            2,
            "C:\\Photos配下(サブフォルダ含む)の2件だけがヒットするはず: {under:?}"
        );
        assert!(under.iter().any(|p| p == r"C:\Photos\a.jpg"));
        assert!(under.iter().any(|p| p == r"C:\Photos\sub\b.jpg"));
        assert!(
            !under.iter().any(|p| p.starts_with(r"C:\PhotosArchive")),
            "前方一致するだけの別ディレクトリを巻き込んではいけない"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #63 PR#77レビューS1: 範囲クエリはBINARY照合（バイト単位比較）なので、
    /// `/p/foo` を指定したとき大文字違いの `/p/Foo` を巻き込まない
    /// （LIKE除去に伴う範囲クエリ化で、大文字小文字の区別が壊れていないことの確認）。
    #[test]
    fn get_file_metadata_under_does_not_conflate_different_case_directories() {
        let path = temp_db_path("case_sensitive_scope");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata(&p("/p/foo/a.jpg"), 100, 10)
            .unwrap();
        db.upsert_file_metadata(&p("/p/Foo/b.jpg"), 200, 20)
            .unwrap();

        let under_foo = db.get_file_metadata_under(&p("/p/foo")).unwrap();
        let paths: Vec<&str> = under_foo.iter().map(|(p, ..)| p.as_str()).collect();

        assert_eq!(paths, vec![p("/p/foo/a.jpg").as_str()]);
        assert!(
            !paths.contains(&p("/p/Foo/b.jpg").as_str()),
            "/p/foo と /p/Foo は大文字小文字が違う別ディレクトリとして区別されるはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #63（PR#77レビューS5で`upsert_file_metadata_batch`から`apply_file_metadata_changes`
    /// に移行）: upsertをまとめて1トランザクションで反映し、`added_at` を保つ既存の
    /// `upsert_file_metadata` と同じ `ON CONFLICT` 挙動になる。空配列2つはエラーに
    /// ならず何もしない。
    #[test]
    fn apply_file_metadata_changes_batch_inserts_and_updates_in_one_transaction() {
        let path = temp_db_path("upsert_batch");
        let db = Database::new(path.clone()).unwrap();

        db.apply_file_metadata_changes(&[], &[]).unwrap();

        db.upsert_file_metadata("/p/a.jpg", 100, 10).unwrap();
        db.apply_file_metadata_changes(
            &[
                ("/p/a.jpg".to_string(), 999, 999), // 既存: 更新される
                ("/p/b.jpg".to_string(), 200, 20),  // 新規
            ],
            &[],
        )
        .unwrap();

        let all = db.get_all_file_metadata().unwrap();
        let a = all.iter().find(|(p, ..)| p == "/p/a.jpg").unwrap();
        let b = all.iter().find(|(p, ..)| p == "/p/b.jpg").unwrap();
        assert_eq!((a.1, a.2), (999, 999), "既存パスは新しい値に更新されるはず");
        assert_eq!((b.1, b.2), (200, 20), "新規パスは挿入されるはず");

        let _ = std::fs::remove_file(&path);
    }

    /// #63: `apply_file_metadata_changes` は新規/変更のupsertと確定削除の削除を
    /// 1回の呼び出し（1トランザクション）で反映し、削除側は `mark_deleted` と同じく
    /// `image_stats`/`exif_cache` も含めて消す。空配列2つはエラーにならず何もしない。
    #[test]
    fn apply_file_metadata_changes_upserts_and_deletes_together() {
        let path = temp_db_path("apply_changes");
        let db = Database::new(path.clone()).unwrap();

        db.apply_file_metadata_changes(&[], &[]).unwrap();

        // 既存の状態を作る: a(残る・更新なし), b(削除される), の2件。
        db.upsert_file_metadata("/p/a.jpg", 100, 10).unwrap();
        db.upsert_file_metadata("/p/b.jpg", 200, 20).unwrap();
        db.increment_display_count("/p/b.jpg").unwrap();
        db.upsert_exif_cache("/p/b.jpg", Some("2023-05-15"), 200)
            .unwrap();

        // c は新規、b は確定削除。a には触れない。
        db.apply_file_metadata_changes(
            &[("/p/c.jpg".to_string(), 300, 30)],
            &["/p/b.jpg".to_string()],
        )
        .unwrap();

        let all = db.get_all_file_metadata().unwrap();
        let paths: Vec<&str> = all.iter().map(|(p, ..)| p.as_str()).collect();
        assert!(paths.contains(&"/p/a.jpg"), "触れていないaは残るはず");
        assert!(paths.contains(&"/p/c.jpg"), "新規cは追加されるはず");
        assert!(
            !paths.contains(&"/p/b.jpg"),
            "確定削除したbはfile_metadataから消えるはず"
        );

        let (b_count, _) = db.get_image_stats("/p/b.jpg").unwrap();
        assert_eq!(
            b_count, 0,
            "確定削除したbのimage_statsも消える(get_image_statsは未登録扱いの0を返す)はず"
        );
        assert!(
            db.get_all_exif_cache()
                .unwrap()
                .iter()
                .all(|(p, ..)| p != "/p/b.jpg"),
            "確定削除したbのexif_cacheも消えるはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #63 テスト観点補完（トランザクション途中失敗時のロールバック）: `apply_file_metadata_changes`
    /// は upsert → delete の順で1トランザクションにまとめて実行する。途中の1件
    /// （後続のdelete）が失敗したら、それより**前に同一トランザクション内で成功していた
    /// 変更（先行するupsert・先行するdelete）も含めて全てロールバックされ、部分反映
    /// されないことを検証する。SQLiteのトリガーで特定パスのDELETEを意図的に失敗させ、
    /// 途中失敗を再現する（本番コードは変更しない）。
    #[test]
    fn apply_file_metadata_changes_rolls_back_entirely_on_mid_transaction_failure() {
        let path = temp_db_path("apply_changes_rollback");
        let db = Database::new(path.clone()).unwrap();

        // 既存の状態: keep(ロールバックで生き残るべき), poison(削除が失敗する対象)。
        db.upsert_file_metadata("/p/keep.jpg", 100, 10).unwrap();
        db.upsert_file_metadata("/p/poison.jpg", 200, 20).unwrap();

        // poison.jpg のDELETEだけを意図的に失敗させるトリガーを仕込む。
        db.conn
            .execute_batch(
                "CREATE TRIGGER fail_on_poison_delete
                 BEFORE DELETE ON file_metadata
                 WHEN OLD.path = '/p/poison.jpg'
                 BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;",
            )
            .unwrap();

        // upsert(new.jpg)は先に処理され、delete(keep.jpg)もpoison.jpgより先に処理される
        // 実装順（upsert全件→delete全件、deleteは引数順）なので、両方が「失敗より前に
        // 同一トランザクション内で成功済み」の状態を作れる。
        let result = db.apply_file_metadata_changes(
            &[("/p/new.jpg".to_string(), 300, 30)],
            &["/p/keep.jpg".to_string(), "/p/poison.jpg".to_string()],
        );

        assert!(
            result.is_err(),
            "トリガーによる途中失敗はErrとして伝播するはず"
        );

        let all = db.get_all_file_metadata().unwrap();
        let paths: Vec<&str> = all.iter().map(|(p, ..)| p.as_str()).collect();
        assert!(
            paths.contains(&"/p/keep.jpg"),
            "ロールバックによりkeepの削除も取り消され残るはず: {paths:?}"
        );
        assert!(
            paths.contains(&"/p/poison.jpg"),
            "失敗した削除対象自身もロールバックで残るはず: {paths:?}"
        );
        assert!(
            !paths.contains(&"/p/new.jpg"),
            "ロールバックにより先行するupsertも反映されないはず（部分反映禁止）: {paths:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `increment_display_count` は初回で1、以降は加算し、`last_displayed` を埋める。
    /// `get_image_stats` は未登録パスに対して `(0, None)` を返す（エラーにしない）。
    #[test]
    fn increment_display_count_accumulates_and_sets_last_displayed() {
        let path = temp_db_path("increment_display_count");
        let db = Database::new(path.clone()).unwrap();

        let (count, last) = db.get_image_stats("/p/never_shown.jpg").unwrap();
        assert_eq!((count, last), (0, None), "未登録パスは(0, None)のはず");

        db.increment_display_count("/p/a.jpg").unwrap();
        let (count, last) = db.get_image_stats("/p/a.jpg").unwrap();
        assert_eq!(count, 1, "初回は1のはず");
        assert!(last.is_some(), "last_displayedが埋まるはず");

        db.increment_display_count("/p/a.jpg").unwrap();
        let (count, _) = db.get_image_stats("/p/a.jpg").unwrap();
        assert_eq!(count, 2, "2回目は加算されるはず");

        let _ = std::fs::remove_file(&path);
    }

    /// `decrement_display_count`（#65: `undo_display_count` コマンドの実体）は
    /// 表示回数を1減らし、`last_displayed` 等の行自体は変更しない。
    #[test]
    fn decrement_display_count_subtracts_one_and_keeps_last_displayed() {
        let path = temp_db_path("decrement_display_count_basic");
        let db = Database::new(path.clone()).unwrap();

        db.increment_display_count("/p/a.jpg").unwrap();
        db.increment_display_count("/p/a.jpg").unwrap();
        let (count, last_after_increments) = db.get_image_stats("/p/a.jpg").unwrap();
        assert_eq!(count, 2, "前提: 2回加算しておく");

        db.decrement_display_count("/p/a.jpg").unwrap();
        let (count, last) = db.get_image_stats("/p/a.jpg").unwrap();
        assert_eq!(count, 1, "1回取り消すと2→1になるはず");
        assert_eq!(
            last, last_after_increments,
            "decrementはlast_displayedを変更しないはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `decrement_display_count` は0未満にならない（境界: display_count=0 で
    /// 呼んでも0のまま）。フロントの`onError`が二重発火しても壊れないための保証。
    #[test]
    fn decrement_display_count_does_not_go_below_zero() {
        let path = temp_db_path("decrement_display_count_floor");
        let db = Database::new(path.clone()).unwrap();

        db.increment_display_count("/p/a.jpg").unwrap();
        db.decrement_display_count("/p/a.jpg").unwrap();
        let (count, _) = db.get_image_stats("/p/a.jpg").unwrap();
        assert_eq!(count, 0, "1→0になるはず");

        // 既に0の状態でもう一度取り消す（境界: 0未満にならない）。
        db.decrement_display_count("/p/a.jpg").unwrap();
        let (count, _) = db.get_image_stats("/p/a.jpg").unwrap();
        assert_eq!(count, 0, "0からさらに取り消しても0未満にならないはず");

        let _ = std::fs::remove_file(&path);
    }

    /// `decrement_display_count` は `image_stats` に行が存在しないパスに対しては
    /// 何もしない（UPDATEの対象行が0件でもErrにならない。行を新規作成もしない）。
    #[test]
    fn decrement_display_count_on_unknown_path_is_a_noop_not_an_error() {
        let path = temp_db_path("decrement_display_count_unknown");
        let db = Database::new(path.clone()).unwrap();

        let result = db.decrement_display_count("/p/never_seen.jpg");
        assert!(result.is_ok(), "未登録パスへの取り消しはErrにならないはず");

        let (count, last) = db.get_image_stats("/p/never_seen.jpg").unwrap();
        assert_eq!(
            (count, last),
            (0, None),
            "行が新規作成されず(0, None)のままのはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `reset_all_display_counts` は表示回数を全件0に戻すが、行自体（last_displayed等）
    /// は削除しない。
    #[test]
    fn reset_all_display_counts_zeroes_counts_without_deleting_rows() {
        let path = temp_db_path("reset_display_counts");
        let db = Database::new(path.clone()).unwrap();

        db.increment_display_count("/p/a.jpg").unwrap();
        db.increment_display_count("/p/a.jpg").unwrap();
        db.increment_display_count("/p/b.jpg").unwrap();

        db.reset_all_display_counts().unwrap();

        let (a_count, a_last) = db.get_image_stats("/p/a.jpg").unwrap();
        let (b_count, _) = db.get_image_stats("/p/b.jpg").unwrap();
        assert_eq!(a_count, 0);
        assert_eq!(b_count, 0);
        assert!(
            a_last.is_some(),
            "行自体は残るので last_displayed はリセットされないはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `get_total_image_count`（file_metadata件数）と、`get_all_display_counts_under`
    /// （指定ディレクトリ配下のimage_stats全件）から`display_count>0`だけを数えた件数は
    /// 独立に数える。#63 PR#77レビューS2でディレクトリ限定に変更したので、スコープ外
    /// (`/other`)の表示済み画像が数に混ざらないことも合わせて確認する
    /// （`commands::stats::get_display_stats`は、この結果をさらにプレイリストの
    /// メンバーシップで絞り込む。そちらは`tests/display_stats_membership.rs`で検証する）。
    #[test]
    fn total_and_displayed_image_counts_are_independent() {
        let path = temp_db_path("image_counts");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata(&p("/p/a.jpg"), 100, 10).unwrap();
        db.upsert_file_metadata(&p("/p/b.jpg"), 200, 20).unwrap();
        db.upsert_file_metadata(&p("/p/c.jpg"), 300, 30).unwrap();
        db.increment_display_count(&p("/p/a.jpg")).unwrap();
        db.increment_display_count(&p("/other/z.jpg")).unwrap();

        assert_eq!(
            db.get_total_image_count().unwrap(),
            3,
            "file_metadataの全件数"
        );
        let displayed_under_p = db
            .get_all_display_counts_under(&p("/p"))
            .unwrap()
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .count();
        assert_eq!(
            displayed_under_p, 1,
            "/p配下でdisplay_count>0のimage_statsだけ数えるはず(/otherは含まない)"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `save_setting`/`get_setting`: 未設定キーは `None`、保存後は値が返り、
    /// 同じキーへの再保存は上書きする（`INSERT OR REPLACE`）。
    #[test]
    fn save_and_get_setting_roundtrip_and_overwrite() {
        let path = temp_db_path("setting_roundtrip");
        let db = Database::new(path.clone()).unwrap();

        assert_eq!(db.get_setting("theme").unwrap(), None);

        db.save_setting("theme", "dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap(), Some("dark".to_string()));

        db.save_setting("theme", "light").unwrap();
        assert_eq!(
            db.get_setting("theme").unwrap(),
            Some("light".to_string()),
            "同じキーへの再保存は上書きするはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `add_ignore_rule`/`get_ignore_rules`: 追加した順（`added_at ASC`）で返り、
    /// `INSERT OR IGNORE` により同じ `(pattern, rule_type)` の重複追加は無視される。
    #[test]
    fn add_ignore_rule_and_get_ignore_rules_roundtrip_dedupes_exact_duplicates() {
        let path = temp_db_path("add_ignore_rule_roundtrip");
        let db = Database::new(path.clone()).unwrap();
        // デフォルトルール(6件)をクリアしてから検証する。
        for (pattern, rule_type) in db.get_ignore_rules().unwrap() {
            db.remove_ignore_rule(&pattern, rule_type).unwrap();
        }

        db.add_ignore_rule("*.tmp", RuleType::Glob).unwrap();
        db.add_ignore_rule("*.tmp", RuleType::Glob).unwrap(); // 重複追加は無視される
        db.add_ignore_rule("2023-05-15", RuleType::Date).unwrap();

        let rules = db.get_ignore_rules().unwrap();
        assert_eq!(
            rules,
            vec![
                ("*.tmp".to_string(), RuleType::Glob),
                ("2023-05-15".to_string(), RuleType::Date),
            ],
            "追加順(added_at ASC)で返り、重複は1件にまとまるはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `get_recent_images` は `last_displayed` が非NULLの行だけを降順・limit件で返す。
    #[test]
    fn get_recent_images_orders_by_last_displayed_desc_and_respects_limit() {
        let path = temp_db_path("recent_images");
        let db = Database::new(path.clone()).unwrap();

        // last_displayedがまだ無い行はrecent_imagesに出ない。
        db.upsert_file_metadata("/p/never_shown.jpg", 100, 10)
            .unwrap();

        db.increment_display_count("/p/old.jpg").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100)); // datetime('now')は秒精度
        db.increment_display_count("/p/new.jpg").unwrap();

        let recent = db.get_recent_images(1).unwrap();
        assert_eq!(recent.len(), 1, "limit=1なら1件だけ");
        assert_eq!(recent[0].0, "/p/new.jpg", "最新表示が先頭に来るはず");

        let recent_all = db.get_recent_images(10).unwrap();
        assert!(
            recent_all.iter().all(|(p, ..)| p != "/p/never_shown.jpg"),
            "表示したことのないファイルは含まれないはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `get_distinct_scan_directories` は `scan_history` に記録済みのディレクトリを
    /// 重複無しで返す。
    #[test]
    fn get_distinct_scan_directories_dedupes_repeated_scans_of_same_directory() {
        let path = temp_db_path("distinct_scan_dirs");
        let db = Database::new(path.clone()).unwrap();

        db.record_scan_history("/photos/a", 10, 1, 0, 5).unwrap();
        db.record_scan_history("/photos/a", 10, 0, 0, 3).unwrap(); // 同じディレクトリを再スキャン
        db.record_scan_history("/photos/b", 5, 5, 0, 2).unwrap();

        let mut dirs = db.get_distinct_scan_directories().unwrap();
        dirs.sort();
        assert_eq!(dirs, vec!["/photos/a".to_string(), "/photos/b".to_string()]);

        let _ = std::fs::remove_file(&path);
    }

    /// `trim_scan_history` は指定件数を超える古いレコードを削除し、件数を上限以下に保つ。
    #[test]
    fn trim_scan_history_caps_row_count_at_max_entries() {
        let path = temp_db_path("trim_scan_history");
        let db = Database::new(path.clone()).unwrap();

        for i in 0..10 {
            db.record_scan_history(&format!("/photos/{i}"), 1, 1, 0, 1)
                .unwrap();
        }

        db.trim_scan_history(3).unwrap();

        let count: i32 = db
            .conn
            .query_row("SELECT COUNT(*) FROM scan_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3, "上限3件まで削減されるはず");

        let _ = std::fs::remove_file(&path);
    }

    /// `get_all_display_counts_under` は指定ディレクトリ配下だけをパス昇順で返す
    /// （display_count=0の行も含む）。#63 PR#77レビューS2: スコープ外(`/other`)は
    /// 混ざらないことも確認する。
    #[test]
    fn get_all_display_counts_under_returns_scoped_rows_sorted_by_path() {
        let path = temp_db_path("all_display_counts");
        let db = Database::new(path.clone()).unwrap();

        db.increment_display_count(&p("/p/b.jpg")).unwrap();
        db.increment_display_count(&p("/p/a.jpg")).unwrap();
        db.increment_display_count(&p("/p/a.jpg")).unwrap();
        db.increment_display_count(&p("/other/z.jpg")).unwrap();

        let counts = db.get_all_display_counts_under(&p("/p")).unwrap();
        assert_eq!(
            counts,
            vec![(p("/p/a.jpg"), 2), (p("/p/b.jpg"), 1)],
            "パス昇順で全件返るはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// `upsert_exif_cache`（単発）は `ON CONFLICT` で既存行を更新する
    /// （`upsert_exif_cache_batch` と同じSQLだが、単発呼び出し経路もカバーする）。
    #[test]
    fn upsert_exif_cache_single_inserts_then_updates() {
        let path = temp_db_path("upsert_exif_cache_single");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_exif_cache("/p/a.jpg", Some("2023-05-15"), 100)
            .unwrap();
        db.upsert_exif_cache("/p/a.jpg", None, 200).unwrap();

        let all = db.get_all_exif_cache().unwrap();
        assert_eq!(all.len(), 1, "同じpathへの2回目呼び出しは更新のはず");
        assert_eq!(all[0], ("/p/a.jpg".to_string(), None, 200));

        let _ = std::fs::remove_file(&path);
    }

    /// 全テーブルのカウントを一括取得するテスト専用ヘルパー
    /// （path/file_metadata/image_stats/playlist_list/playlist_position/ignore_rules/
    /// exif_cache/scan_history/app_settings の順）。
    fn table_counts(db: &Database) -> [i32; 8] {
        let count = |table: &str| -> i32 {
            db.conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        [
            count("file_metadata"),
            count("image_stats"),
            count("playlist_list"),
            count("playlist_position"),
            count("ignore_rules"),
            count("exif_cache"),
            count("scan_history"),
            count("app_settings"),
        ]
    }

    /// #64 メインシナリオ: 全ユーザーデータテーブルに1件以上データを入れた状態から
    /// `reset_to_defaults` を呼ぶと、DBファイル・接続はそのままに全テーブルが空になり、
    /// `ignore_rules` だけは既定の6ルールで再投入されること。
    #[test]
    fn reset_to_defaults_clears_all_user_data_tables_and_reseeds_default_ignore_rules() {
        let path = temp_db_path("reset_clears_all");
        let db = Database::new(path.clone()).unwrap();

        // 各テーブルに最低1件ずつデータを入れる
        db.upsert_file_metadata("/p/a.jpg", 100, 1000).unwrap();
        db.increment_display_count("/p/a.jpg").unwrap();
        db.save_playlist_full("/p", &["/p/a.jpg".to_string()], 1, &[], 0)
            .unwrap();
        db.add_ignore_rule("/p/custom.jpg", RuleType::Glob).unwrap();
        db.upsert_exif_cache("/p/a.jpg", Some("2023-05-15"), 100)
            .unwrap();
        db.record_scan_history("/p", 1, 1, 0, 5).unwrap();
        db.save_setting("last_directory_path", "/p").unwrap();

        // 既定除外ルール分も含め、ignore_rulesは 6(既定) + 1(追加) = 7件のはず
        assert_eq!(db.get_ignore_rules().unwrap().len(), 7);

        let version_before: i32 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();

        db.reset_to_defaults()
            .expect("開いたままの接続でリセットできるはず");

        let counts = table_counts(&db);
        assert_eq!(counts[0], 0, "file_metadataは空のはず");
        assert_eq!(counts[1], 0, "image_statsは空のはず");
        assert_eq!(counts[2], 0, "playlist_listは空のはず");
        assert_eq!(counts[3], 0, "playlist_positionは空のはず");
        assert_eq!(counts[4], 6, "ignore_rulesは既定の6件だけに戻るはず");
        assert_eq!(counts[5], 0, "exif_cacheは空のはず");
        assert_eq!(counts[6], 0, "scan_historyは空のはず");
        assert_eq!(
            counts[7], 0,
            "app_settingsも空のはず（last_directory_path等の設定も初期化対象）"
        );

        let rules = db.get_ignore_rules().unwrap();
        assert!(
            rules.iter().all(|(_, t)| *t == RuleType::Glob),
            "再投入されるのは既定のglobルールのみのはず"
        );
        assert!(
            !rules.iter().any(|(p, _)| p == "/p/custom.jpg"),
            "ユーザーが追加したルールは残らないはず"
        );

        let version_after: i32 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            version_before, version_after,
            "PRAGMA user_versionはリセットで変化しないはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #64: リセット後もスキーマは健全なままで、再スキャン相当の書き込み
    /// （file_metadata upsert・表示回数インクリメント）が問題なく行えること。
    #[test]
    fn reset_to_defaults_leaves_db_usable_for_subsequent_scan() {
        let path = temp_db_path("reset_then_reuse");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata("/old/a.jpg", 1, 1).unwrap();
        db.reset_to_defaults().unwrap();

        // リセット直後に新しいディレクトリを再スキャンしたのと同等の操作が通ること
        db.upsert_file_metadata("/new/b.jpg", 200, 2000).unwrap();
        db.increment_display_count("/new/b.jpg").unwrap();
        db.save_setting("last_directory_path", "/new").unwrap();

        assert_eq!(db.get_total_image_count().unwrap(), 1);
        assert_eq!(
            db.get_setting("last_directory_path").unwrap(),
            Some("/new".to_string())
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #64: 空DB（初回起動直後、既定ルールが既に入っているだけの状態）に対して
    /// `reset_to_defaults` を呼んでもエラーにならず、既定ルールは6件のまま
    /// （重複挿入や欠落が起きない）こと。
    #[test]
    fn reset_to_defaults_on_fresh_db_is_a_no_op_besides_reseeding_defaults() {
        let path = temp_db_path("reset_fresh_db");
        let db = Database::new(path.clone()).unwrap();

        assert_eq!(db.get_ignore_rules().unwrap().len(), 6);

        db.reset_to_defaults().unwrap();

        assert_eq!(db.get_ignore_rules().unwrap().len(), 6);
        assert_eq!(table_counts(&db)[4], 6);

        let _ = std::fs::remove_file(&path);
    }

    /// #64 冪等性の直接確認: `reset_to_defaults` を連続2回呼んでも、2回目もエラーに
    /// ならず結果（既定6件のみ）が変わらないこと。1回目の呼び出しだけでは
    /// 「たまたま初回が正しかった」ことしか示せないため、同じ状態に対する
    /// 2回目の呼び出しが同じ結果を返すことまで確認する。
    #[test]
    fn reset_to_defaults_is_idempotent_when_called_twice_in_a_row() {
        let path = temp_db_path("reset_idempotent_twice");
        let db = Database::new(path.clone()).unwrap();

        db.reset_to_defaults().expect("1回目は成功するはず");
        assert_eq!(db.get_ignore_rules().unwrap().len(), 6);

        db.reset_to_defaults()
            .expect("2回目も成功するはず（INSERT OR IGNOREで重複挿入エラーにならない）");
        assert_eq!(
            db.get_ignore_rules().unwrap().len(),
            6,
            "2回連続で呼んでも既定6件のまま増減しないはず"
        );
        assert_eq!(table_counts(&db)[4], 6);

        let _ = std::fs::remove_file(&path);
    }

    /// #64 失敗系: トランザクション途中のDELETEが失敗したら、それより前に同じ
    /// トランザクション内で実行済みのDELETE（file_metadata/ignore_rules等）も
    /// まとめてロールバックされ、部分的に空になったテーブルが残らないこと。
    /// `reset_to_defaults` が最後にDELETEする`app_settings`を事前に破壊して
    /// 意図的に失敗させ、それより先に実行される他テーブルのDELETEが
    /// 有効化されていないことを確認する。
    #[test]
    fn reset_to_defaults_rolls_back_completely_when_a_later_delete_fails() {
        let path = temp_db_path("reset_rollback");
        let db = Database::new(path.clone()).unwrap();

        db.upsert_file_metadata("/p/a.jpg", 100, 1000).unwrap();
        db.add_ignore_rule("/p/custom.jpg", RuleType::Glob).unwrap();
        assert_eq!(
            db.get_ignore_rules().unwrap().len(),
            7,
            "既定6件+追加1件のはず"
        );

        // reset_to_defaults内で最後にDELETEされるapp_settingsを壊し、
        // トランザクションの途中で確実に失敗させる。
        db.conn.execute("DROP TABLE app_settings", []).unwrap();

        let result = db.reset_to_defaults();
        assert!(
            result.is_err(),
            "app_settingsが無くなっていればエラーになるはず"
        );

        // ロールバックにより、app_settings以外の（先に実行された）DELETEも
        // 巻き戻っているはず
        assert_eq!(
            db.get_total_image_count().unwrap(),
            1,
            "ロールバックによりfile_metadataの削除も取り消され、元のデータが残るはず"
        );
        assert_eq!(
            db.get_ignore_rules().unwrap().len(),
            7,
            "ロールバックによりignore_rulesの削除・既定再投入も取り消され、元の7件のままのはず"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// #79レビューshould3: `USER_TABLES`（`reset_to_defaults`がDELETEする対象）が、
    /// 実際のスキーマ（`sqlite_master`の`type='table'`一覧から、SQLite内部テーブル
    /// `sqlite_%`接頭辞を除いたもの）と過不足なく一致すること。新しいテーブルを
    /// 追加したのに`USER_TABLES`への追記を忘れると、そのテーブルだけ
    /// `reset_to_defaults`で空にならず初期化が中途半端になる事故を機械的に検知する。
    #[test]
    fn reset_to_defaults_user_tables_matches_all_tables_in_sqlite_master() {
        let path = temp_db_path("user_tables_matches_schema");
        let db = Database::new(path.clone()).unwrap();

        let mut actual_tables: Vec<String> = db
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        actual_tables.retain(|name| !name.starts_with("sqlite_"));
        actual_tables.sort();

        let mut expected_tables: Vec<String> = USER_TABLES.iter().map(|s| s.to_string()).collect();
        expected_tables.sort();

        assert_eq!(
            actual_tables, expected_tables,
            "USER_TABLESとsqlite_masterの実テーブル一覧（sqlite_%接頭辞を除く）は\
             過不足なく一致するはず"
        );

        let _ = std::fs::remove_file(&path);
    }
}
