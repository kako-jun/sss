//! 画像最適化キャッシュを作る単一ワーカースレッド（#60）。
//!
//! 旧実装は `get_next_image` / 先読み1件ごとに `thread::spawn` していたため、
//! キーリピート等で数十本のスレッドが同時に巨大画像をフルデコード＋Lanczos3する
//! 事故があった。ここでは常駐スレッド1本＋キューに置き換え、以下を保証する。
//!
//! - スレッド数は常に1本（連打してもメモリ・スレッド数が有界）
//! - 同じキャッシュファイルへの要求は重複排除する
//! - 現在表示中の画像の要求は先読み要求より優先して処理する
//! - 新しい先読みバッチが来たら、古い世代の先読み要求（現在画像分は除く）は破棄する
//! - 書き込みは一時ファイル→rename でアトミックに行う
//! - 累積サイズが上限を超えたら mtime の古いものから削除する（LRU相当）

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use crate::image_processor::optimize_image_for_4k;

/// キャッシュ全体の上限バイト数（既定 2GB）。超過分は古いものから削除する。
pub const CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone)]
struct Job {
    source_path: PathBuf,
    cache_file: PathBuf,
    apply_rotation: bool,
    /// 現在表示中の画像の要求か（true なら先読みより優先して処理する）
    is_current: bool,
}

struct Queue {
    jobs: VecDeque<Job>,
    /// 重複排除用: 現在キューに載っている cache_file の集合
    queued: HashSet<PathBuf>,
}

/// 画像最適化キャッシュを直列に作る常駐ワーカー。
pub struct CacheWorker {
    state: Arc<(Mutex<Queue>, Condvar)>,
}

impl CacheWorker {
    /// ワーカースレッドを1本起動する。
    pub fn spawn(cache_dir: PathBuf) -> Self {
        let state = Arc::new((
            Mutex::new(Queue {
                jobs: VecDeque::new(),
                queued: HashSet::new(),
            }),
            Condvar::new(),
        ));

        let worker_state = Arc::clone(&state);
        thread::spawn(move || Self::run(worker_state, cache_dir));

        CacheWorker { state }
    }

    fn run(state: Arc<(Mutex<Queue>, Condvar)>, cache_dir: PathBuf) {
        let (lock, cvar) = &*state;
        let mut writes_since_check: u64 = 0;

        loop {
            let job = {
                let mut queue = lock.lock().unwrap_or_else(|e| e.into_inner());
                while queue.jobs.is_empty() {
                    queue = cvar.wait(queue).unwrap_or_else(|e| e.into_inner());
                }
                // 現在画像の要求があれば優先的に取り出す。無ければ先読みの先頭(FIFO)。
                let idx = queue.jobs.iter().position(|j| j.is_current).unwrap_or(0);
                let job = queue.jobs.remove(idx).expect("queue was non-empty");
                queue.queued.remove(&job.cache_file);
                job
            };

            if job.cache_file.exists() {
                continue;
            }

            match optimize_image_for_4k(&job.source_path, job.apply_rotation) {
                Ok(bytes) => {
                    if let Err(e) = write_atomic(&job.cache_file, &bytes) {
                        eprintln!("cache worker: failed to write {:?}: {e}", job.cache_file);
                        continue;
                    }
                    writes_since_check += 1;
                    // 毎回ディレクトリ全体を走査するのは無駄なので、ある程度書いたら
                    // まとめて上限チェックする（数千枚規模のキャッシュ想定）。
                    if writes_since_check >= 20 {
                        writes_since_check = 0;
                        if let Err(e) = enforce_cache_limit(&cache_dir, CACHE_MAX_BYTES) {
                            eprintln!("cache worker: failed to enforce cache limit: {e}");
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "cache worker: failed to optimize {:?}: {e}",
                        job.source_path
                    );
                }
            }
        }
    }

    /// 現在表示中の画像のキャッシュ作成を要求する（先読みより優先）。
    /// 既に同じ cache_file がキューにあれば優先度を current に引き上げるだけ。
    pub fn request_current(&self, source_path: PathBuf, cache_file: PathBuf, apply_rotation: bool) {
        if cache_file.exists() {
            return;
        }

        let (lock, cvar) = &*self.state;
        let mut queue = lock.lock().unwrap_or_else(|e| e.into_inner());

        if let Some(existing) = queue.jobs.iter_mut().find(|j| j.cache_file == cache_file) {
            existing.is_current = true;
        } else {
            queue.queued.insert(cache_file.clone());
            queue.jobs.push_back(Job {
                source_path,
                cache_file,
                apply_rotation,
                is_current: true,
            });
        }
        cvar.notify_one();
    }

    /// 先読みバッチを要求する。古い世代の先読み要求（is_current でないもの）は
    /// このバッチが来た時点で破棄する（#60: 「重複排除・世代番号で古い先読み要求を破棄」）。
    pub fn request_prefetch(&self, items: Vec<(PathBuf, PathBuf)>, apply_rotation: bool) {
        let (lock, cvar) = &*self.state;
        let mut queue = lock.lock().unwrap_or_else(|e| e.into_inner());

        // 破棄対象は「現在画像ではない」既存ジョブ全て。
        // jobs と queued を同時に可変借用するため、スコープを区切って分割する。
        {
            let Queue { jobs, queued } = &mut *queue;
            jobs.retain(|j| {
                if j.is_current {
                    true
                } else {
                    queued.remove(&j.cache_file);
                    false
                }
            });
        }

        for (source_path, cache_file) in items {
            if cache_file.exists() || queue.queued.contains(&cache_file) {
                continue;
            }
            queue.queued.insert(cache_file.clone());
            queue.jobs.push_back(Job {
                source_path,
                cache_file,
                apply_rotation,
                is_current: false,
            });
        }

        cvar.notify_one();
    }
}

/// 一時ファイルに書いてから rename する（同一ディレクトリ内なのでアトミック）。
/// これにより `exists()` が書込途中のファイルを返すことがなくなる。
fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "cache".to_string());
    let tmp_name = format!(".{file_name}.tmp-{}", std::process::id());
    let tmp_path = dest.with_file_name(tmp_name);

    std::fs::write(&tmp_path, bytes)?;
    std::fs::rename(&tmp_path, dest)
}

/// キャッシュディレクトリの合計サイズが `max_bytes` を超えていたら、
/// 更新日時が古いファイルから削除して上限内に収める（LRU相当）。
/// 書込途中の一時ファイル（`.{name}.tmp-*`）は対象外にする。
pub fn enforce_cache_limit(cache_dir: &Path, max_bytes: u64) -> std::io::Result<()> {
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;

    for entry in std::fs::read_dir(cache_dir)?.flatten() {
        let path = entry.path();
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name.starts_with('.') && file_name.contains(".tmp-") {
            continue; // 書込中の一時ファイルは走査対象外
        }

        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                total += size;
                entries.push((path, size, modified));
            }
        }
    }

    if total <= max_bytes {
        return Ok(());
    }

    // 古いものから削除
    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn workspace(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sss_cache_worker_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_produces_final_file_without_leaving_tmp() {
        let dir = workspace("atomic");
        let dest = dir.join("out.jpg");

        write_atomic(&dest, b"hello").unwrap();

        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        // ディレクトリに tmp ファイルが残っていない
        let leftover_tmp = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!leftover_tmp);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enforce_cache_limit_evicts_oldest_first() {
        let dir = workspace("evict");

        // 3ファイル、各10バイト。上限を15バイトにすると1ファイルだけ残る。
        for (name, sleep_ms) in [("a.jpg", 0u64), ("b.jpg", 10), ("c.jpg", 20)] {
            std::fs::write(dir.join(name), b"0123456789").unwrap();
            thread::sleep(Duration::from_millis(sleep_ms.max(1)));
        }

        enforce_cache_limit(&dir, 15).unwrap();

        let remaining: HashSet<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        // 最も新しい c.jpg だけが生き残るはず（合計10バイト <= 15バイト）
        assert!(
            remaining.contains("c.jpg"),
            "最新ファイルは残るはず: {remaining:?}"
        );
        assert!(
            !remaining.contains("a.jpg"),
            "最古のファイルは削除されるはず: {remaining:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enforce_cache_limit_ignores_tmp_files() {
        let dir = workspace("ignore_tmp");
        std::fs::write(dir.join(".x.jpg.tmp-1"), vec![0u8; 100]).unwrap();

        // 上限0でも tmp ファイルは対象外なので削除されない
        enforce_cache_limit(&dir, 0).unwrap();
        assert!(dir.join(".x.jpg.tmp-1").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_current_upgrades_existing_prefetch_priority() {
        let cache_dir = workspace("priority");
        let worker_state = Arc::new((
            Mutex::new(Queue {
                jobs: VecDeque::new(),
                queued: HashSet::new(),
            }),
            Condvar::new(),
        ));
        let worker = CacheWorker {
            state: worker_state,
        };

        let cache_file = cache_dir.join("abc.jpg");
        worker.request_prefetch(
            vec![(PathBuf::from("/tmp/source.jpg"), cache_file.clone())],
            true,
        );
        worker.request_current(PathBuf::from("/tmp/source.jpg"), cache_file.clone(), true);

        let (lock, _) = &*worker.state;
        let queue = lock.lock().unwrap();
        assert_eq!(queue.jobs.len(), 1, "重複排除で1件のままのはず");
        assert!(queue.jobs[0].is_current, "current 優先度に昇格しているはず");

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    #[test]
    fn request_prefetch_drops_stale_generation_but_keeps_current() {
        let cache_dir = workspace("stale");
        let worker_state = Arc::new((
            Mutex::new(Queue {
                jobs: VecDeque::new(),
                queued: HashSet::new(),
            }),
            Condvar::new(),
        ));
        let worker = CacheWorker {
            state: worker_state,
        };

        let current_cache = cache_dir.join("current.jpg");
        worker.request_current(
            PathBuf::from("/tmp/current.jpg"),
            current_cache.clone(),
            true,
        );

        let old_prefetch = cache_dir.join("old.jpg");
        worker.request_prefetch(
            vec![(PathBuf::from("/tmp/old.jpg"), old_prefetch.clone())],
            true,
        );

        let new_prefetch = cache_dir.join("new.jpg");
        worker.request_prefetch(
            vec![(PathBuf::from("/tmp/new.jpg"), new_prefetch.clone())],
            true,
        );

        let (lock, _) = &*worker.state;
        let queue = lock.lock().unwrap();
        let cache_files: Vec<&PathBuf> = queue.jobs.iter().map(|j| &j.cache_file).collect();

        assert!(
            cache_files.contains(&&current_cache),
            "現在画像の要求は残るはず"
        );
        assert!(
            !cache_files.contains(&&old_prefetch),
            "古い世代の先読みは破棄されるはず"
        );
        assert!(
            cache_files.contains(&&new_prefetch),
            "新しい先読みは残るはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }
}
