//! asset protocol scope（Tauri の `convertFileSrc` が読み込めるディレクトリ）の
//! 動的許可に使う純関数群。
//!
//! `tauri::scope::fs::Scope::allow_directory` の呼び出し自体は実行中の Tauri アプリの
//! 状態を書き換える副作用なので、「どのディレクトリを許可すべきか」を判断する部分だけを
//! ここに切り出す。呼び出し側（`lib.rs` の起動処理・`commands::scan` のスキャンコマンド・
//! `commands::settings::save_setting`・`commands::file_operations::pick_image`）が
//! 実際の許可 API 呼び出しを行う。

use std::path::{Path, PathBuf};

/// 既定のピック先フォルダ名（`<pictures>/sss-picked`）。
const DEFAULT_PICK_DIR_NAME: &str = "sss-picked";

/// 既定のピック先ディレクトリ（`<pictures>/sss-picked`）。設定が無いときの解決先であり、
/// 設定画面が「既定に戻す」で表示するパスでもある（#67: 以前は呼び出し側が
/// "sss-picked" を個別に持っていた）。
pub fn default_share_directory(pictures_dir: &Path) -> PathBuf {
    pictures_dir.join(DEFAULT_PICK_DIR_NAME)
}

/// ピック先ディレクトリを解決する（設定済みならそれを、無ければ `<pictures>/sss-picked`）。
pub fn resolve_share_directory(pictures_dir: &Path, saved_setting: Option<&str>) -> PathBuf {
    match saved_setting {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => default_share_directory(pictures_dir),
    }
}

/// ピック先ディレクトリとして受け入れてよいパスか（#87 M1）。
///
/// ピック先は `get_thumbnail`/`pick_image` の「管理下」判定の基準になるため、WebView から
/// `/` やホームディレクトリ等の広いパスに書き換えられると制限が無意味になる。ピック先は
/// 未作成のことがあるので存在は要求しない。次を拒否する（**拒否リスト方式**。外付け
/// ドライブ・NAS など正当な任意フォルダを許すため allowlist にはしない）:
/// - 空・相対パス・`..` を含むパス
/// - ファイルシステムルートのうち [`is_protected_root`] に該当するもの（Unix の `/`、
///   Windows ではホームと同一ドライブのルート。`D:\` や UNC 共有ルートは `sanitize_allow_dir`
///   と同様に許可する）
/// - ホームディレクトリ自身およびその祖先（`/Users` 等）
/// - システム領域（[`system_protected_dirs`]）と、ホーム配下の秘密情報ディレクトリ
///   （`.ssh` `.gnupg` `.aws` `.kube`）とその配下
///
/// 比較は存在する最長の祖先を `canonicalize` した実パスで行い、macOS/Windows の
/// 大文字小文字非区別 FS では大文字小文字を無視する（`/users` などの別表記で
/// すり抜けさせない）。
pub fn is_acceptable_share_directory(path: &Path, home_dir: Option<&Path>) -> bool {
    use std::path::Component;
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return false;
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let Some(home) = home_dir else {
        // ホームが不明なら広いパスかどうか判定できない。安全側に倒して拒否。
        return false;
    };
    let candidate = resolve_for_comparison(path);
    let home = resolve_for_comparison(home);
    if candidate.parent().is_none() {
        return !is_protected_root(&candidate, Some(&home));
    }
    if path_starts_with(&home, &candidate) {
        return false;
    }
    for dir in system_protected_dirs()
        .into_iter()
        .chain(HOME_SECRET_DIRS.iter().map(|name| home.join(name)))
    {
        if path_starts_with(&candidate, &resolve_for_comparison(&dir)) {
            return false;
        }
    }
    true
}

/// ホーム配下の秘密情報ディレクトリ名（ピック先にできない）。
const HOME_SECRET_DIRS: [&str; 5] = [".ssh", ".gnupg", ".aws", ".kube", "Library/Keychains"];

/// ピック先にできないシステム領域。`/var` と `/private` 全体は macOS の一時領域
/// （`/private/var/folders`）や外付けのマウント先を含むので丸ごとは拒否せず、
/// 設定ファイル置き場の `/private/etc` だけを対象にする。`/root`（root のホーム）は
/// 拒否するが、`/opt` と `/run` は外付け・自動マウント（`/run/media`）や正当なアプリ置き場を
/// 壊すので対象外。
fn system_protected_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect()
    }
    #[cfg(not(windows))]
    {
        [
            "/etc",
            "/usr",
            "/bin",
            "/sbin",
            "/boot",
            "/dev",
            "/proc",
            "/sys",
            "/System",
            "/Library",
            "/private/etc",
            "/root",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }
}

/// 比較用に実パスへ解決する。存在する最長の祖先を `canonicalize` し、残りの
/// （未作成の）要素をそのまま付ける。どの祖先も解決できなければ元のパス。
fn resolve_for_comparison(path: &Path) -> PathBuf {
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut current = path;
    loop {
        if let Ok(canonical) = current.canonicalize() {
            return tail.iter().rev().fold(canonical, |acc, c| acc.join(c));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                current = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// `path` が `base` の配下（または同一）か。macOS/Windows の FS は既定で大文字小文字を
/// 区別しないため、その2 OS では要素ごとに大文字小文字を無視して比較する。
fn path_starts_with(path: &Path, base: &Path) -> bool {
    #[cfg(any(target_os = "macos", windows))]
    {
        let fold = |p: &Path| -> Vec<String> {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                .collect()
        };
        let (path, base) = (fold(path), fold(base));
        path.starts_with(&base)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        path.starts_with(base)
    }
}

/// 検証済みのピック先を解決する（#87 M1）。保存値が不正（相対・ルート・ホーム等）なら
/// 既定 `<pictures>/sss-picked` にフォールバックする。
pub fn resolve_validated_share_directory(
    pictures_dir: &Path,
    saved_setting: Option<&str>,
) -> PathBuf {
    let resolved = resolve_share_directory(pictures_dir, saved_setting);
    if is_acceptable_share_directory(&resolved, dirs::home_dir().as_deref()) {
        resolved
    } else {
        default_share_directory(pictures_dir)
    }
}

/// ピック先ディレクトリを解決し、そのまま asset scope に許可してよいか判定する。
/// `resolve_share_directory` と `sanitize_allow_dir` を束ねた薄いラッパーで、
/// `save_setting`（設定変更時）が使う。`pick_image` はピック先の解決を
/// `get_picked_directory` に一本化しており、ディレクトリ作成直後の再許可
/// （起動時・設定変更時点ではディレクトリ未作成で許可に失敗していることがあるため、
/// 実在が保証されたタイミングで改めて判定し直す。レビュー #73 must）では
/// 解決済みのパスに対して `sanitize_allow_dir` を直接呼ぶ。
pub fn resolve_and_sanitize_share_directory(
    pictures_dir: &Path,
    saved_setting: Option<&str>,
) -> Option<PathBuf> {
    sanitize_allow_dir(&resolve_share_directory(pictures_dir, saved_setting))
}

/// 起動直後（フロントの自動スキャン完了前）に asset scope へ許可しておくべきディレクトリ一覧。
///
/// - キャッシュディレクトリ: 最適化画像・先読みの保存先。常に必要。
/// - ピック先ディレクトリ: 設定画面「ピック済み」タブのサムネイル表示に使う
///   （ホームディレクトリが解決できない等で不明な場合は省く）。
/// - 過去にスキャンした全ディレクトリ（`scan_history` の distinct `directory_path`。
///   前回ディレクトリだけでなく、履歴タブ（`get_recent_images`）に残る他ディレクトリの
///   画像も表示できるよう、起動時自動スキャンの完了を待たずに先に許可しておく。
///   レビュー #73 should2）。
pub fn startup_allow_dirs(
    cache_dir: &Path,
    share_directory: Option<&Path>,
    scanned_directories: &[PathBuf],
) -> Vec<PathBuf> {
    let mut dirs = vec![cache_dir.to_path_buf()];
    if let Some(dir) = share_directory {
        dirs.push(dir.to_path_buf());
    }
    dirs.extend(scanned_directories.iter().cloned());
    dirs
}

/// asset scope に実際に許可してよいディレクトリかどうかを検証する（M1修正: レビュー #73）。
///
/// `tauri::scope::fs::Scope::allow_directory` は与えられたパスをそのままパターン化するため、
/// 空文字列（`Path::new("")`）を渡すと `"/**"` 相当の全ファイルシステム許可パターンが
/// 生成されてしまう事故があった。この関数はそれを防ぐゲートで、以下をすべて満たす
/// ディレクトリだけを許可し、`canonicalize` 済みの絶対パスを返す:
///
/// - 空文字列でない
/// - 絶対パスである
/// - 実在するディレクトリである（`is_dir()`）
/// - ファイルシステムルート自体（`parent()` が `None` になるパス）のうち、
///   「保護対象のルート」ではない（[`is_protected_root`] 参照。should1修正:
///   Windows のドライブ直下を一律拒否すると `D:\` 等の SD カード/外付けドライブを
///   スキャン対象にできなくなるため、ホームディレクトリが属するドライブ
///   （システムドライブ相当。Unix では `/` の一択）だけを拒否する）
///
/// `startup_allow_dirs` の出力・`save_setting`/`pick_image` で解決された共有先・
/// スキャンコマンドのスキャン対象など、`allow_directory` を呼ぶ直前のすべての候補に適用する。
pub fn sanitize_allow_dir(path: &Path) -> Option<PathBuf> {
    sanitize_allow_dir_with_home(path, dirs::home_dir().as_deref())
}

/// [`sanitize_allow_dir`] のテスト可能なコア実装。ホームディレクトリを引数として
/// 受け取ることで、実環境の `dirs::home_dir()` に依存せず単体テストできる。
fn sanitize_allow_dir_with_home(path: &Path, home_dir: Option<&Path>) -> Option<PathBuf> {
    check_allow_dir_with_home(path, home_dir).ok()
}

/// asset scope への許可が拒否された理由（#121）。
/// 「まだ作られていないだけ」の正常系と「危険・不正なパスの拒否」をログで区別するための分類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowDirRejection {
    /// 空文字列
    Empty,
    /// 相対パス
    Relative,
    /// パスが存在しない。ピック先フォルダが初回 `pick_image` まで未作成なのは正常
    NotYetCreated,
    /// 存在するがディレクトリではない（ファイル等。リンク先が無いシンボリックリンクを含む）
    NotADirectory,
    /// 状態の取得や正規化（`canonicalize`）に失敗した（権限不足・リンク切れ等）
    Inaccessible,
    /// 保護対象のファイルシステムルート（Unix の `/`、ホームと同一ドライブのルート）
    ProtectedRoot,
}

impl AllowDirRejection {
    /// 通常運用で起きうる拒否（警告に値しない）かどうか。未作成のみが該当する。
    pub fn is_expected(self) -> bool {
        matches!(self, AllowDirRejection::NotYetCreated)
    }
}

/// [`sanitize_allow_dir`] と同じ判定を行い、拒否の理由を返す。
pub fn check_allow_dir(path: &Path) -> Result<PathBuf, AllowDirRejection> {
    check_allow_dir_with_home(path, dirs::home_dir().as_deref())
}

fn check_allow_dir_with_home(
    path: &Path,
    home_dir: Option<&Path>,
) -> Result<PathBuf, AllowDirRejection> {
    if path.as_os_str().is_empty() {
        return Err(AllowDirRejection::Empty);
    }
    if !path.is_absolute() {
        return Err(AllowDirRejection::Relative);
    }
    // symlink_metadata: リンク自体の存在を見る（リンク切れは「未作成」ではなく不正扱い）
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AllowDirRejection::NotYetCreated)
        }
        Err(_) => return Err(AllowDirRejection::Inaccessible),
    }
    if !path.is_dir() {
        return Err(AllowDirRejection::NotADirectory);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| AllowDirRejection::Inaccessible)?;
    if canonical.parent().is_none() && is_protected_root(&canonical, home_dir) {
        return Err(AllowDirRejection::ProtectedRoot);
    }
    Ok(canonical)
}

/// `sanitize_allow_dir` が `None` を返したパスのログを出す（#121）。
/// 未作成（正常）はデバッグビルドでのみ出力し、危険・不正なパスは常に警告として出力する。
pub fn log_refused_allow_dir(path: &Path) {
    let reason = match check_allow_dir(path) {
        Err(reason) => reason,
        Ok(_) => return,
    };
    if reason.is_expected() {
        if cfg!(debug_assertions) {
            eprintln!(
                "[debug] asset scope directory not created yet (skipped): {}",
                path.display()
            );
        }
    } else {
        eprintln!(
            "Refusing to allow unsafe asset scope directory ({reason:?}): {}",
            path.display()
        );
    }
}

/// ファイルシステムルート（`parent()` が `None` になるパス）のうち、
/// asset scope への許可を拒否すべきものかどうかを判定する（純関数。fsアクセスなし）。
///
/// - Unix はルートが `/` の1種類しかなく、常に拒否対象。
/// - Windows はドライブごとに存在するため、ホームディレクトリが属するドライブの
///   ルート（システムドライブ相当、通常 `C:\`）だけを拒否し、SD カード等の
///   他ドライブ直下（例: `D:\`）は許可する。
/// - ホームディレクトリが不明な場合は安全側に倒し、あらゆるルートを拒否する。
///
/// `canonical_root` と `home_dir` は [`normalize_root_for_comparison`] で正規化してから
/// 比較する（3巡目レビュー #73 must）。`canonicalize()` は Windows で verbatim 形式
/// （`\\?\C:\`, `Prefix::VerbatimDisk`）を返すが、`dirs::home_dir()` は通常表記
/// （`C:\Users\...`, `Prefix::Disk`）を返すため、正規化なしの単純な `Path` 等価比較では
/// 同じドライブでも一致しなかった。
fn is_protected_root(canonical_root: &Path, home_dir: Option<&Path>) -> bool {
    match home_dir {
        Some(home) => {
            normalize_root_for_comparison(canonical_root) == normalize_root_for_comparison(home)
        }
        None => true,
    }
}

/// パスの「ルート部分」（ドライブレター/UNC共有）を比較用に正規化する純粋な文字列処理。
/// `std::path::Component`/`Prefix` を使わず、OS のパス解釈規則に依存せず動作するため、
/// Windows のパス表記を Windows 以外の CI でも直接テストできる。
///
/// - verbatim ディスク（`\\?\C:\...`）→ `C:`（ドライブ文字を大文字化）
/// - verbatim UNC（`\\?\UNC\server\share\...`）→ `\\SERVER\SHARE`
/// - 通常ディスク（`C:\...` / フルパス可）→ `C:`
/// - 通常 UNC（`\\server\share\...`）→ `\\SERVER\SHARE`
/// - Unix の絶対パス（`/...`）→ `/`（Unix はルートが1種類しかないため常に `/` に還元）
/// - それ以外（相対パス等）→ 元の文字列をそのまま返す
///
/// `home_dir`（`C:\Users\kako` のようなフルパス）と、既にルートだけの `canonical_root`
/// （`\\?\C:\` 等）の両方をこの関数に通すことで、`.ancestors()` のような OS 依存の
/// パス分解を経由せずに「同じドライブ/共有を指しているか」を比較できる。
fn normalize_root_for_comparison(path: &Path) -> String {
    let s = path.to_string_lossy();

    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return normalize_unc_server_share(rest);
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return extract_drive_letter(rest).unwrap_or_else(|| rest.to_uppercase());
    }
    if let Some(rest) = s.strip_prefix(r"\\") {
        return normalize_unc_server_share(rest);
    }
    if let Some(drive) = extract_drive_letter(&s) {
        return drive;
    }
    if s.starts_with('/') {
        return "/".to_string();
    }
    s.to_string()
}

/// `C:` のようなドライブレター表記を文字列先頭から抽出し、大文字化して返す。
/// 先頭2バイトが `<英字>:` の形でなければ `None`。
fn extract_drive_letter(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        Some(format!("{}:", (bytes[0] as char).to_ascii_uppercase()))
    } else {
        None
    }
}

/// `server\share\...` 形式の残り文字列から UNC のサーバー名・共有名部分だけを取り出し、
/// `\\SERVER\SHARE`（大文字化）に正規化する。
fn normalize_unc_server_share(rest: &str) -> String {
    let mut parts = rest.splitn(3, '\\');
    let server = parts.next().unwrap_or("").to_uppercase();
    let share = parts.next().unwrap_or("").to_uppercase();
    format!(r"\\{server}\{share}")
}

#[cfg(test)]
mod tests {
    /// 実在する一時ディレクトリを「ホーム」に見立てる（canonicalize の OS 差
    /// （macOS の /var → /private/var 等）を踏まないよう、実パスで組む）。
    fn fake_home(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("sss_share_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home").join("kako");
        std::fs::create_dir_all(&home).unwrap();
        (base, home)
    }

    #[test]
    fn share_directory_rejects_relative_root_home_and_ancestors() {
        let (base, home) = fake_home("rej");
        let root = home.ancestors().last().unwrap().to_path_buf();
        let escaping = home.join("..").join("x");
        for bad in [
            PathBuf::new(),
            PathBuf::from("relative/picked"),
            root,
            base.join("home"),
            home.clone(),
            escaping,
        ] {
            assert!(
                !is_acceptable_share_directory(&bad, Some(&home)),
                "{bad:?} は拒否"
            );
        }
        // ホーム不明は安全側で拒否。
        assert!(!is_acceptable_share_directory(&base.join("mnt"), None));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn share_directory_accepts_nonexistent_paths_outside_the_home_chain() {
        let (base, home) = fake_home("ok");
        for ok in [
            home.join("Pictures").join("sss-picked"),
            base.join("mnt").join("picked"),
        ] {
            assert!(is_acceptable_share_directory(&ok, Some(&home)), "{ok:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn share_directory_rejects_secret_dirs_under_home() {
        let (base, home) = fake_home("secret");
        for name in [".ssh", ".gnupg", ".aws", ".kube", "Library/Keychains"] {
            let dir = home.join(name);
            assert!(!is_acceptable_share_directory(&dir, Some(&home)), "{name}");
            assert!(
                !is_acceptable_share_directory(&dir.join("sub").join("x"), Some(&home)),
                "{name}/sub/x"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn share_directory_rejects_unix_system_dirs() {
        let (base, home) = fake_home("sys");
        for bad in [
            "/etc",
            "/etc/ssh",
            "/usr/local/x",
            "/bin",
            "/private/etc/x",
            "/root",
            "/root/pics",
        ] {
            assert!(
                !is_acceptable_share_directory(Path::new(bad), Some(&home)),
                "{bad}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// macOS/Windows は大文字小文字非区別 FS。別表記（`HOME` / `.SSH`）でもすり抜けない。
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn share_directory_check_ignores_case_on_case_insensitive_filesystems() {
        let (base, home) = fake_home("case");
        let upper_ancestor = base.join("HOME");
        assert!(!is_acceptable_share_directory(&upper_ancestor, Some(&home)));
        assert!(!is_acceptable_share_directory(
            &home.join(".SSH"),
            Some(&home)
        ));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// ホームと別ドライブ／UNC 共有のルートは許可し（`sanitize_allow_dir` と同じ扱い）、
    /// ホームと同一ドライブのルートは拒否する。
    #[cfg(windows)]
    #[test]
    fn share_directory_windows_drive_and_unc_roots_follow_protected_root_rule() {
        let home = Path::new(r"C:\Users\kako");
        assert!(is_acceptable_share_directory(Path::new(r"D:\"), Some(home)));
        assert!(is_acceptable_share_directory(
            Path::new(r"\\nas\photos\"),
            Some(home)
        ));
        assert!(!is_acceptable_share_directory(
            Path::new(r"C:\"),
            Some(home)
        ));
        assert!(!is_acceptable_share_directory(
            Path::new(r"C:\Users"),
            Some(home)
        ));
    }

    use super::*;

    // --- resolve_share_directory ---

    #[test]
    fn resolve_share_directory_defaults_to_pictures_sss_picked_when_unset() {
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, None),
            pictures.join("sss-picked")
        );
    }

    #[test]
    fn resolve_share_directory_defaults_when_saved_setting_is_empty_string() {
        // 境界値: 空文字は「未設定」と同じ扱い（保存時のバグ等で空文字が入っても暴走しない）
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some("")),
            pictures.join("sss-picked")
        );
    }

    #[test]
    fn resolve_share_directory_treats_whitespace_only_as_non_empty() {
        // 境界値+1: is_empty() はバイト長のみで判定するため、空白1文字は「空」ではない。
        // トリムしない現在の実装をそのまま固定する（事故防止の仕様確認）。
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some(" ")),
            PathBuf::from(" ")
        );
    }

    #[test]
    fn resolve_share_directory_uses_saved_absolute_path_verbatim() {
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some("/mnt/ssd/picked")),
            PathBuf::from("/mnt/ssd/picked")
        );
    }

    #[test]
    fn resolve_share_directory_uses_saved_relative_path_verbatim() {
        // 異常系寄りの同値分割: 相対パスが保存されていても pictures_dir とは結合しない
        // （呼び出し側が絶対パスを保存する前提だが、関数自体はそのまま通す仕様を固定）。
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some("relative/picked")),
            PathBuf::from("relative/picked")
        );
    }

    #[test]
    fn resolve_share_directory_handles_non_ascii_paths() {
        // 文字種: 日本語パス（macOS/Windowsどちらのユーザーディレクトリでも起こりうる）
        let pictures = Path::new("/Users/加古純/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, None),
            pictures.join("sss-picked")
        );
        assert_eq!(
            resolve_share_directory(pictures, Some("/Volumes/外付け/ピック先")),
            PathBuf::from("/Volumes/外付け/ピック先")
        );
    }

    #[test]
    fn resolve_share_directory_preserves_windows_style_backslash_path_literally() {
        // 文字種: Windowsパス。実行OSに関わらず、設定値をそのまま PathBuf 化するだけの
        // 挙動を固定する（区切り文字の解釈はしない）。
        let pictures = Path::new("/home/kako/Pictures");
        let windows_path = "C:\\Users\\kako\\Pictures\\sss-picked";
        assert_eq!(
            resolve_share_directory(pictures, Some(windows_path)),
            PathBuf::from(windows_path)
        );
    }

    // --- startup_allow_dirs ---
    //
    // share_directory は独立条件（Some/None）、scanned_directories は0〜複数件の
    // スライスなので、組合せをデシジョンテーブルで網羅する。cache_dir は常に先頭に入る。
    //
    // | share | scanned          | 期待される要素                        |
    // |-------|------------------|----------------------------------------|
    // | None  | []               | [cache]                                 |
    // | Some  | []               | [cache, share]                          |
    // | None  | [d1]             | [cache, d1]                             |
    // | Some  | [d1]             | [cache, share, d1]（順序も固定）        |
    // | Some  | [d1, d2, d3]     | [cache, share, d1, d2, d3]（複数件も全許可、should2） |

    #[test]
    fn startup_allow_dirs_only_cache_when_both_unset() {
        let cache = Path::new("/cache");
        assert_eq!(
            startup_allow_dirs(cache, None, &[]),
            vec![cache.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_share_when_only_share_set() {
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), &[]),
            vec![cache.to_path_buf(), share.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_scanned_when_only_scanned_set() {
        let cache = Path::new("/cache");
        let last = PathBuf::from("/photos/2026");
        assert_eq!(
            startup_allow_dirs(cache, None, std::slice::from_ref(&last)),
            vec![cache.to_path_buf(), last]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_both_in_cache_share_scanned_order_when_both_set() {
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        let last = PathBuf::from("/photos/2026");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), std::slice::from_ref(&last)),
            vec![cache.to_path_buf(), share.to_path_buf(), last]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_all_scanned_directories_from_history() {
        // should2(レビュー #73): 前回ディレクトリだけでなく、scan_history に残る
        // 過去のスキャン先すべてを候補に含められることを確認する（履歴タブ対応）。
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        let d1 = PathBuf::from("/photos/2024");
        let d2 = PathBuf::from("/photos/2025");
        let d3 = PathBuf::from("/mnt/sdcard/dcim");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), &[d1.clone(), d2.clone(), d3.clone()]),
            vec![cache.to_path_buf(), share.to_path_buf(), d1, d2, d3]
        );
    }

    #[test]
    fn startup_allow_dirs_does_not_dedupe_when_share_and_scanned_are_the_same_directory() {
        // 事故パターン確認: ピック先とスキャン対象が同じディレクトリの場合でも重複除去しない
        // （関数は単純listで、allow_directory 呼び出し側の冪等性に委ねる仕様を固定）。
        let cache = Path::new("/cache");
        let same = Path::new("/pictures/sss-picked");
        assert_eq!(
            startup_allow_dirs(cache, Some(same), &[same.to_path_buf()]),
            vec![cache.to_path_buf(), same.to_path_buf(), same.to_path_buf()]
        );
    }

    // --- normalize_root_for_comparison（純粋な文字列処理。OS非依存） ---
    //
    // must(3巡目レビュー #73): canonicalize() が返す verbatim 形式（\\?\C:\ 等）と
    // dirs::home_dir() が返す通常形式（C:\Users\... 等）が同じドライブ/共有を指す場合に
    // 正規化後の文字列が一致することを、Windows実機でなくても検証できる形で固定する。

    #[test]
    fn normalize_root_for_comparison_strips_verbatim_disk_prefix_and_uppercases_drive() {
        assert_eq!(normalize_root_for_comparison(Path::new(r"\\?\C:\")), "C:");
        assert_eq!(normalize_root_for_comparison(Path::new(r"\\?\c:\")), "C:");
    }

    #[test]
    fn normalize_root_for_comparison_extracts_drive_from_plain_full_path() {
        assert_eq!(
            normalize_root_for_comparison(Path::new(r"C:\Users\kako")),
            "C:"
        );
        assert_eq!(normalize_root_for_comparison(Path::new(r"d:\photos")), "D:");
    }

    #[test]
    fn normalize_root_for_comparison_normalizes_verbatim_and_plain_unc_the_same_way() {
        assert_eq!(
            normalize_root_for_comparison(Path::new(r"\\?\UNC\server\share\")),
            r"\\SERVER\SHARE"
        );
        assert_eq!(
            normalize_root_for_comparison(Path::new(r"\\server\share\Users\kako")),
            r"\\SERVER\SHARE"
        );
    }

    #[test]
    fn normalize_root_for_comparison_reduces_any_unix_absolute_path_to_root() {
        // Unix はルートが `/` の1種類しかないため、フルパスでもルートは常に `/` に還元する
        assert_eq!(normalize_root_for_comparison(Path::new("/")), "/");
        assert_eq!(normalize_root_for_comparison(Path::new("/home/kako")), "/");
    }

    #[test]
    fn normalize_root_for_comparison_leaves_relative_path_untouched() {
        assert_eq!(
            normalize_root_for_comparison(Path::new("relative/dir")),
            "relative/dir"
        );
    }

    // --- is_protected_root（純関数。fsアクセスなし） ---
    //
    // should1(レビュー #73): ルート拒否は Unix の `/` と「ホームディレクトリが属する
    // ドライブのルート」に限定する不変条件を、実ファイルシステムに依存せず検証する。
    // must(3巡目レビュー #73): verbatim/非verbatim表記の揺れがあっても同じドライブ/共有なら
    // 一致すること（normalize_root_for_comparison 経由）もあわせて検証する。

    #[test]
    fn is_protected_root_rejects_unix_root_regardless_of_home_depth() {
        assert!(is_protected_root(
            Path::new("/"),
            Some(Path::new("/home/kako"))
        ));
    }

    #[test]
    fn is_protected_root_rejects_everything_when_home_is_unknown() {
        // ホームディレクトリが解決できない環境では安全側に倒し、あらゆるルートを拒否する
        assert!(is_protected_root(Path::new("/"), None));
        assert!(is_protected_root(Path::new(r"\\?\D:\"), None));
    }

    #[test]
    fn is_protected_root_rejects_home_drive_even_with_verbatim_canonical_prefix() {
        // must(3巡目レビュー #73): canonicalize() 由来の \\?\C:\（VerbatimDisk）と
        // dirs::home_dir() 由来の C:\Users\...（Disk）が、正規化を通せば同一ドライブとして
        // 一致し、ホームドライブが保護されることを確認する。
        assert!(is_protected_root(
            Path::new(r"\\?\C:\"),
            Some(Path::new(r"C:\Users\kako"))
        ));
        // ドライブレターの大小表記ゆれも同一視する
        assert!(is_protected_root(
            Path::new(r"\\?\c:\"),
            Some(Path::new(r"C:\Users\kako"))
        ));
    }

    #[test]
    fn is_protected_root_allows_other_drive_different_from_home() {
        // SDカード等の別ドライブ（例: D:\）はホームドライブと一致しないため保護しない
        assert!(!is_protected_root(
            Path::new(r"\\?\D:\"),
            Some(Path::new(r"C:\Users\kako"))
        ));
        assert!(!is_protected_root(
            Path::new(r"D:\"),
            Some(Path::new(r"C:\Users\kako"))
        ));
    }

    #[test]
    fn is_protected_root_rejects_home_unc_share_even_with_verbatim_canonical_prefix() {
        // ホームディレクトリがネットワーク共有上にある環境（企業ドメイン参加PC等）を想定
        assert!(is_protected_root(
            Path::new(r"\\?\UNC\fileserver\home\"),
            Some(Path::new(r"\\fileserver\home\kako"))
        ));
    }

    #[test]
    fn is_protected_root_allows_other_unc_share_different_from_home() {
        assert!(!is_protected_root(
            Path::new(r"\\?\UNC\fileserver\public\"),
            Some(Path::new(r"\\fileserver\home\kako"))
        ));
    }

    // --- sanitize_allow_dir ---
    //
    // M1(must, レビュー #73): 拒否側の不変条件を固定する。
    // 空/相対/存在しない/ファイル/ホームドライブのルートは必ず None、
    // 正常な絶対ディレクトリだけが Some(canonicalize済み) になることを保証する。

    /// テスト専用のユニークな一時ディレクトリ。Drop で自動削除する
    /// （nit修正: レビュー #73。以前は作りっぱなしで後片付けしていなかった）。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("sss_asset_scope_test_{tag}_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sanitize_allow_dir_rejects_empty_path() {
        assert_eq!(sanitize_allow_dir(Path::new("")), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_relative_path() {
        // カレントディレクトリ相対では意図しない場所を許可しかねないため拒否する
        assert_eq!(sanitize_allow_dir(Path::new("relative/dir")), None);
        assert_eq!(sanitize_allow_dir(Path::new(".")), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_nonexistent_absolute_path() {
        let missing = std::env::temp_dir().join("sss_asset_scope_test_does_not_exist_xyz");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(sanitize_allow_dir(&missing), None);
    }

    #[test]
    fn check_allow_dir_classifies_rejection_reasons() {
        // #121: 未作成（正常）と危険・不正パスを区別する
        let dir = TempDir::new("check_reason_a");
        let missing = dir.path().join("sss-picked");
        assert_eq!(
            check_allow_dir(&missing),
            Err(AllowDirRejection::NotYetCreated)
        );
        assert!(AllowDirRejection::NotYetCreated.is_expected());

        let file_path = dir.path().join("a.txt");
        std::fs::write(&file_path, b"x").unwrap();
        assert_eq!(
            check_allow_dir(&file_path),
            Err(AllowDirRejection::NotADirectory)
        );

        assert_eq!(
            check_allow_dir(Path::new("")),
            Err(AllowDirRejection::Empty)
        );
        assert_eq!(
            check_allow_dir(Path::new("rel/dir")),
            Err(AllowDirRejection::Relative)
        );
        for r in [
            AllowDirRejection::Empty,
            AllowDirRejection::Relative,
            AllowDirRejection::NotADirectory,
            AllowDirRejection::Inaccessible,
            AllowDirRejection::ProtectedRoot,
        ] {
            assert!(!r.is_expected(), "{r:?} は警告対象");
        }
        // 未作成でも sanitize は従来どおり拒否する（scope に追加されない）
        assert_eq!(sanitize_allow_dir(&missing), None);
    }

    #[cfg(unix)]
    #[test]
    fn check_allow_dir_classifies_root_and_dangling_symlink() {
        assert_eq!(
            check_allow_dir_with_home(Path::new("/"), Some(Path::new("/home/x"))),
            Err(AllowDirRejection::ProtectedRoot)
        );
        let dir = TempDir::new("check_reason_b");
        let link = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &link).unwrap();
        // リンク切れは「未作成」ではなく警告対象
        assert_eq!(
            check_allow_dir(&link),
            Err(AllowDirRejection::NotADirectory)
        );
    }

    #[test]
    fn sanitize_allow_dir_rejects_file_path() {
        let dir = TempDir::new("rejects_file");
        let file_path = dir.path().join("not_a_dir.txt");
        std::fs::write(&file_path, b"x").unwrap();
        assert_eq!(sanitize_allow_dir(&file_path), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_filesystem_root_on_unix() {
        // Unix はルートが `/` の1種類しかなく、常に拒否対象（is_protected_root の
        // Windows ドライブ相対緩和は影響しない）。実行中のホストが必ず持つ唯一の
        // ルートなので、CI (ubuntu) でも実際に検証できる。
        assert_eq!(sanitize_allow_dir(Path::new("/")), None);
    }

    // 3巡目レビュー #73 で明示的に指定された Windows 実機限定の統合確認テスト。
    // 実際の dirs::home_dir() / canonicalize() を経由するため Windows でしか意味を
    // 持たないが、上の normalize_root_for_comparison / is_protected_root の単体テストは
    // 文字列処理のみで全 OS から検証済み。
    #[cfg(windows)]
    #[test]
    fn sanitize_allow_dir_rejects_c_drive_root_on_real_windows() {
        assert_eq!(sanitize_allow_dir(Path::new("C:\\")), None);
    }

    #[cfg(windows)]
    #[test]
    fn is_protected_root_treats_verbatim_c_drive_as_home_drive_on_real_windows() {
        assert!(is_protected_root(
            Path::new(r"\\?\C:\"),
            Some(Path::new(r"C:\Users\x"))
        ));
    }

    #[test]
    fn sanitize_allow_dir_accepts_valid_absolute_directory_and_canonicalizes() {
        let dir = TempDir::new("accepts_valid");
        let expected = dir.path().canonicalize().unwrap();
        assert_eq!(sanitize_allow_dir(dir.path()), Some(expected));
    }

    #[test]
    fn sanitize_allow_dir_with_home_allows_root_when_home_is_on_a_different_root() {
        // should1(レビュー #73): sanitize_allow_dir_with_home に偽のホームディレクトリを
        // 注入し、「ホームディレクトリのドライブと一致しないルートは許可する」ことを、
        // 実際に is_dir/canonicalize が通る本物のディレクトリ（tempdir）で確認する。
        // tempdir 自体はルートではないが、is_protected_root 側の判定(Some(false)) が
        // 素通りして最終的に許可される経路を、parent() != None のケースで検証する。
        let dir = TempDir::new("home_mismatch");
        let unrelated_home = Path::new("/this/home/does/not/exist/at/all");
        let expected = dir.path().canonicalize().unwrap();
        assert_eq!(
            sanitize_allow_dir_with_home(dir.path(), Some(unrelated_home)),
            Some(expected)
        );
    }

    // --- resolve_and_sanitize_share_directory ---

    #[test]
    fn resolve_and_sanitize_share_directory_accepts_existing_absolute_setting() {
        let dir = TempDir::new("resolve_and_sanitize_ok");
        let pictures = Path::new("/does/not/matter/because/setting/is/absolute");
        let expected = dir.path().canonicalize().unwrap();
        assert_eq!(
            resolve_and_sanitize_share_directory(pictures, Some(dir.path().to_str().unwrap())),
            Some(expected)
        );
    }

    #[test]
    fn resolve_and_sanitize_share_directory_rejects_when_default_does_not_exist_yet() {
        // must(レビュー #73): 初回起動でまだ pick フォルダが作成されていない場合、
        // resolve される既定パス（<pictures>/sss-picked）は is_dir() が false なので
        // 拒否される。これが「pick_image が create_dir_all 後に再許可すべき」根拠。
        let pictures = TempDir::new("resolve_and_sanitize_missing_pictures");
        assert_eq!(
            resolve_and_sanitize_share_directory(pictures.path(), None),
            None
        );
    }
}
