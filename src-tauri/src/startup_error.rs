//! 起動時の致命的失敗（アプリデータディレクトリ・DB を開けない）の分類と復旧（#144）。
//!
//! 判断ロジック（エラー分類 → 取るべき行動）は UI に依存しない純粋関数にし、
//! ダイアログ表示は `startup_ui.rs`（非ブロッキング・コールバック式）に分離し、ここは
//! 「失敗 → 計画（`StartupPlan`）」「ユーザーの選択 → 後続（`Followup`）」の純粋な判断だけを持つ。
//! DB 破損時の「退避」は元ファイルのリネームのみで、削除は決してしない。

use crate::database::Database;
use std::io;
use std::path::{Path, PathBuf};

/// 起動失敗の原因区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupFailure {
    /// DB ファイルが壊れている（SQLite ファイルではない・内部破損）。
    Corrupt,
    /// 他プロセスが DB を掴んでいる。
    Locked,
    /// 権限不足・読み取り専用・開けないパス。
    Permission,
    /// ディスク容量不足。
    DiskFull,
    /// 上記以外。
    Other,
}

/// 分類から決まる行動。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupAction {
    /// 原因とパスを示して終了する。
    ReportAndExit,
    /// 「退避して新しく作る／終了する」を選ばせる。
    OfferBackup,
}

pub fn classify_db_error(err: &rusqlite::Error) -> StartupFailure {
    use rusqlite::ErrorCode;
    match err {
        rusqlite::Error::SqliteFailure(e, _) => match e.code {
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => StartupFailure::Corrupt,
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => StartupFailure::Locked,
            // CannotOpen は権限以外（パス不正・親がファイル等）でも返るため Permission にしない
            ErrorCode::PermissionDenied | ErrorCode::ReadOnly => StartupFailure::Permission,
            ErrorCode::DiskFull => StartupFailure::DiskFull,
            _ => StartupFailure::Other,
        },
        _ => StartupFailure::Other,
    }
}

pub fn classify_io_error(err: &io::Error) -> StartupFailure {
    match err.kind() {
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => {
            StartupFailure::Permission
        }
        io::ErrorKind::StorageFull => StartupFailure::DiskFull,
        _ => StartupFailure::Other,
    }
}

pub fn decide_action(failure: StartupFailure) -> StartupAction {
    match failure {
        StartupFailure::Corrupt => StartupAction::OfferBackup,
        _ => StartupAction::ReportAndExit,
    }
}

/// 退避対象の付随ファイル接尾辞。このアプリは journal_mode を設定しないためロールバック
/// ジャーナル（`-journal`）が既定だが、WAL 運用の DB が持ち込まれても安全なように全部扱う。
const SIDE_SUFFIXES: [&str; 3] = ["-journal", "-wal", "-shm"];

/// 壊れた DB を `<name>.broken-<ts>` へリネームして退避する（削除しない）。
/// 付随ファイル（`-journal`/`-wal`/`-shm`）が残ると新 DB に誤適用されるため、同じ接尾辞で
/// **本体より先に**退避する。どれか1つでも失敗したら、動かした分を戻してエラーを返す。
/// 退避先は本体・付随ファイルのすべてで未使用の接尾辞を選ぶ（Windows の rename は上書きするため）。
pub fn backup_broken_db(db_path: &Path, timestamp: u64) -> io::Result<PathBuf> {
    backup_broken_db_with(db_path, timestamp, &|from, to| std::fs::rename(from, to))
}

/// `backup_broken_db` の本体。rename を差し替えられる（巻き戻し経路のテスト用）。
fn backup_broken_db_with(
    db_path: &Path,
    timestamp: u64,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    let name = db_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid db path"))?;
    let side = |ext: &str| db_path.with_file_name(format!("{name}{ext}"));
    let mut n = 0u32;
    let suffix = loop {
        let suffix = if n == 0 {
            format!("broken-{timestamp}")
        } else {
            format!("broken-{timestamp}-{n}")
        };
        let taken = std::iter::once("")
            .chain(SIDE_SUFFIXES)
            .any(|ext| side(&format!("{ext}.{suffix}")).exists());
        if !taken {
            break suffix;
        }
        n += 1;
    };
    // (元, 退避先)。付随ファイルが先、本体が最後
    let mut moves: Vec<(PathBuf, PathBuf)> = SIDE_SUFFIXES
        .iter()
        .map(|ext| (side(ext), side(&format!("{ext}.{suffix}"))))
        .filter(|(from, _)| from.exists())
        .collect();
    moves.push((db_path.to_path_buf(), side(&format!(".{suffix}"))));
    let mut done: Vec<&(PathBuf, PathBuf)> = vec![];
    for m in &moves {
        if let Err(e) = rename(&m.0, &m.1) {
            // 動かした分を戻す。戻せなかったファイルは利用者に伝える（半端な状態の場所を示す）
            let mut stranded: Vec<String> = vec![];
            for (from, to) in done.iter().rev() {
                if let Err(re) = rename(to, from) {
                    stranded.push(format!("{} ({re})", to.display()));
                }
            }
            if stranded.is_empty() {
                return Err(e);
            }
            return Err(io::Error::new(
                e.kind(),
                format!(
                    "{e}; 元に戻せなかったファイル / could not be restored: {}",
                    stranded.join(", ")
                ),
            ));
        }
        done.push(m);
    }
    Ok(side(&format!(".{suffix}")))
}

fn cause_text(failure: StartupFailure) -> (&'static str, &'static str) {
    match failure {
        StartupFailure::Corrupt => (
            "データベースファイルが壊れています。",
            "The database file is corrupted.",
        ),
        StartupFailure::Locked => (
            "データベースが他のプロセスに使用されています。SSS が既に起動していないか確認してください。",
            "The database is in use by another process. Make sure SSS is not already running.",
        ),
        StartupFailure::Permission => (
            "保存先に書き込む権限がありません。",
            "No permission to write to the data location.",
        ),
        StartupFailure::DiskFull => (
            "ディスクの空き容量が不足しています。",
            "The disk is full.",
        ),
        StartupFailure::Other => (
            "起動に必要なデータを準備できませんでした。",
            "Failed to prepare the data needed to start.",
        ),
    }
}

/// 日英併記のエラーメッセージ（Rust 側に既存の i18n 機構は無いため、ネイティブダイアログは
/// 日本語+英語をインラインで併記する）。
pub fn failure_message(failure: StartupFailure, path: Option<&Path>, detail: &str) -> String {
    let (ja, en) = cause_text(failure);
    let mut s = format!("{ja}\n{en}\n");
    if let Some(p) = path {
        s.push_str(&format!("\n保存先 / Data path:\n{}\n", p.display()));
    }
    s.push_str(&format!("\n詳細 / Detail: {detail}"));
    s
}

pub fn backup_prompt_message(db_path: &Path, detail: &str) -> String {
    let mut s = failure_message(StartupFailure::Corrupt, Some(db_path), detail);
    s.push_str(
        "\n\n「退避して新しく作る」を選ぶと、壊れたファイルは名前を変えて残し（削除しません）、新しいデータベースで起動します。\
         \nChoosing \"Back up & start fresh\" renames the broken file (it is NOT deleted) and starts with a new database.",
    );
    s
}

pub const BACKUP_LABEL: &str = "退避して新しく作る / Back up & start fresh";
pub const EXIT_LABEL: &str = "終了する / Quit";

/// 起動失敗時にユーザーへ見せる内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupPlan {
    /// 原因を表示して終了する。
    Report { message: String },
    /// 「退避して新しく作る／終了する」を選ばせる。
    Offer { db_path: PathBuf, message: String },
}

impl StartupPlan {
    pub fn report(failure: StartupFailure, path: Option<&Path>, detail: &str) -> Self {
        StartupPlan::Report {
            message: failure_message(failure, path, detail),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            StartupPlan::Report { message } | StartupPlan::Offer { message, .. } => message,
        }
    }
}

/// ユーザーの選択を受けた後に取るべき行動。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Followup {
    /// そのまま非 0 で終了する。
    Exit,
    /// 退避に成功した。再起動して新しい DB で立ち上げる。
    Restart,
    /// 退避に失敗した。原因を表示して終了する。
    ReportThenExit(String),
}

/// DB を開く。失敗したら分類して `StartupPlan` を返す（UI には触れない）。
pub fn plan_db_open(db_path: &Path) -> Result<Database, (StartupFailure, StartupPlan)> {
    let err = match Database::new(db_path.to_path_buf()) {
        Ok(db) => return Ok(db),
        Err(e) => e,
    };
    let failure = classify_db_error(&err);
    let detail = err.to_string();
    let plan = match decide_action(failure) {
        StartupAction::ReportAndExit => StartupPlan::report(failure, Some(db_path), &detail),
        StartupAction::OfferBackup => StartupPlan::Offer {
            db_path: db_path.to_path_buf(),
            message: backup_prompt_message(db_path, &detail),
        },
    };
    Err((failure, plan))
}

/// ユーザーが選択した後の行動を決める。`Offer` で承諾されたときだけ退避を実行する。
pub fn follow_up(plan: &StartupPlan, accepted: bool, timestamp: u64) -> Followup {
    match plan {
        StartupPlan::Report { .. } => Followup::Exit,
        StartupPlan::Offer { .. } if !accepted => Followup::Exit,
        StartupPlan::Offer { db_path, .. } => match backup_broken_db(db_path, timestamp) {
            Ok(_) => Followup::Restart,
            Err(e) => Followup::ReportThenExit(failure_message(
                classify_io_error(&e),
                Some(db_path),
                &e.to_string(),
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sss-144-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_garbage(p: &Path) -> Vec<u8> {
        let bytes =
            b"this is definitely not a sqlite database file, just garbage bytes\x00\x01\x02"
                .repeat(4);
        std::fs::write(p, &bytes).unwrap();
        bytes
    }

    fn plan_err(p: &Path) -> (StartupFailure, StartupPlan) {
        plan_db_open(p).err().expect("must fail")
    }

    #[test]
    fn corrupt_db_file_is_classified_corrupt_and_offers_backup() {
        let dir = tmp_dir("corrupt");
        let p = dir.join("sss.db");
        write_garbage(&p);
        let err = Database::new(p.clone()).err().expect("garbage must fail");
        assert_eq!(classify_db_error(&err), StartupFailure::Corrupt);
        let (f, plan) = plan_err(&p);
        assert_eq!(f, StartupFailure::Corrupt);
        assert!(matches!(plan, StartupPlan::Offer { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unopenable_location_is_not_corrupt_and_only_reports() {
        // 親が通常ファイル → DB を作れない。OS を問わず再現できる。
        let dir = tmp_dir("unopenable");
        let blocker = dir.join("file");
        std::fs::write(&blocker, b"x").unwrap();
        let (f, plan) = plan_err(&blocker.join("sss.db"));
        assert_ne!(f, StartupFailure::Corrupt);
        assert!(matches!(&plan, StartupPlan::Report { message } if message.contains("sss.db")));
        let ioe = std::fs::create_dir_all(blocker.join("sub")).unwrap_err();
        assert_ne!(classify_io_error(&ioe), StartupFailure::Corrupt);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn readonly_directory_is_permission_io_class_and_only_reports() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("ro");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::write(dir.join("probe"), b"x").is_ok() {
            // root 等で書けてしまう環境では検証できない
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let ioe = std::fs::create_dir_all(dir.join("sub")).unwrap_err();
        assert_eq!(classify_io_error(&ioe), StartupFailure::Permission);
        let (f, plan) = plan_err(&dir.join("sss.db"));
        assert_ne!(f, StartupFailure::Corrupt);
        assert!(matches!(plan, StartupPlan::Report { .. }));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn locked_db_only_reports_and_never_offers_backup() {
        let dir = tmp_dir("locked");
        let p = dir.join("sss.db");
        drop(Database::new(p.clone()).unwrap());
        let holder = rusqlite::Connection::open(&p).unwrap();
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let (f, plan) = plan_err(&p);
        assert_eq!(f, StartupFailure::Locked);
        assert!(matches!(plan, StartupPlan::Report { .. }));
        assert_eq!(follow_up(&plan, true, 1), Followup::Exit);
        assert!(p.exists());
        drop(holder);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn io_kind_classification_and_actions() {
        assert_eq!(
            classify_io_error(&io::Error::from(io::ErrorKind::PermissionDenied)),
            StartupFailure::Permission
        );
        assert_eq!(
            classify_io_error(&io::Error::from(io::ErrorKind::StorageFull)),
            StartupFailure::DiskFull
        );
        for f in [
            StartupFailure::Locked,
            StartupFailure::DiskFull,
            StartupFailure::Permission,
            StartupFailure::Other,
        ] {
            assert_eq!(decide_action(f), StartupAction::ReportAndExit);
        }
        assert_eq!(
            decide_action(StartupFailure::Corrupt),
            StartupAction::OfferBackup
        );
    }

    #[test]
    fn backup_preserves_original_bytes_and_avoids_collision() {
        let dir = tmp_dir("backup");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        let dest = backup_broken_db(&p, 1700000000).unwrap();
        assert!(!p.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        write_garbage(&p);
        let dest2 = backup_broken_db(&p, 1700000000).unwrap();
        assert_ne!(dest, dest2);
        assert!(dest.exists() && dest2.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_moves_side_files_with_same_suffix_and_checks_their_collisions() {
        let dir = tmp_dir("sidefiles");
        let p = dir.join("sss.db");
        write_garbage(&p);
        for (ext, body) in [("-journal", b"J"), ("-wal", b"W"), ("-shm", b"S")] {
            std::fs::write(dir.join(format!("sss.db{ext}")), body).unwrap();
        }
        // 本体の退避先は空いているが、-wal の退避先だけ既に存在する → 別接尾辞を選ぶ
        std::fs::write(dir.join("sss.db-wal.broken-7"), b"OLD").unwrap();
        let dest = backup_broken_db(&p, 7).unwrap();
        assert_eq!(dest, dir.join("sss.db.broken-7-1"));
        assert_eq!(
            std::fs::read(dir.join("sss.db-journal.broken-7-1")).unwrap(),
            b"J"
        );
        assert_eq!(
            std::fs::read(dir.join("sss.db-wal.broken-7-1")).unwrap(),
            b"W"
        );
        assert_eq!(
            std::fs::read(dir.join("sss.db-shm.broken-7-1")).unwrap(),
            b"S"
        );
        assert_eq!(
            std::fs::read(dir.join("sss.db-wal.broken-7")).unwrap(),
            b"OLD"
        );
        for ext in ["", "-journal", "-wal", "-shm"] {
            assert!(!dir.join(format!("sss.db{ext}")).exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_failure_on_main_file_restores_side_files() {
        let dir = tmp_dir("rollback");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        std::fs::write(dir.join("sss.db-journal"), b"J").unwrap();
        std::fs::write(dir.join("sss.db-wal"), b"W").unwrap();
        let main = p.clone();
        let err = backup_broken_db_with(&p, 9, &|from, to| {
            if from == main {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        })
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert_eq!(std::fs::read(dir.join("sss.db-journal")).unwrap(), b"J");
        assert_eq!(std::fs::read(dir.join("sss.db-wal")).unwrap(), b"W");
        assert!(!dir.join("sss.db-journal.broken-9").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_rollback_failure_names_stranded_files() {
        let dir = tmp_dir("stranded");
        let p = dir.join("sss.db");
        write_garbage(&p);
        std::fs::write(dir.join("sss.db-wal"), b"W").unwrap();
        let main = p.clone();
        let err = backup_broken_db_with(&p, 9, &|from, to| {
            if from == main {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else if to.to_string_lossy().ends_with("sss.db-wal") {
                // 巻き戻し（退避先 → 元）の rename を失敗させる
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        })
        .unwrap_err();
        assert!(err.to_string().contains("sss.db-wal.broken-9"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn follow_up_accepted_backs_up_then_restarts_and_fresh_db_opens() {
        let dir = tmp_dir("accept");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        let (_, plan) = plan_err(&p);
        assert_eq!(follow_up(&plan, true, 42), Followup::Restart);
        assert_eq!(std::fs::read(dir.join("sss.db.broken-42")).unwrap(), bytes);
        assert!(Database::new(p).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn follow_up_declined_leaves_file_untouched() {
        let dir = tmp_dir("decline");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        let (_, plan) = plan_err(&p);
        assert_eq!(follow_up(&plan, false, 42), Followup::Exit);
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
