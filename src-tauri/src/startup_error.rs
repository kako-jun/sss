//! 起動時の致命的失敗（アプリデータディレクトリ・DB を開けない）の分類と復旧（#144）。
//!
//! 判断ロジック（エラー分類 → 取るべき行動）は UI に依存しない純粋関数にし、
//! ダイアログ表示は `StartupUi` という薄い継ぎ目の裏に隠す（`lib.rs` が rfd 実装を渡す）。
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
            ErrorCode::PermissionDenied | ErrorCode::ReadOnly | ErrorCode::CannotOpen => {
                StartupFailure::Permission
            }
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

/// 壊れた DB を `<name>.broken-<ts>` へリネームして退避する（削除しない）。
/// WAL/SHM が残っていると新 DB に誤適用されるため、同じ接尾辞で一緒に退避する。
pub fn backup_broken_db(db_path: &Path, timestamp: u64) -> io::Result<PathBuf> {
    let name = db_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid db path"))?;
    let mut n = 0u32;
    let dest = loop {
        let suffix = if n == 0 {
            format!("broken-{timestamp}")
        } else {
            format!("broken-{timestamp}-{n}")
        };
        let candidate = db_path.with_file_name(format!("{name}.{suffix}"));
        if !candidate.exists() {
            break (candidate, suffix);
        }
        n += 1;
    };
    std::fs::rename(db_path, &dest.0)?;
    for ext in ["-wal", "-shm"] {
        let side = db_path.with_file_name(format!("{name}{ext}"));
        if side.exists() {
            let _ = std::fs::rename(
                &side,
                db_path.with_file_name(format!("{name}{ext}.{}", dest.1)),
            );
        }
    }
    Ok(dest.0)
}

/// ダイアログ表示の継ぎ目（本番は rfd、テストは偽実装）。
pub trait StartupUi {
    fn show_error(&self, message: &str);
    /// 「退避して新しく作る」なら true、「終了する」なら false。
    fn confirm_backup(&self, message: &str) -> bool;
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

/// 起動を中止すべきことを表す（呼び出し側が非 0 で終了する）。
#[derive(Debug)]
pub struct StartupAbort;

/// DB を開く。失敗したら分類し、ダイアログ経由で復旧（破損時のみ退避）か中止を決める。
pub fn open_database_with_recovery(
    db_path: &Path,
    ui: &dyn StartupUi,
    timestamp: u64,
) -> Result<Database, StartupAbort> {
    let err = match Database::new(db_path.to_path_buf()) {
        Ok(db) => return Ok(db),
        Err(e) => e,
    };
    let failure = classify_db_error(&err);
    let detail = err.to_string();
    match decide_action(failure) {
        StartupAction::ReportAndExit => {
            ui.show_error(&failure_message(failure, Some(db_path), &detail));
            Err(StartupAbort)
        }
        StartupAction::OfferBackup => {
            if !ui.confirm_backup(&backup_prompt_message(db_path, &detail)) {
                return Err(StartupAbort);
            }
            if let Err(e) = backup_broken_db(db_path, timestamp) {
                let f = classify_io_error(&e);
                ui.show_error(&failure_message(f, Some(db_path), &e.to_string()));
                return Err(StartupAbort);
            }
            match Database::new(db_path.to_path_buf()) {
                Ok(db) => Ok(db),
                Err(e) => {
                    let f = classify_db_error(&e);
                    ui.show_error(&failure_message(f, Some(db_path), &e.to_string()));
                    Err(StartupAbort)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sss-144-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    struct FakeUi {
        accept: bool,
        errors: RefCell<Vec<String>>,
        asked: RefCell<u32>,
    }
    impl FakeUi {
        fn new(accept: bool) -> Self {
            Self {
                accept,
                errors: RefCell::new(vec![]),
                asked: RefCell::new(0),
            }
        }
    }
    impl StartupUi for FakeUi {
        fn show_error(&self, m: &str) {
            self.errors.borrow_mut().push(m.to_string());
        }
        fn confirm_backup(&self, _m: &str) -> bool {
            *self.asked.borrow_mut() += 1;
            self.accept
        }
    }

    fn write_garbage(p: &Path) -> Vec<u8> {
        let bytes =
            b"this is definitely not a sqlite database file, just garbage bytes\x00\x01\x02"
                .repeat(4);
        std::fs::write(p, &bytes).unwrap();
        bytes
    }

    #[test]
    fn corrupt_db_file_is_classified_corrupt() {
        let dir = tmp_dir("corrupt");
        let p = dir.join("sss.db");
        write_garbage(&p);
        let err = Database::new(p).err().expect("garbage must fail");
        assert_eq!(classify_db_error(&err), StartupFailure::Corrupt);
        assert_eq!(
            decide_action(StartupFailure::Corrupt),
            StartupAction::OfferBackup
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unopenable_location_is_not_corrupt_and_exits() {
        // 親が通常ファイル → DB を作れない（権限/IO 系）。OS を問わず再現できる。
        let dir = tmp_dir("unopenable");
        let blocker = dir.join("file");
        std::fs::write(&blocker, b"x").unwrap();
        let p = blocker.join("sss.db");
        let err = Database::new(p).err().expect("must fail");
        let f = classify_db_error(&err);
        assert_ne!(f, StartupFailure::Corrupt);
        assert_eq!(decide_action(f), StartupAction::ReportAndExit);
        let ioe = std::fs::create_dir_all(blocker.join("sub")).unwrap_err();
        assert_ne!(classify_io_error(&ioe), StartupFailure::Corrupt);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn readonly_directory_is_permission_class() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("ro");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let probe = std::fs::write(dir.join("probe"), b"x");
        if probe.is_ok() {
            // root 等で書けてしまう環境では検証できない
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let err = Database::new(dir.join("sss.db")).err().expect("must fail");
        assert_eq!(classify_db_error(&err), StartupFailure::Permission);
        let ioe = std::fs::create_dir_all(dir.join("sub")).unwrap_err();
        assert_eq!(classify_io_error(&ioe), StartupFailure::Permission);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn io_kind_classification() {
        let e = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(classify_io_error(&e), StartupFailure::Permission);
        let e = io::Error::from(io::ErrorKind::StorageFull);
        assert_eq!(classify_io_error(&e), StartupFailure::DiskFull);
        assert_eq!(
            decide_action(StartupFailure::Locked),
            StartupAction::ReportAndExit
        );
        assert_eq!(
            decide_action(StartupFailure::DiskFull),
            StartupAction::ReportAndExit
        );
    }

    #[test]
    fn backup_preserves_original_bytes() {
        let dir = tmp_dir("backup");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        let dest = backup_broken_db(&p, 1700000000).unwrap();
        assert!(!p.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        // 同じ時刻で再度退避しても上書きしない
        write_garbage(&p);
        let dest2 = backup_broken_db(&p, 1700000000).unwrap();
        assert_ne!(dest, dest2);
        assert!(dest.exists() && dest2.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_backs_up_and_creates_fresh_db_when_accepted() {
        let dir = tmp_dir("recover");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        let ui = FakeUi::new(true);
        assert!(open_database_with_recovery(&p, &ui, 42).is_ok());
        assert_eq!(*ui.asked.borrow(), 1);
        assert_eq!(std::fs::read(dir.join("sss.db.broken-42")).unwrap(), bytes);
        assert!(Database::new(p).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_declined_leaves_file_untouched() {
        let dir = tmp_dir("decline");
        let p = dir.join("sss.db");
        let bytes = write_garbage(&p);
        let ui = FakeUi::new(false);
        assert!(open_database_with_recovery(&p, &ui, 42).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_corrupt_failure_only_reports() {
        let dir = tmp_dir("report");
        let blocker = dir.join("file");
        std::fs::write(&blocker, b"x").unwrap();
        let ui = FakeUi::new(true);
        assert!(open_database_with_recovery(&blocker.join("sss.db"), &ui, 1).is_err());
        assert_eq!(*ui.asked.borrow(), 0);
        assert_eq!(ui.errors.borrow().len(), 1);
        assert!(ui.errors.borrow()[0].contains("sss.db"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
