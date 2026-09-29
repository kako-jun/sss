//! ピック機能（お気に入りをピックフォルダへコピー・一覧・削除）のファイルシステム処理（#67）。
//!
//! Tauri コマンド（`commands::file_operations`）から切り出した、状態を持たない関数群。
//! 「同名衝突時の連番」「一覧に出す拡張子」「削除してよいパスの検証」を単体テストできる
//! ようにするのが目的。

use crate::scanner::is_media_path;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// 連番の探索上限。実運用では届かない（同名を1万回ピックした場合のみ）。
const MAX_COLLISION_INDEX: u32 = 10_000;

/// 同名衝突時のファイル名。`n == 0` は元の名前、`n >= 1` は `stem_n.ext`
/// （拡張子が無ければ `stem_n`。旧実装は拡張子なしで `stem_ts.` と末尾ドットを付けていた）。
pub fn numbered_file_name(file_name: &OsStr, n: u32) -> String {
    let path = Path::new(file_name);
    if n == 0 {
        return file_name.to_string_lossy().to_string();
    }
    let stem = path.file_stem().unwrap_or(file_name).to_string_lossy();
    match path.extension() {
        Some(ext) => format!("{stem}_{n}.{}", ext.to_string_lossy()),
        None => format!("{stem}_{n}"),
    }
}

/// `source` を `dest_dir` にコピーし、実際に作られたパスを返す。
///
/// 同名ファイルが既にある場合は `name_1.ext`, `name_2.ext` ... と連番を付ける。以前は
/// 秒単位のタイムスタンプを付けていたため、同じ秒に同じ名前を2回ピックすると
/// 上書きされていた。`create_new` で「存在しなければ作成」を原子的に行うので、
/// 存在確認と作成の間に割り込まれても既存ファイルは決して上書きしない。
pub fn copy_with_unique_name(source: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let file_name = source.file_name().ok_or("Failed to get file name")?;

    for n in 0..=MAX_COLLISION_INDEX {
        let dest = dest_dir.join(numbered_file_name(file_name, n));
        let mut dest_file = match OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to copy file: {e}")),
        };
        let copied = fs::File::open(source).and_then(|mut src| io::copy(&mut src, &mut dest_file));
        return match copied {
            Ok(_) => Ok(dest),
            Err(e) => {
                drop(dest_file);
                let _ = fs::remove_file(&dest);
                Err(format!("Failed to copy file: {e}"))
            }
        };
    }
    Err("Too many files with the same name in the picked directory".to_string())
}

/// ピックフォルダ直下のメディアファイル（画像＋動画。スキャナと同じ拡張子定義）の一覧。
pub fn list_picked_media(picked_dir: &Path) -> Result<Vec<String>, String> {
    let mut items: Vec<String> = Vec::new();
    let entries = fs::read_dir(picked_dir).map_err(|e| format!("Failed to read directory: {e}"))?;
    for entry in entries {
        let path = entry
            .map_err(|e| format!("Failed to read entry: {e}"))?
            .path();
        if path.is_file() && is_media_path(&path) {
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
}
