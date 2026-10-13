//! 設定キー定数・書き込み許可リスト・真偽値設定の解釈（Tauri 非依存、#148/#146）。
//!
//! 以前は `commands/settings.rs` にあったが、複数のコマンドとドメインモジュールが使うため
//! コマンド層から切り出した。**キー集合の正本**で、フロント `src/constants.ts` の
//! `SETTING_KEYS`/`BOOL_SETTING_DEFAULTS` は vitest（`src/settingKeys.test.ts`）がこのファイルを
//! 直接読んで照合する。`WRITABLE_SETTING_KEYS`/`BOOL_SETTING_DEFAULTS` は1行1件の書式を保つこと。

use crate::database::Database;

/// `apply_exif_rotation` のキー（#148）。
pub const APPLY_EXIF_ROTATION_KEY: &str = "apply_exif_rotation";
/// スキャン対象ディレクトリのキー（専用コマンド経由でのみ書かれる、許可リスト外）。
pub const LAST_DIRECTORY_KEY: &str = "last_directory_path";
/// ピック先ディレクトリのキー（専用コマンド経由でのみ書かれる、許可リスト外）。
pub const SHARE_DIRECTORY_KEY: &str = "share_directory_path";

/// `save_setting`（WebView から呼べる汎用の設定保存）で書き込める設定キー（#93）。
///
/// 許可リスト方式。スキャン対象・ピック先のような「管理下パス」の基準になる設定
/// （`last_directory_path` / `share_directory_path`）や内部フラグ（`sssignore_migrated`）を
/// WebView から直接書き換えられると、ダイアログを経ずに任意フォルダを管理下にできてしまう
/// ため、これらは専用コマンド（`select_and_scan` / `select_share_directory`）経由でしか
/// 書かれない。新しい UI 設定を足すときはここにキーを追加する。
pub const WRITABLE_SETTING_KEYS: &[&str] = &[
    "display_interval",
    "language",
    "apply_exif_rotation",
    "video_audio_enabled",
    "video_max_duration_sec",
    "map_thumbnail_enabled",
];

/// 真偽値設定の既定値表（#148）。**既定値の正本はここ**（フロントの `constants.ts` の
/// `BOOL_SETTING_DEFAULTS` はこれを写し、vitest が一致を検証する）。
/// 書式は vitest が正規表現で読むため `("key", bool),` の1行1件を保つこと。
pub const BOOL_SETTING_DEFAULTS: &[(&str, bool)] = &[
    ("apply_exif_rotation", true),
    ("video_audio_enabled", false),
    ("map_thumbnail_enabled", true),
];

/// 真偽値設定の文字列を解釈する（#148）。`"true"`→true、`"false"`→false、
/// それ以外（未設定・破損値）は `default`。フロントの `parseBoolSetting` と同じ規則。
pub fn parse_bool_setting(value: Option<&str>, default: bool) -> bool {
    match value {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

/// DB から真偽値設定を読む（#148）。キーが [`BOOL_SETTING_DEFAULTS`] に無ければ panic
/// （プログラミングエラー）。DB エラー・未設定・破損値は既定値に倒す。
pub fn get_bool_setting(db: &Database, key: &str) -> bool {
    let default = BOOL_SETTING_DEFAULTS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, d)| *d)
        .unwrap_or_else(|| panic!("unknown bool setting key: {key}"));
    let stored = db.get_setting(key).ok().flatten();
    parse_bool_setting(stored.as_deref(), default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bool_setting_follows_true_false_else_default() {
        for default in [true, false] {
            assert!(parse_bool_setting(Some("true"), default));
            assert!(!parse_bool_setting(Some("false"), default));
            // 未設定・破損値は既定値に倒す
            assert_eq!(parse_bool_setting(None, default), default);
            for broken in ["", "TRUE", "1", "yes", " true", "maybe"] {
                assert_eq!(
                    parse_bool_setting(Some(broken), default),
                    default,
                    "{broken}"
                );
            }
        }
    }

    #[test]
    fn key_consts_match_the_tables() {
        assert!(WRITABLE_SETTING_KEYS.contains(&APPLY_EXIF_ROTATION_KEY));
        assert!(BOOL_SETTING_DEFAULTS
            .iter()
            .any(|(k, _)| *k == APPLY_EXIF_ROTATION_KEY));
        // 管理下パスの基準は WebView から書けない
        assert!(!WRITABLE_SETTING_KEYS.contains(&LAST_DIRECTORY_KEY));
        assert!(!WRITABLE_SETTING_KEYS.contains(&SHARE_DIRECTORY_KEY));
    }

    #[test]
    fn bool_defaults_are_all_writable_keys() {
        for (key, _) in BOOL_SETTING_DEFAULTS {
            assert!(WRITABLE_SETTING_KEYS.contains(key), "{key}");
        }
    }

    #[test]
    fn get_bool_setting_reads_db_and_falls_back_to_default() {
        let dir = std::env::temp_dir().join(format!("sss-148-bool-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::new(dir.join("sss.db")).unwrap();
        for (key, default) in BOOL_SETTING_DEFAULTS {
            assert_eq!(get_bool_setting(&db, key), *default, "unset {key}");
            db.save_setting(key, "garbage").unwrap();
            assert_eq!(get_bool_setting(&db, key), *default, "broken {key}");
            db.save_setting(key, "true").unwrap();
            assert!(get_bool_setting(&db, key), "{key}");
            db.save_setting(key, "false").unwrap();
            assert!(!get_bool_setting(&db, key), "{key}");
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
