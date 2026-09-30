import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  DisplayStats,
  ThumbnailResult,
  ExcludeOutcome,
  IgnoreRule,
  ImageNavigationResult,
  RecentImage,
  ScanProgress,
} from '../types';
import { t } from './i18n';

/**
 * デフォルトのピック先ディレクトリパスを取得
 */
export async function getDefaultShareDirectory(): Promise<string> {
  return await invoke<string>('get_default_share_directory');
}

/**
 * ディレクトリ選択ダイアログを開く
 */
export async function selectDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: t('selectDirectoryDialogTitle'),
  });

  if (typeof selected === 'string') {
    return selected;
  }

  return null;
}

/**
 * ディレクトリをスキャンしてプレイリストを初期化
 */
export async function scanDirectory(directoryPath: string): Promise<ScanProgress> {
  return await invoke<ScanProgress>('scan_directory', { directoryPath });
}

/**
 * 起動時、DBに保存済みのプレイリスト状態を復元する（#62レビューS1）。
 * スキャン完了を待たずに表示を始めるため、`scanDirectory` とは独立して呼ぶ。
 * `true`（復元できた）ならスキャンはバックグラウンドで実行してよい。
 * `false`（保存が無い/ディレクトリ不一致）ならスキャン完了を待つ従来のフローに
 * フォールバックする。
 */
export async function restorePlaylist(directoryPath: string): Promise<boolean> {
  return await invoke<boolean>('restore_playlist', { directoryPath });
}

/**
 * 次の画像を取得。
 *
 * 戻り値は `ImageNavigationResult`（#65）。旧実装のように成功以外を `null` に
 * 潰さず、`kind` で意味ごとに分岐できる（バックエンド側の解説は
 * `src-tauri/src/commands/image.rs` の `ImageNavigationResult` docコメント参照）。
 */
export async function getNextImage(): Promise<ImageNavigationResult> {
  return await invoke<ImageNavigationResult>('get_next_image');
}

/**
 * 前の画像を取得
 */
export async function getPreviousImage(): Promise<ImageNavigationResult> {
  return await invoke<ImageNavigationResult>('get_previous_image');
}

/**
 * `<img>`/`<video>` の `onError`（WebViewのデコード/描画失敗）で、既に
 * バックエンドが加算した表示回数を取り消す（#65）。バックエンドはファイルの
 * 存在とキャッシュ変換の成功までしか確認できず、実際にWebViewが描画できるかは
 * 確認できないため「加算 → 描画失敗が分かったら取り消す」方式にしている
 * （加算そのものを表示成功後に遅延させる設計にしなかった理由は
 * `undo_display_count` のdocコメント参照）。
 */
export async function undoDisplayCount(imagePath: string): Promise<void> {
  await invoke('undo_display_count', { path: imagePath });
}

/**
 * ファイラで画像を開く
 */
export async function openInExplorer(imagePath: string): Promise<void> {
  return await invoke<void>('open_in_explorer', { imagePath });
}

/**
 * プレイリスト情報を取得 (position, total, canGoBack)
 */
export async function getPlaylistInfo(): Promise<[number, number, boolean] | null> {
  return await invoke<[number, number, boolean] | null>('get_playlist_info');
}

/**
 * 最後に選択したディレクトリパスを取得
 */
export async function getLastDirectoryPath(): Promise<string | null> {
  return await invoke<string | null>('get_last_directory_path');
}

/**
 * 設定を保存
 */
export async function saveSetting(key: string, value: string): Promise<void> {
  return await invoke<void>('save_setting', { key, value });
}

/**
 * 設定を取得
 */
export async function getSetting(key: string): Promise<string | null> {
  return await invoke<string | null>('get_setting', { key });
}

/**
 * OSのロケール（例: "ja-JP"）を取得する（#82 should3。詳細は
 * `docs/architecture.md` 6-(g)「表示言語（auto）はOSロケールを優先して解決する」）。
 *
 * `navigator.language` はWebViewの実装依存で、macOSのWKWebViewは
 * `CFBundleLocalizations` にアプリの対応言語として明示していないロケールだと
 * 実際のOS設定に関わらず `en-US` 固定になる既知の制約がある。`initLocale`
 * （`src/lib/i18n/store.ts`）は保存値が `auto` かどうかによらず起動時に毎回
 * こちらを優先して呼び、取得できない場合（`null`）だけ `navigator.language`
 * にフォールバックする（#82レビュー2巡目 should2）。
 */
export async function getOsLocale(): Promise<string | null> {
  return await invoke<string | null>('get_os_locale');
}

/**
 * ピック：画像をPictures/sss-pickedフォルダにコピー
 */
export async function pickImage(imagePath: string): Promise<string> {
  return await invoke<string>('pick_image', { imagePath });
}

/**
 * 除外：画像をDBの除外ルールに追加
 *
 * #80: 戻り値は構造化データ（`ExcludeOutcome`）。表示文言の組み立ては
 * 呼び出し側（フロント辞書）が行う。
 */
export async function excludeImage(
  imagePath: string,
  excludeType: 'date' | 'file' | 'directory',
): Promise<ExcludeOutcome> {
  return await invoke<ExcludeOutcome>('exclude_image', { imagePath, excludeType });
}

/**
 * 直前の除外を取り消す（#78）。`excludeImage` の戻り値をそのまま渡す。
 * ルール削除（新規追加だった場合のみ）と、即座に外した画像の未再生区間への復帰を行う。
 */
export async function undoExclude(outcome: ExcludeOutcome): Promise<void> {
  await invoke('undo_exclude', {
    pattern: outcome.pattern,
    ruleType: outcome.ruleType,
    removeRule: outcome.ruleAdded,
    restorePaths: outcome.removedPaths,
  });
}

/**
 * 表示回数の分布を取得（グラフ用、#67）。全件の一覧ではなく、バックエンドで
 * 集計した要約とヒストグラムだけが返る。
 */
export async function getDisplayStats(): Promise<DisplayStats> {
  return await invoke<DisplayStats>('get_display_stats');
}

/**
 * 除外ルール一覧を取得（通常glob / 撮影日ルールを区別する rule_type 込み）
 */
export async function getIgnorePatterns(): Promise<IgnoreRule[]> {
  return await invoke<IgnoreRule[]>('get_ignore_patterns');
}

/**
 * 除外ルールを削除
 *
 * #61レビュー nit: ignore_rulesの主キーが (pattern, ruleType) の複合キーになったため、
 * どちらのルールを消すか一意に決めるため ruleType も渡す。
 */
export async function removeIgnorePattern(
  pattern: string,
  ruleType: 'glob' | 'date',
): Promise<void> {
  await invoke('remove_ignore_pattern', { pattern, ruleType });
}

/**
 * 除外ルールを手動追加
 */
export async function addIgnorePattern(pattern: string): Promise<void> {
  await invoke('add_ignore_pattern', { pattern });
}

/**
 * すべての設定とデータを初期化（データベースとキャッシュを削除）
 */
export async function resetAllData(): Promise<void> {
  return await invoke<void>('reset_all_data');
}

/**
 * 最近表示した画像一覧を取得（最新100件）
 */
export async function getRecentImages(): Promise<RecentImage[]> {
  return await invoke<RecentImage[]>('get_recent_images');
}

/**
 * ピック済み画像一覧を取得
 */
export async function getPickedImages(): Promise<string[]> {
  return await invoke<string[]>('get_picked_images');
}

/**
 * 設定画面用の小さなサムネイルを取得する（#67）。
 * 静止画はバックエンドが縮小してキャッシュした JPEG のパスを返す。動画は `{ kind: 'video' }`。
 */
export async function getThumbnail(imagePath: string): Promise<ThumbnailResult> {
  return await invoke<ThumbnailResult>('get_thumbnail', { imagePath });
}

/**
 * ピック済み画像を削除
 */
export async function deletePickedImage(imagePath: string): Promise<void> {
  await invoke('delete_picked_image', { imagePath });
}

/**
 * 全画像の表示回数をリセット
 */
export async function resetAllDisplayCounts(): Promise<void> {
  await invoke('reset_all_display_counts');
}
