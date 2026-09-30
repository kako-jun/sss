//! ピック機能（お気に入りをピックフォルダへコピー・一覧・削除）のファイルシステム処理（#67）。
//!
//! Tauri コマンド（`commands::file_operations`）から切り出した、状態を持たない関数群。
//! 「同名衝突時の連番」「一覧に出す拡張子」「削除してよいパスの検証」を単体テストできる
//! ようにするのが目的。

use crate::scanner::is_media_path;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// 連番の探索上限。実運用では届かない（同名を1万回ピックした場合のみ）。
const MAX_COLLISION_INDEX: u32 = 10_000;

/// 同名衝突時のファイル名。`n == 0` は元の名前、`n >= 1` は `stem_n.ext`
/// （拡張子が無ければ `stem_n`。旧実装は拡張子なしで `stem_ts.` と末尾ドットを付けていた）。
/// 非 UTF-8 のファイル名も壊さないよう `OsString` のまま組み立てる。
pub fn numbered_file_name(file_name: &OsStr, n: u32) -> OsString {
    if n == 0 {
        return file_name.to_os_string();
    }
    let path = Path::new(file_name);
    let mut name = path.file_stem().unwrap_or(file_name).to_os_string();
    name.push(format!("_{n}"));
    if let Some(ext) = path.extension() {
        name.push(".");
        name.push(ext);
    }
    name
}

/// `source` を `dest_dir` にコピーし、実際に作られたパスを返す。
///
/// 同名ファイルが既にある場合は `name_1.ext`, `name_2.ext` ... と連番を付ける。以前は
/// 秒単位のタイムスタンプを付けていたため、同じ秒に同じ名前を2回ピックすると
/// 上書きされていた。`create_new` で「存在しなければ作成」を原子的に行って名前を
/// 予約するので、存在確認と作成の間に割り込まれても既存ファイルは決して上書きしない。
/// 予約したパスへの実コピーは `fs::copy` に任せる（属性・macOS の clone/fcopyfile を
/// 活かす）。修正日時はプラットフォームによって `fs::copy` が引き継がないため、
/// コピー後に元ファイルの値を明示的に反映する（失敗しても無視）。
pub fn copy_with_unique_name(source: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let file_name = source.file_name().ok_or("Failed to get file name")?;

    for n in 0..=MAX_COLLISION_INDEX {
        let dest = dest_dir.join(numbered_file_name(file_name, n));
        match OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(reserved) => drop(reserved),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to copy file: {e}")),
        }
        return match fs::copy(source, &dest) {
            Ok(_) => {
                preserve_modified_time(source, &dest);
                Ok(dest)
            }
            Err(e) => {
                let _ = fs::remove_file(&dest);
                Err(format!("Failed to copy file: {e}"))
            }
        };
    }
    Err("Too many files with the same name in the picked directory".to_string())
}

/// `dest` の修正日時を `source` に揃える（ベストエフォート。失敗は無視）。
fn preserve_modified_time(source: &Path, dest: &Path) {
    let Ok(modified) = fs::metadata(source).and_then(|m| m.modified()) else {
        return;
    };
    if let Ok(file) = OpenOptions::new().write(true).open(dest) {
        let _ = file.set_modified(modified);
    }
}

/// ピックフォルダ直下のメディアファイル（画像＋動画。スキャナと同じ拡張子定義）の一覧。
pub fn list_picked_media(picked_dir: &Path) -> Result<Vec<String>, String> {
    let mut items: Vec<String> = Vec::new();
    let entries = fs::read_dir(picked_dir).map_err(|e| format!("Failed to read directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        // シンボリックリンクは辿らず一覧から除く。フォルダ外を指すリンクを出すと、
        // 表示はできても `validate_picked_delete_target` に拒否されて削除できない。
        let is_regular_file = entry
            .file_type()
            .map(|file_type| file_type.is_file())
            .unwrap_or(false);
        let path = entry.path();
        if is_regular_file && is_media_path(&path) {
            items.push(path.to_string_lossy().to_string());
        }
    }
    items.sort();
    Ok(items)
}

/// `delete_picked_image` が削除してよいパスかを検証する純粋なファイルシステム検査。
///
/// 許可するのは「ピックフォルダの中にある通常のメディアファイル」だけ。
/// `..` によるフォルダ外への脱出、ピックフォルダ内にあるがフォルダ外を指すシンボリック
/// リンク、フォルダ自体、フォルダ外のパスはすべて拒否する（`canonicalize` で実体パスに
/// 解決してから包含を判定する）。検証を通ったら、削除対象として渡された元のパス
/// （シンボリックリンクなら「リンクそのもの」）を返す。
pub fn validate_picked_delete_target(
    image_path: &Path,
    picked_dir: &Path,
) -> Result<PathBuf, String> {
    let canonical_path = image_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;
    let canonical_dir = picked_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve picked directory: {e}"))?;

    if canonical_path == canonical_dir || !canonical_path.starts_with(&canonical_dir) {
        return Err("Cannot delete files outside the picked directory".to_string());
    }
    if !canonical_path.is_file() {
        return Err("Not a file".to_string());
    }
    if !is_media_path(&canonical_path) {
        return Err("Not a media file".to_string());
    }
    Ok(image_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sss_pick_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn numbered_file_name_appends_index_before_extension() {
        assert_eq!(numbered_file_name(OsStr::new("a.jpg"), 0), "a.jpg");
        assert_eq!(numbered_file_name(OsStr::new("a.jpg"), 1), "a_1.jpg");
        assert_eq!(numbered_file_name(OsStr::new("a.b.png"), 12), "a.b_12.png");
        // 拡張子なしで末尾ドットが付かない（旧実装のバグ）。
        assert_eq!(numbered_file_name(OsStr::new("noext"), 2), "noext_2");
    }

    #[test]
    fn same_name_picks_never_overwrite_and_get_sequential_suffixes() {
        let dir = workspace("collide");
        let src_dir = dir.join("src");
        let dest = dir.join("picked");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let src = src_dir.join("photo.jpg");

        let mut created = Vec::new();
        for i in 0..3u8 {
            fs::write(&src, [i]).unwrap();
            created.push(copy_with_unique_name(&src, &dest).unwrap());
        }

        let names: Vec<_> = created
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["photo.jpg", "photo_1.jpg", "photo_2.jpg"]);
        for (i, p) in created.iter().enumerate() {
            assert_eq!(fs::read(p).unwrap(), [i as u8], "内容が上書きされていない");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_skips_over_pre_existing_numbered_files() {
        let dir = workspace("gap");
        let dest = dir.join("picked");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a.png"), b"x").unwrap();
        fs::write(dest.join("a_1.png"), b"y").unwrap();
        let src = dir.join("a.png");
        fs::write(&src, b"new").unwrap();

        let out = copy_with_unique_name(&src, &dest).unwrap();
        assert_eq!(out.file_name().unwrap(), "a_2.png");
        assert_eq!(fs::read(dest.join("a.png")).unwrap(), b"x");
        assert_eq!(fs::read(dest.join("a_1.png")).unwrap(), b"y");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_of_missing_source_fails_and_leaves_no_partial_file() {
        let dir = workspace("missing");
        let dest = dir.join("picked");
        fs::create_dir_all(&dest).unwrap();
        assert!(copy_with_unique_name(&dir.join("nope.jpg"), &dest).is_err());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_picked_media_includes_videos_and_ignores_other_files() {
        let dir = workspace("list");
        for name in ["b.JPG", "a.mp4", "c.webm", "d.txt", "e"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        fs::create_dir_all(dir.join("sub.png")).unwrap(); // 拡張子付きディレクトリは除く
        let listed = list_picked_media(&dir).unwrap();
        let names: Vec<_> = listed
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(names, ["a.mp4", "b.JPG", "c.webm"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn list_excludes_symlinks_even_when_they_point_to_media_files() {
        let dir = workspace("list_symlink");
        let outside = dir.join("outside.jpg");
        fs::write(&outside, b"x").unwrap();
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        fs::write(picked.join("real.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, picked.join("link.jpg")).unwrap();
        std::os::unix::fs::symlink(dir.join("nowhere.jpg"), picked.join("dangling.jpg")).unwrap();
        let listed = list_picked_media(&picked).unwrap();
        let names: Vec<_> = listed
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(names, ["real.jpg"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn numbered_file_name_keeps_non_utf8_names_intact() {
        use std::os::unix::ffi::OsStrExt;
        let raw = OsStr::from_bytes(b"caf\xe9.jpg"); // Latin-1 の é（UTF-8 として不正）
        assert_eq!(numbered_file_name(raw, 0).as_bytes(), b"caf\xe9.jpg");
        assert_eq!(numbered_file_name(raw, 1).as_bytes(), b"caf\xe9_1.jpg");
    }

    #[test]
    fn copy_preserves_source_modified_time() {
        let dir = workspace("mtime");
        let dest = dir.join("picked");
        fs::create_dir_all(&dest).unwrap();
        let src = dir.join("old.jpg");
        fs::write(&src, b"data").unwrap();
        let past =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(&src)
            .unwrap()
            .set_modified(past)
            .unwrap();

        let first = copy_with_unique_name(&src, &dest).unwrap();
        let second = copy_with_unique_name(&src, &dest).unwrap();
        for copied in [first, second] {
            assert_eq!(fs::metadata(&copied).unwrap().modified().unwrap(), past);
            assert_eq!(fs::read(&copied).unwrap(), b"data");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_target_inside_picked_dir_is_accepted() {
        let dir = workspace("del_ok");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        let file = picked.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        assert_eq!(validate_picked_delete_target(&file, &picked).unwrap(), file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_target_outside_picked_dir_is_rejected() {
        let dir = workspace("del_out");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        let outside = dir.join("outside.jpg");
        fs::write(&outside, b"x").unwrap();
        assert!(validate_picked_delete_target(&outside, &picked).is_err());
        // 兄弟ディレクトリが接頭辞を共有していても（picked と picked2）拒否する。
        let sibling = dir.join("picked2");
        fs::create_dir_all(&sibling).unwrap();
        let sibling_file = sibling.join("a.jpg");
        fs::write(&sibling_file, b"x").unwrap();
        assert!(validate_picked_delete_target(&sibling_file, &picked).is_err());
        assert!(outside.exists() && sibling_file.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_target_with_dotdot_traversal_is_rejected() {
        let dir = workspace("del_dotdot");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        fs::write(dir.join("secret.jpg"), b"x").unwrap();
        let sneaky = picked.join("..").join("secret.jpg");
        assert!(validate_picked_delete_target(&sneaky, &picked).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_target_dir_itself_missing_files_and_non_media_are_rejected() {
        let dir = workspace("del_misc");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        assert!(validate_picked_delete_target(&picked, &picked).is_err());
        assert!(validate_picked_delete_target(&picked.join("gone.jpg"), &picked).is_err());
        let text = picked.join("note.txt");
        fs::write(&text, b"x").unwrap();
        assert!(validate_picked_delete_target(&text, &picked).is_err());
        // ピックフォルダ自体が無い場合も拒否（パニックしない）。
        assert!(validate_picked_delete_target(&text, &dir.join("nodir")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn delete_target_symlink_pointing_outside_picked_dir_is_rejected() {
        let dir = workspace("del_symlink");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        let victim = dir.join("victim.jpg");
        fs::write(&victim, b"x").unwrap();
        let link = picked.join("link.jpg");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        assert!(validate_picked_delete_target(&link, &picked).is_err());
        assert!(victim.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- 独立QA観点表からの追加テスト（#67） ----

    #[test]
    fn numbered_file_name_handles_dotfiles_multi_dots_and_keeps_extension_case() {
        // ドットファイルは「拡張子なし」扱い（stem 全体に連番）。
        assert_eq!(numbered_file_name(OsStr::new(".hidden"), 1), ".hidden_1");
        // 複数ドットは最後のドットだけが拡張子。
        assert_eq!(numbered_file_name(OsStr::new("a.tar.gz"), 1), "a.tar_1.gz");
        // 拡張子の大文字小文字は保つ。
        assert_eq!(numbered_file_name(OsStr::new("A.JPG"), 1), "A_1.JPG");
    }

    #[test]
    fn extensionless_file_copied_twice_gets_noext_then_noext_1_without_trailing_dot() {
        let dir = workspace("noext");
        let dest = dir.join("picked");
        fs::create_dir_all(&dest).unwrap();
        let src = dir.join("noext");
        fs::write(&src, b"data").unwrap();

        let first = copy_with_unique_name(&src, &dest).unwrap();
        let second = copy_with_unique_name(&src, &dest).unwrap();
        assert_eq!(first.file_name().unwrap(), "noext");
        assert_eq!(second.file_name().unwrap(), "noext_1");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 連番は「一番若い空き番号」から埋める（a.png と a_2.png があるなら a_1.png）。
    /// 空きを飛ばして最大値+1 にはしない現在の挙動を固定する。
    #[test]
    fn numbering_fills_the_lowest_free_slot_before_skipping_ahead() {
        let dir = workspace("fill_gap");
        let dest = dir.join("picked");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a.png"), b"x").unwrap();
        fs::write(dest.join("a_2.png"), b"y").unwrap();
        let src = dir.join("a.png");
        fs::write(&src, b"new").unwrap();

        let out = copy_with_unique_name(&src, &dest).unwrap();
        assert_eq!(out.file_name().unwrap(), "a_1.png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn eight_threads_copying_the_same_name_create_eight_distinct_files_without_overwrite() {
        let dir = workspace("threads");
        let dest = dir.join("picked");
        fs::create_dir_all(&dest).unwrap();

        // 各スレッドは別ディレクトリの同名ファイル（中身は別）をピックする。
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let src_dir = dir.join(format!("src{i}"));
                fs::create_dir_all(&src_dir).unwrap();
                let src = src_dir.join("same.jpg");
                fs::write(&src, [i]).unwrap();
                let dest = dest.clone();
                std::thread::spawn(move || copy_with_unique_name(&src, &dest).unwrap())
            })
            .collect();
        let created: Vec<PathBuf> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let unique: std::collections::HashSet<_> = created.iter().collect();
        assert_eq!(unique.len(), 8, "全員が別のファイル名: {created:?}");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 8);
        let mut contents: Vec<u8> = created.iter().map(|p| fs::read(p).unwrap()[0]).collect();
        contents.sort();
        assert_eq!(
            contents,
            (0..8u8).collect::<Vec<_>>(),
            "どの中身も上書きで失われない"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_includes_uppercase_and_webp_tif_and_excludes_avi_mkv() {
        let dir = workspace("list_ext");
        for name in [
            "a.MP4", "b.WebP", "c.TIF", "d.m4v", "e.OGV", // 含む
            "f.avi", "g.mkv", "h.flv", "i.wmv", // scanner の定義に無いので除外
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        let listed = list_picked_media(&dir).unwrap();
        let mut names: Vec<_> = listed
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        names.sort();
        assert_eq!(names, ["a.MP4", "b.WebP", "c.TIF", "d.m4v", "e.OGV"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_target_with_uppercase_extension_is_accepted() {
        let dir = workspace("del_upper");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        for name in ["A.JPG", "B.MP4"] {
            let file = picked.join(name);
            fs::write(&file, b"x").unwrap();
            assert_eq!(validate_picked_delete_target(&file, &picked).unwrap(), file);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn delete_target_reached_through_a_directory_symlink_to_outside_is_rejected() {
        let dir = workspace("del_dirlink");
        let picked = dir.join("picked");
        let outside = dir.join("outside");
        fs::create_dir_all(&picked).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let victim = outside.join("victim.jpg");
        fs::write(&victim, b"x").unwrap();
        // picked/linkdir -> outside。picked/linkdir/victim.jpg は文字列上は picked 内だが実体は外。
        std::os::unix::fs::symlink(&outside, picked.join("linkdir")).unwrap();
        let sneaky = picked.join("linkdir").join("victim.jpg");
        assert!(validate_picked_delete_target(&sneaky, &picked).is_err());
        assert!(victim.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn delete_target_dangling_symlink_is_rejected() {
        let dir = workspace("del_dangling");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        let link = picked.join("dangling.jpg");
        std::os::unix::fs::symlink(dir.join("nowhere.jpg"), &link).unwrap();
        assert!(validate_picked_delete_target(&link, &picked).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_target_empty_path_is_rejected_without_panic() {
        let dir = workspace("del_empty");
        let picked = dir.join("picked");
        fs::create_dir_all(&picked).unwrap();
        assert!(validate_picked_delete_target(Path::new(""), &picked).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 現状固定: ピックフォルダ内のサブフォルダにあるメディアファイルも削除を許可する
    /// （検証は「canonical パスがピックフォルダ配下」であることだけ。直下限定ではない）。
    /// 一覧（`list_picked_media`）は直下しか返さないので、UI からは通常到達しない。
    #[test]
    fn delete_target_in_a_subfolder_of_picked_dir_is_currently_accepted() {
        let dir = workspace("del_subfolder");
        let picked = dir.join("picked");
        let sub = picked.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("nested.jpg");
        fs::write(&file, b"x").unwrap();
        assert_eq!(validate_picked_delete_target(&file, &picked).unwrap(), file);
        let _ = fs::remove_dir_all(&dir);
    }
}
