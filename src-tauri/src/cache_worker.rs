//! 画像最適化キャッシュを作る単一ワーカースレッド（#60）。
//!
//! 旧実装は `get_next_image` / 先読み1件ごとに `thread::spawn` していたため、
//! キーリピート等で数十本のスレッドが同時に巨大画像をフルデコード＋Lanczos3する
//! 事故があった。ここでは常駐スレッド1本＋キューに置き換え、以下を保証する。
//!
//! - スレッド数は常に1本（連打してもメモリ・スレッド数が有界）
//! - 同じキャッシュファイルへの要求は重複排除する
//! - 現在表示中の画像の要求は先読み要求より優先して処理する。新しい current 要求が
//!   来たら、それまでの current 要求は先読み優先度へ格下げする（同時に「現在画像」は
//!   1件だけという前提を保つ。レビュー must3）
//! - 新しい先読みバッチが来たら、古い世代の先読み要求（現在画像分は除く）は破棄する
//! - 書き込みは一時ファイル→rename でアトミックに行う
//! - 累積サイズが上限を超えたら mtime の古いものから削除する。ただし直近に実際へ
//!   返した（表示に使われた）パスは削除対象から除外し、mtime も参照時に更新する
//!   （レビュー must4: 生成順=FIFOの巻き添え削除を防ぎ、真の LRU に近づける）
//! - WebView が直接表示できない形式（TIFF等）、および apply_rotation=false なのに
//!   EXIF Orientation が回転を要求している画像は、原本をそのまま返すと表示が誤る
//!   （前者はそもそも表示できず、後者はWebView既定のfrom-imageが勝手に回転してしまう）
//!   ため、`request_current_and_wait` で変換完了を待ってからキャッシュパスを返す
//!   （レビュー1巡目 must2、2巡目 must B）
//! - 変換に失敗した画像は失敗セットに記録し、同じキャッシュキーの再要求を抑止する
//!   （レビュー must7）
//! - ジョブ処理は `catch_unwind` で囲み、image crate 内の panic でワーカースレッド
//!   自体が死なないようにする（レビュー must6）
//!
//! 実装上の注意（レビュー2巡目 must A / should(1)）:
//! - `mark_served` のmtime更新は `OpenOptions::new().append(true)` で書込アクセスを
//!   要求してから `set_modified` を呼ぶ（Windows では `set_modified` に
//!   `FILE_WRITE_ATTRIBUTES` 相当の書込アクセス権が必要で、読み取り専用オープンでは
//!   失敗しうるため）。
//! - `request_current_and_wait` の待ち手は `queue` ロックを保持したまま
//!   `exists()`/失敗セットを確認してから `wait_timeout` を呼ぶ。ワーカー側も
//!   `completed.notify_all()` を呼ぶ前に同じ `queue` ロックを取得する。これにより
//!   「確認とwait開始の間に通知が来て待ちそびれる」古典的な lost wakeup を避ける。
//!
//! 既知の制約（レビュー2巡目 should(3)）: ワーカーは単一スレッドで非プリエンプティブ
//! なため、`request_current_and_wait` 呼び出し時にワーカーが既に別の重い先読みジョブを
//! 処理中だと、その先読みが終わるまで新しい current 要求（TIFF等）は着手されない。
//! 巨大な先読み画像の処理中に呼ばれた場合、`CACHE_WAIT_TIMEOUT`（既定5秒）を
//! 使い切ってタイムアウトする可能性がある。

use std::collections::{HashSet, VecDeque};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::image_processor::optimize_image_for_4k;

/// キャッシュ全体の上限バイト数（既定 2GB）。超過分は古いものから削除する。
pub const CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// `request_current_and_wait` のデフォルトタイムアウト。
pub const CACHE_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// enforce_cache_limit の削除対象から除外する「直近に実際へ返したパス」の保持件数。
const RECENTLY_SERVED_CAPACITY: usize = 8;

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

struct Shared {
    queue: Mutex<Queue>,
    /// キューに新しいジョブが積まれたことの通知
    has_work: Condvar,
    /// ジョブが1件処理し終わった（成功/失敗いずれも）ことの通知。
    /// `request_current_and_wait` はこれを待って `exists()`/失敗セットを再確認する。
    completed: Condvar,
    /// 直近に実際へ返した（表示に使われた）cache_file。enforce_cache_limit の削除対象外。
    recently_served: Mutex<VecDeque<PathBuf>>,
    /// 変換に失敗した cache_file の集合。同じキーの再要求を抑止する（must7）。
    failed: Mutex<HashSet<PathBuf>>,
}

/// 画像最適化キャッシュを直列に作る常駐ワーカー。
/// `Clone` は内部の `Arc<Shared>` の複製のみで、同じワーカー/キューを指し続ける
/// （軽量。`tauri::async_runtime::spawn_blocking` へ渡す `'static` クロージャへ
/// 持ち込むために使う。レビュー2巡目 should(2)）。
#[derive(Clone)]
pub struct CacheWorker {
    shared: Arc<Shared>,
}

impl CacheWorker {
    /// ワーカースレッドを1本起動する。
    pub fn spawn(cache_dir: PathBuf) -> Self {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                jobs: VecDeque::new(),
                queued: HashSet::new(),
            }),
            has_work: Condvar::new(),
            completed: Condvar::new(),
            recently_served: Mutex::new(VecDeque::new()),
            failed: Mutex::new(HashSet::new()),
        });

        let worker_shared = Arc::clone(&shared);
        thread::spawn(move || Self::run(worker_shared, cache_dir));

        CacheWorker { shared }
    }

    fn run(shared: Arc<Shared>, cache_dir: PathBuf) {
        let mut writes_since_check: u64 = 0;

        loop {
            let job = {
                let mut queue = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
                while queue.jobs.is_empty() {
                    queue = shared
                        .has_work
                        .wait(queue)
                        .unwrap_or_else(|e| e.into_inner());
                }
                // 現在画像の要求があれば優先的に取り出す。無ければ先読みの先頭(FIFO)。
                // must3 の格下げにより is_current な要求は常に高々1件のはず。
                let idx = queue.jobs.iter().position(|j| j.is_current).unwrap_or(0);
                let job = queue.jobs.remove(idx).expect("queue was non-empty");
                queue.queued.remove(&job.cache_file);
                job
            };

            if job.cache_file.exists() {
                notify_completed(&shared);
                continue;
            }

            // must6: image crate 内の panic でワーカースレッドごと死なないように囲む。
            let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
                optimize_image_for_4k(&job.source_path, job.apply_rotation)
            }));

            match outcome {
                Ok(Ok(bytes)) => match write_atomic(&job.cache_file, &bytes) {
                    Ok(()) => {
                        writes_since_check += 1;
                        // 毎回ディレクトリ全体を走査するのは無駄なので、ある程度書いたら
                        // まとめて上限チェックする（数千枚規模のキャッシュ想定）。
                        // 注意: このチェック間隔の間は理論上 CACHE_MAX_BYTES を一時的に
                        // 超過しうる（次のチェックまで削除されない）。
                        if writes_since_check >= 20 {
                            writes_since_check = 0;
                            let exclude = {
                                let recent = shared
                                    .recently_served
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                recent.iter().cloned().collect::<HashSet<_>>()
                            };
                            if let Err(e) =
                                enforce_cache_limit(&cache_dir, CACHE_MAX_BYTES, &exclude)
                            {
                                eprintln!("cache worker: failed to enforce cache limit: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("cache worker: failed to write {:?}: {e}", job.cache_file);
                        mark_failed(&shared, &job.cache_file);
                    }
                },
                Ok(Err(e)) => {
                    eprintln!(
                        "cache worker: failed to optimize {:?}: {e}",
                        job.source_path
                    );
                    mark_failed(&shared, &job.cache_file);
                }
                Err(_panic) => {
                    eprintln!(
                        "cache worker: panicked while optimizing {:?} (recovered, worker continues)",
                        job.source_path
                    );
                    mark_failed(&shared, &job.cache_file);
                }
            }

            notify_completed(&shared);
        }
    }

    /// 現在表示中の画像のキャッシュ作成を要求する（先読みより優先）。
    /// 既に同じ cache_file がキューにあれば優先度を current に引き上げるだけ。
    /// それ以外の既存 current 要求は先読み優先度へ格下げする（must3: 「現在画像」は
    /// 常に1件だけのはずで、古い current が居座って最新が後回しになるのを防ぐ）。
    /// 既に失敗済み（`failed` セット）のキーは再要求しない（must7）。
    pub fn request_current(&self, source_path: PathBuf, cache_file: PathBuf, apply_rotation: bool) {
        if cache_file.exists() {
            return;
        }
        if self.is_failed(&cache_file) {
            return;
        }

        let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());

        for j in queue.jobs.iter_mut() {
            if j.cache_file != cache_file {
                j.is_current = false;
            }
        }

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
        self.shared.has_work.notify_one();
    }

    /// 現在画像として要求しつつ、キャッシュが出来上がる（か失敗・タイムアウトする）まで
    /// 待つ（must2）。WebView が直接表示できない形式（TIFF等）は原本を返せないため、
    /// 呼び出し側はこれで変換完了を待ってからキャッシュパスを使う。
    ///
    /// 戻り値: `cache_file` が実際に存在するようになった（成功した）かどうか。
    pub fn request_current_and_wait(
        &self,
        source_path: PathBuf,
        cache_file: PathBuf,
        apply_rotation: bool,
        timeout: Duration,
    ) -> bool {
        if cache_file.exists() {
            return true;
        }
        if self.is_failed(&cache_file) {
            return false;
        }

        self.request_current(source_path, cache_file.clone(), apply_rotation);

        let deadline = Instant::now() + timeout;
        // must A/should(1): 「確認」から「wait開始」までロックを保持し続けることで、
        // その間にワーカーが完了・notify_all してしまい待ちそびれる（lost wakeup）
        // 事故を防ぐ。ワーカー側（notify_completed）も同じ queue ロックを取ってから
        // 通知するため、ここでロックを取れた時点で「直前の完了」は必ず反映されている。
        let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if cache_file.exists() {
                return true;
            }
            if self.is_failed(&cache_file) {
                return false;
            }

            let now = Instant::now();
            if now >= deadline {
                return cache_file.exists();
            }

            let (guard, _timeout_result) = self
                .shared
                .completed
                .wait_timeout(queue, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            queue = guard;
        }
    }

    /// 先読みバッチを要求する。古い世代の先読み要求（is_current でないもの）は
    /// このバッチが来た時点で破棄する（#60: 「重複排除・世代番号で古い先読み要求を破棄」）。
    /// 失敗済み（`failed` セット）のキーはキューへ積まない（must7）。
    pub fn request_prefetch(&self, items: Vec<(PathBuf, PathBuf)>, apply_rotation: bool) {
        let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());

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

        let failed = self.shared.failed.lock().unwrap_or_else(|e| e.into_inner());
        for (source_path, cache_file) in items {
            if cache_file.exists()
                || queue.queued.contains(&cache_file)
                || failed.contains(&cache_file)
            {
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
        drop(failed);

        self.shared.has_work.notify_one();
    }

    /// キャッシュヒットで実際にフロントへ返したパスを記録する（must4）。
    /// - mtime を現在時刻へ更新する（真の LRU に近づける。生成時刻のままだと
    ///   実質 FIFO 削除になってしまうため）
    /// - 直近 `RECENTLY_SERVED_CAPACITY` 件は enforce_cache_limit の削除対象から除外する
    ///   （表示中/直近表示分がバックグラウンドの削除と競合して消えるのを防ぐ）
    pub fn mark_served(&self, cache_file: PathBuf) {
        // must A: 読み取り専用オープンだと Windows で set_modified に必要な
        // FILE_WRITE_ATTRIBUTES 相当の権限が無く失敗しうる。append(true) は
        // ファイルを truncate/作成せずに書込アクセスだけ要求できる。
        if let Ok(file) = std::fs::OpenOptions::new().append(true).open(&cache_file) {
            let _ = file.set_modified(SystemTime::now());
        }

        let mut recent = self
            .shared
            .recently_served
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        recent.retain(|p| p != &cache_file);
        recent.push_back(cache_file);
        while recent.len() > RECENTLY_SERVED_CAPACITY {
            recent.pop_front();
        }
    }

    fn is_failed(&self, cache_file: &Path) -> bool {
        self.shared
            .failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(cache_file)
    }

    /// 失敗セットを空にする（nit: `reset_all_data` でキャッシュを丸ごと作り直す際に、
    /// 過去の失敗記録が居座って以後ずっと再試行されなくなるのを防ぐ）。
    pub fn clear_failed(&self) {
        self.shared
            .failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

fn mark_failed(shared: &Shared, cache_file: &Path) {
    shared
        .failed
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(cache_file.to_path_buf());
}

/// `completed` を通知する前に `queue` ロックを取得する（must A/should(1)）。
/// `request_current_and_wait` の待ち手も同じロックを保持したまま
/// 確認→wait を行うため、これで lost wakeup を防げる。
fn notify_completed(shared: &Shared) {
    let _queue = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
    shared.completed.notify_all();
}

/// キャッシュディレクトリをクリアする（起動時・`reset_all_data` 共通の手順）。
///
/// `cache_dir` を退避ディレクトリ（`app_data_dir` 直下の `cache-trash-<timestamp>`）へ
/// rename してから空の `cache_dir` を再作成し、退避先の削除はバックグラウンドスレッドに
/// 任せる（レビュー must5）。rename はディレクトリエントリの付け替えのみで中身のコピーを
/// 伴わないため、キャッシュが巨大でも一瞬で終わり、この直後に動く `CacheWorker` の新規
/// 書込と競合しない。
///
/// rename が失敗した場合（例: cache_dir が別ファイルシステム上にある等）は、中身を
/// 1件ずつ同期的に削除するフォールバックを行う（失敗した項目は無視して続行。
/// レビュー2巡目 should(5)）。このフォールバックは rename が使えたときの高速性・
/// 無競合性を再現できない既知の劣化経路であり、rename が失敗するような通常想定外の
/// 環境でのみ発生する。
///
/// 加えて、`app_data_dir` 直下に前回以前の実行で消しきれなかった古い `cache-trash-*`
/// が残っていれば、まとめてバックグラウンドで削除する（アプリがクラッシュする等で
/// 削除スレッドが完走できなかった場合の掃除。レビュー2巡目 should(4)）。
pub fn clear_cache_dir(app_data_dir: &Path, cache_dir: &Path) {
    sweep_stale_trash_dirs(app_data_dir);

    if cache_dir.exists() {
        let trash_dir = app_data_dir.join(format!(
            "cache-trash-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        match std::fs::rename(cache_dir, &trash_dir) {
            Ok(()) => {
                std::thread::spawn(move || {
                    if let Err(e) = std::fs::remove_dir_all(&trash_dir) {
                        eprintln!("Failed to remove cache trash {}: {e}", trash_dir.display());
                    }
                });
            }
            Err(e) => {
                eprintln!(
                    "Failed to move cache directory to trash ({e}); falling back to per-entry delete"
                );
                clear_directory_contents(cache_dir);
            }
        }
    }

    if let Err(e) = std::fs::create_dir_all(cache_dir) {
        eprintln!("Failed to recreate cache directory: {e}");
    }
}

/// `app_data_dir` 直下に残っている `cache-trash-*` ディレクトリをすべて
/// バックグラウンドで削除する（should(4): クラッシュ等で前回消しきれなかった分の掃除）。
fn sweep_stale_trash_dirs(app_data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(app_data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_trash_dir = path.is_dir()
            && path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with("cache-trash-"))
                .unwrap_or(false);
        if is_trash_dir {
            std::thread::spawn(move || {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    eprintln!("Failed to remove stale cache trash {}: {e}", path.display());
                }
            });
        }
    }
}

/// ディレクトリの中身（ファイル/サブディレクトリ）を1件ずつ削除する。
/// 個々の削除失敗は無視して続行する（`clear_cache_dir` の rename 失敗時フォールバック）。
fn clear_directory_contents(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = result {
            eprintln!("Failed to remove cache entry {}: {e}", path.display());
        }
    }
}

/// 一時ファイルに書いてから rename する（同一ディレクトリ内なのでアトミック）。
/// これにより `exists()` が書込途中のファイルを返すことがなくなる。
pub(crate) fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
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
/// - 書込途中の一時ファイル（`.{name}.tmp-*`）は対象外にする。
/// - `exclude` に含まれるファイルはサイズを合計には含めるが、削除候補にはしない
///   （must4: 直近に表示へ使ったキャッシュの巻き添え削除を防ぐ）。
pub fn enforce_cache_limit(
    cache_dir: &Path,
    max_bytes: u64,
    exclude: &HashSet<PathBuf>,
) -> std::io::Result<()> {
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
                total += size;

                if exclude.contains(&path) {
                    continue; // 直近提供分はサイズに計上するが削除候補にはしない
                }

                let modified = metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
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

    fn workspace(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sss_cache_worker_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn empty_worker() -> CacheWorker {
        CacheWorker {
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    jobs: VecDeque::new(),
                    queued: HashSet::new(),
                }),
                has_work: Condvar::new(),
                completed: Condvar::new(),
                recently_served: Mutex::new(VecDeque::new()),
                failed: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// must5: cache_dir を退避→再作成する。呼び出し直後には新しい cache_dir が
    /// 空であること（中身のコピーが起きていないこと）を確認する。
    #[test]
    fn clear_cache_dir_recreates_empty_cache_dir() {
        let app_data_dir = workspace("clear_app_data");
        let cache_dir = app_data_dir.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("old.jpg"), b"stale").unwrap();

        clear_cache_dir(&app_data_dir, &cache_dir);

        assert!(cache_dir.exists(), "cache_dir というパス自体は残るはず");
        let remaining: Vec<_> = std::fs::read_dir(&cache_dir).unwrap().flatten().collect();
        assert!(
            remaining.is_empty(),
            "呼び出し直後の cache_dir は空のはず: {remaining:?}"
        );

        let _ = std::fs::remove_dir_all(&app_data_dir);
    }

    /// should(4): app_data_dir 直下に残っている古い cache-trash-* も
    /// バックグラウンドで削除される。
    #[test]
    fn clear_cache_dir_sweeps_stale_trash_dirs_from_previous_runs() {
        let app_data_dir = workspace("clear_sweep");
        let cache_dir = app_data_dir.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let stale_trash = app_data_dir.join("cache-trash-stale-from-previous-run");
        std::fs::create_dir_all(&stale_trash).unwrap();
        std::fs::write(stale_trash.join("leftover.jpg"), b"leftover").unwrap();

        clear_cache_dir(&app_data_dir, &cache_dir);

        // バックグラウンド削除の完了を短時間ポーリングで待つ（フレーキー回避のため
        // 長時間スリープではなく、完了したら即抜けるポーリングにする）。
        let deadline = Instant::now() + Duration::from_secs(2);
        while stale_trash.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }

        assert!(
            !stale_trash.exists(),
            "古い cache-trash-* はバックグラウンドで削除されるはず"
        );

        let _ = std::fs::remove_dir_all(&app_data_dir);
    }

    /// should(5): rename が使えない状況のフォールバック（中身を1件ずつ削除）。
    /// 個々の削除対象を消せること、存在しないディレクトリでもパニックしないことを確認する。
    #[test]
    fn clear_directory_contents_removes_files_and_ignores_missing_dir() {
        let dir = workspace("fallback_clear");
        std::fs::write(dir.join("a.jpg"), b"a").unwrap();
        std::fs::create_dir_all(dir.join("subdir")).unwrap();
        std::fs::write(dir.join("subdir/b.jpg"), b"b").unwrap();

        clear_directory_contents(&dir);

        let remaining: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert!(
            remaining.is_empty(),
            "中身は全て削除されるはず: {remaining:?}"
        );

        // 存在しないディレクトリを渡してもパニックしない。
        clear_directory_contents(&dir.join("does-not-exist"));

        let _ = std::fs::remove_dir_all(&dir);
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

        enforce_cache_limit(&dir, 15, &HashSet::new()).unwrap();

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
        enforce_cache_limit(&dir, 0, &HashSet::new()).unwrap();
        assert!(dir.join(".x.jpg.tmp-1").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// must4: 直近提供分は最古であっても削除対象から除外される。
    #[test]
    fn enforce_cache_limit_excludes_recently_served_paths() {
        let dir = workspace("exclude_recent");

        for (name, sleep_ms) in [("old_served.jpg", 0u64), ("new.jpg", 10)] {
            std::fs::write(dir.join(name), b"0123456789").unwrap();
            thread::sleep(Duration::from_millis(sleep_ms.max(1)));
        }

        let mut exclude = HashSet::new();
        exclude.insert(dir.join("old_served.jpg"));

        // 上限0（本来なら両方削除されるはず）でも、除外指定した最古ファイルは残る。
        enforce_cache_limit(&dir, 0, &exclude).unwrap();

        assert!(
            dir.join("old_served.jpg").exists(),
            "直近提供分は最古でも削除されないはず"
        );
        assert!(
            !dir.join("new.jpg").exists(),
            "除外指定していないファイルは通常通り削除されるはず"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_current_upgrades_existing_prefetch_priority() {
        let cache_dir = workspace("priority");
        let worker = empty_worker();

        let cache_file = cache_dir.join("abc.jpg");
        worker.request_prefetch(
            vec![(PathBuf::from("/tmp/source.jpg"), cache_file.clone())],
            true,
        );
        worker.request_current(PathBuf::from("/tmp/source.jpg"), cache_file.clone(), true);

        let queue = worker.shared.queue.lock().unwrap();
        assert_eq!(queue.jobs.len(), 1, "重複排除で1件のままのはず");
        assert!(queue.jobs[0].is_current, "current 優先度に昇格しているはず");

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must3: 新しい current 要求が来たら、それ以前の current 要求は格下げされる
    /// （「現在画像」は常に1件だけのはずで、古いものが居座って最新が後回しにならない）。
    #[test]
    fn request_current_downgrades_previous_current_job() {
        let cache_dir = workspace("downgrade");
        let worker = empty_worker();

        let old_current = cache_dir.join("old.jpg");
        worker.request_current(PathBuf::from("/tmp/old.jpg"), old_current.clone(), true);

        let new_current = cache_dir.join("new.jpg");
        worker.request_current(PathBuf::from("/tmp/new.jpg"), new_current.clone(), true);

        let queue = worker.shared.queue.lock().unwrap();
        let old_job = queue.jobs.iter().find(|j| j.cache_file == old_current);
        let new_job = queue.jobs.iter().find(|j| j.cache_file == new_current);

        assert!(
            !old_job
                .expect("古いジョブはキューに残っているはず")
                .is_current,
            "古い current 要求は格下げされるはず"
        );
        assert!(
            new_job.expect("新しいジョブはキューにあるはず").is_current,
            "新しい current 要求のみが is_current のはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    #[test]
    fn request_prefetch_drops_stale_generation_but_keeps_current() {
        let cache_dir = workspace("stale");
        let worker = empty_worker();

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

        let queue = worker.shared.queue.lock().unwrap();
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

    /// 同一バッチ内に同じ cache_file が複数含まれていても1件にまとめる（重複排除）。
    #[test]
    fn request_prefetch_dedups_duplicate_cache_file_within_same_batch() {
        let cache_dir = workspace("dedup_batch");
        let worker = empty_worker();

        let cache_file = cache_dir.join("dup.jpg");
        worker.request_prefetch(
            vec![
                (PathBuf::from("/tmp/dup.jpg"), cache_file.clone()),
                (PathBuf::from("/tmp/dup.jpg"), cache_file.clone()),
            ],
            true,
        );

        let queue = worker.shared.queue.lock().unwrap();
        assert_eq!(
            queue.jobs.len(),
            1,
            "同一バッチ内の重複cache_fileは1件にまとめられるはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// 既にディスク上にキャッシュファイルが存在する場合、先読みキューへは積まない
    /// （ワーカーが起動後に無駄な再生成をしないため）。
    #[test]
    fn request_prefetch_skips_entries_whose_cache_file_already_exists() {
        let cache_dir = workspace("prefetch_existing");
        let worker = empty_worker();

        let cache_file = cache_dir.join("already.jpg");
        std::fs::write(&cache_file, b"already-cached").unwrap();

        worker.request_prefetch(
            vec![(PathBuf::from("/tmp/already.jpg"), cache_file.clone())],
            true,
        );

        let queue = worker.shared.queue.lock().unwrap();
        assert!(
            queue.jobs.is_empty(),
            "既にキャッシュが存在するファイルはキューに積まれないはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// 既にディスク上にキャッシュファイルが存在する場合、現在画像要求としても積まない。
    #[test]
    fn request_current_skips_when_cache_file_already_exists() {
        let cache_dir = workspace("current_existing");
        let worker = empty_worker();

        let cache_file = cache_dir.join("already.jpg");
        std::fs::write(&cache_file, b"already-cached").unwrap();

        worker.request_current(PathBuf::from("/tmp/already.jpg"), cache_file.clone(), true);

        let queue = worker.shared.queue.lock().unwrap();
        assert!(
            queue.jobs.is_empty(),
            "既にキャッシュが存在するファイルは current 要求でも積まれないはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must7: 失敗セットに入っているキーは request_current / request_prefetch で
    /// 再キューされない。
    #[test]
    fn failed_cache_key_is_not_requeued() {
        let cache_dir = workspace("failed_skip");
        let worker = empty_worker();
        let cache_file = cache_dir.join("bad.jpg");

        mark_failed(&worker.shared, &cache_file);

        worker.request_current(PathBuf::from("/tmp/bad.jpg"), cache_file.clone(), true);
        worker.request_prefetch(
            vec![(PathBuf::from("/tmp/bad.jpg"), cache_file.clone())],
            true,
        );

        let queue = worker.shared.queue.lock().unwrap();
        assert!(
            queue.jobs.is_empty(),
            "失敗済みキーは current/prefetch どちらでも積まれないはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must2: キャッシュが（別スレッドが完了通知した後に）出来上がっていれば true を返す。
    #[test]
    fn request_current_and_wait_returns_true_once_completed() {
        let cache_dir = workspace("wait_success");
        let worker = Arc::new(empty_worker());
        let cache_file = cache_dir.join("done.jpg");

        // 実ワーカーは動かさず、完了を模擬するスレッドだけ起動する。
        // notify_completed と同じ手順（queueロックを取ってから notify）で模擬する。
        let sim_shared = Arc::clone(&worker.shared);
        let sim_cache_file = cache_file.clone();
        let simulator = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            std::fs::write(&sim_cache_file, b"done").unwrap();
            notify_completed(&sim_shared);
        });

        let ok = worker.request_current_and_wait(
            PathBuf::from("/tmp/done.jpg"),
            cache_file.clone(),
            true,
            Duration::from_secs(2),
        );

        simulator.join().unwrap();
        assert!(ok, "完了通知後は true を返すはず");
        assert!(cache_file.exists());

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must2: 誰も完了させない場合はタイムアウトで false を返す（ハングしない）。
    #[test]
    fn request_current_and_wait_times_out_when_never_completed() {
        let cache_dir = workspace("wait_timeout");
        let worker = empty_worker();
        let cache_file = cache_dir.join("never.jpg");

        let started = Instant::now();
        let ok = worker.request_current_and_wait(
            PathBuf::from("/tmp/never.jpg"),
            cache_file,
            true,
            Duration::from_millis(100),
        );
        let elapsed = started.elapsed();

        assert!(!ok, "誰も完了させないのでfalseのはず");
        assert!(
            elapsed < Duration::from_secs(2),
            "タイムアウトが機能せずハングしている: {elapsed:?}"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must7: 既に失敗セットに入っているキーは、フルタイムアウトを待たず即座に false。
    #[test]
    fn request_current_and_wait_fails_fast_when_already_failed() {
        let cache_dir = workspace("wait_failed_fast");
        let worker = empty_worker();
        let cache_file = cache_dir.join("bad.jpg");
        mark_failed(&worker.shared, &cache_file);

        let started = Instant::now();
        let ok = worker.request_current_and_wait(
            PathBuf::from("/tmp/bad.jpg"),
            cache_file,
            true,
            Duration::from_secs(10),
        );
        let elapsed = started.elapsed();

        assert!(!ok);
        assert!(
            elapsed < Duration::from_millis(500),
            "失敗済みキーは長いタイムアウトを待たず即座に諦めるはず: {elapsed:?}"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must4: mark_served はファイルの mtime を現在時刻へ更新する。
    #[test]
    fn mark_served_touches_mtime() {
        let cache_dir = workspace("touch_mtime");
        let worker = empty_worker();
        let cache_file = cache_dir.join("served.jpg");
        std::fs::write(&cache_file, b"data").unwrap();

        // mtime を意図的に過去へ巻き戻す。
        // Windows は読み取り専用ハンドルでの set_modified を拒否する（属性変更には
        // 書込アクセスが要る）ため、write(true) で開く（PR#83レビューM1b）。
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&cache_file)
            .unwrap()
            .set_modified(old_time)
            .unwrap();

        worker.mark_served(cache_file.clone());

        let new_mtime = std::fs::metadata(&cache_file).unwrap().modified().unwrap();
        assert!(
            new_mtime > old_time,
            "mark_served後はmtimeが更新されているはず"
        );

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    /// must6: ジョブ処理を包む catch_unwind の慣用パターン自体が panic を
    /// 捕捉して呼び出し元へ伝播させないことをピン留めする。
    /// （実際の image デコード経路で意図的に panic を起こすのは、アロケータ由来の
    /// abort 等プロセス自体を落としかねないリスクがあり安全にテストできないため、
    /// run() が使っているのと同じ catch_unwind の使い方をここで直接検証する。）
    #[test]
    fn catch_unwind_pattern_does_not_propagate_panic() {
        let result: Result<i32, String> =
            panic::catch_unwind(AssertUnwindSafe(|| -> Result<i32, String> {
                panic!("boom");
            }))
            .map_err(|_| "panicked".to_string())
            .and_then(|r| r);

        assert_eq!(result, Err("panicked".to_string()));
    }
}
