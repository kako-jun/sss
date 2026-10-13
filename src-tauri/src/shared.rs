//! コマンド間で共有する小さな部品（二重実行ガード・ダイアログ排他・ホーム Pictures 解決）。
//!
//! `commands/*` 同士が互いを参照しないよう、複数のコマンド（と `scan_service`）が使うものを
//! ここへ集約する（#146）。Tauri には依存しない。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

/// ホームディレクトリ配下の Pictures フォルダを取得する（OS別に環境変数を切り替え）。
pub fn home_pictures_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
    } else {
        std::env::var("HOME").map(|p| PathBuf::from(p).join("Pictures"))
    }
    .map_err(|_| "Failed to get home directory".to_string())
}

/// スキャン（`select_and_scan` / `rescan_last_directory`）の二重実行を防ぐRAIIガード（#61レビュー nit）。
///
/// `AppState::scan_in_progress` を `compare_exchange` で `false → true` にできた
/// 場合のみ生成でき、生成に成功すると必ず1つの `Drop` で `false` に戻す
/// （panic・早期`return`（`?`）・正常終了のいずれの経路でも解除される）。
///
/// `pub(crate)`: `commands::system::reset_all_data`（#64）も同じ `AtomicBool` で
/// 同じガードを取得し、スキャン中の初期化・初期化中のスキャン開始の両方を
/// 一箇所のロジックで防ぐ。
pub struct ScanGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> ScanGuard<'a> {
    /// 既にスキャンが実行中（`flag == true`）なら `Err` を返す。
    ///
    /// #80: ユーザー向け文言でなくエラーコード（`scanInProgress`）で返す。
    /// フロント辞書（`resolveScanErrorMessage`）が表示文言に変換する。
    pub fn acquire(flag: &'a AtomicBool) -> Result<Self, String> {
        Self::acquire_with_code(flag, "scanInProgress")
    }

    /// `acquire` のエラーコード指定版（ダイアログ表示中フラグ `dialogInProgress` 用、#93）。
    pub fn acquire_with_code(flag: &'a AtomicBool, code: &str) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ScanGuard { flag })
            .map_err(|_| code.to_string())
    }
}

impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod scan_guard_tests {
    use super::ScanGuard;
    use std::sync::atomic::AtomicBool;

    /// 1本目が保持している間、2本目の `acquire` はエラーになる。
    /// 1本目を drop すればロックは解除され、次の `acquire` は成功する。
    #[test]
    fn acquire_blocks_concurrent_scan_and_releases_on_drop() {
        let flag = AtomicBool::new(false);

        let guard = ScanGuard::acquire(&flag).expect("最初のacquireは成功するはず");
        let second = ScanGuard::acquire(&flag);
        // #80: ユーザー向け文言でなくエラーコードで返る契約をここで固定する。
        // フロント辞書（resolveScanErrorMessage/resolveResetAllDataErrorMessage）が
        // このコード文字列を直接switchしているため、文言（日本語/英語）に変わって
        // しまうと両方とも未知コード扱いのフォールバック文言に落ちてしまう。
        // `ScanGuard` は `Debug` を実装していないため `unwrap_err()` は使えず、
        // `err()` で `Option<String>` に変換してから比較する。
        assert_eq!(second.err(), Some("scanInProgress".to_string()));

        drop(guard);

        assert!(
            ScanGuard::acquire(&flag).is_ok(),
            "1本目がdropされればロックは解除され、次のacquireは成功するはず"
        );
    }

    /// 保持中にpanicしても（`?`による早期returnと同様に）Dropは必ず走り、
    /// ロックが解除されたままにならない。
    #[test]
    fn guard_releases_even_when_scope_panics() {
        let flag = AtomicBool::new(false);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = ScanGuard::acquire(&flag).unwrap();
            panic!("simulated failure mid-scan");
        }));
        assert!(result.is_err());

        assert!(
            ScanGuard::acquire(&flag).is_ok(),
            "panic経由でもguardのDropでロックは解除されるはず"
        );
    }
}

/// ダイアログ表示中フラグ（プロセス全体で1つ）。ダイアログはOS全体で同時に1つしか意味を
/// 持たないためプロセス static とした（`AppState` のフィールドにすると、`AppState` を直接
/// 構築する既存の結合テスト 8 ファイルすべてに波及するため見送り）。テストは
/// `acquire_dialog_guard` に自前のフラグを渡すので、この static には干渉しない。WebView が `select_and_scan` /
/// `select_share_directory` を連打してもダイアログが重ねて出ないようにする（#93レビュー）。
pub static DIALOG_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 選択ダイアログを開く前のガード（#93レビュー）。スキャンが実行中なら、ダイアログを出した後に
/// `scanInProgress` になる無駄を避けるため先に弾く。別のダイアログが表示中なら `dialogInProgress`。
/// 戻り値のガードはダイアログ表示〜スキャン完了まで保持する。
/// `check_scan`: スキャンを伴う選択（`select_and_scan`）か。ピック先の選択は false。
pub fn acquire_dialog_guard<'a>(
    scan_in_progress: &AtomicBool,
    dialog_flag: &'a AtomicBool,
    check_scan: bool,
) -> Result<ScanGuard<'a>, String> {
    if check_scan && scan_in_progress.load(Ordering::SeqCst) {
        return Err("scanInProgress".to_string());
    }
    ScanGuard::acquire_with_code(dialog_flag, "dialogInProgress")
}
