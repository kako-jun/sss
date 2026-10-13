use crate::cache_worker::CacheWorker;
use crate::database::Database;
use crate::playlist::Playlist;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

/// アプリケーション状態
pub struct AppState {
    pub db: Mutex<Database>,
    pub playlist: Mutex<Option<Playlist>>,
    pub directory_path: Mutex<Option<PathBuf>>,
    pub cache_dir: PathBuf,
    /// 画像最適化キャッシュを作る単一ワーカースレッド（#60）。表示・先読み要求はここに積む。
    pub cache_worker: CacheWorker,
    /// スクリーンセーバー抑制ハンドル。初期化に失敗した環境（D-Bus 無し等）では `None`
    pub _keep_awake: Option<keepawake::KeepAwake>,
    /// スキャン（`select_and_scan`/`rescan_last_directory`）の二重実行防止フラグ（#61レビュー nit）。
    /// `scan_service::ScanGuard` が `compare_exchange` で操作する。
    pub scan_in_progress: AtomicBool,
    /// 直近に`increment_display_count`を実際に呼んだパス（#65レビューS1）。
    /// `undo_display_count`（`<img>`/`<video>`の`onError`から呼ばれる）は、
    /// フロントが渡す`path`がこれと一致した時だけ1回減らしてクリアする。
    /// `get_previous_image`（表示回数を増やさない）や履歴なぞり中の`advance`
    /// （`should_count=false`）はここを更新しないため、それらの経路で
    /// `onError`が起きても無関係な過去の加算を誤って減らすことがない。
    pub last_incremented_display: Mutex<Option<String>>,
}

pub use crate::scan_service::ScanProgress;

/// `exclude_image` の結果（#80）。以前は表示用に完成させた日本語文字列
/// （`"除外パターン追加: {pattern}"`等）をそのまま返していたが、i18n対応のため
/// 構造化データに変える。文言の組み立てはフロント辞書側（`needsRescan`で
/// 「再スキャンしてください」の要否を出し分ける）が担う。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeOutcome {
    pub pattern: String,
    /// true: `exclude_type` が "date"/"directory"。date は exif_cache で既知の
    /// 画像だけ即座にプレイリストから外すが、未取得分が残りうるため実装上は
    /// 常にtrue（#82レビュー: 以前のdocコメントは「exif_cache既知の日付除外は
    /// false」と誤っていたが、実際のコードは date/directory の両方で常に
    /// `true` を返す。実際に即時反映のみで再スキャン不要なのは "file" だけ）。
    /// false: `exclude_type` が "file"（即座にプレイリストから除去済み）。
    pub needs_rescan: bool,
    /// 追加した除外ルールの種別（`"glob"` | `"date"`）。`undo_exclude` へそのまま渡す（#78）。
    pub rule_type: String,
    /// この除外で `ignore_rules` に**新規追加された**か（#78）。同じルールが元から
    /// 登録済みだった場合は `false`。取り消しで元からあったルールまで消さないための印。
    pub rule_added: bool,
    /// この除外で**即座に**プレイリストから外した画像のパス（#78）。`undo_exclude` が
    /// 未再生区間へ戻す対象。ディレクトリ除外や未取得の撮影日除外は再スキャンまで
    /// プレイリストから外れないため空になりうる。
    pub removed_paths: Vec<String>,
}
