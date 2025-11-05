import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { ImageInfo, ScanProgress, Stats } from '../types';

/**
 * デフォルトのシェアディレクトリパスを取得
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
    title: 'Select Photo Directory',
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
 * プレイリストを初期化（保存された状態から復元）
 */
export async function initPlaylist(): Promise<string | null> {
  return await invoke<string | null>('init_playlist');
}

/**
 * 次の画像を取得
 */
export async function getNextImage(): Promise<ImageInfo | null> {
  return await invoke<ImageInfo | null>('get_next_image');
}

/**
 * 前の画像を取得
 */
export async function getPreviousImage(): Promise<ImageInfo | null> {
  return await invoke<ImageInfo | null>('get_previous_image');
}

/**
 * ファイラで画像を開く
 */
export async function openInExplorer(imagePath: string): Promise<void> {
  return await invoke<void>('open_in_explorer', { imagePath });
}

/**
 * 統計情報を取得
 */
export async function getStats(): Promise<Stats> {
  return await invoke<Stats>('get_stats');
}

/**
 * プレイリスト情報を取得 (position, total, canGoBack)
 */
export async function getPlaylistInfo(): Promise<[number, number, boolean] | null> {
  return await invoke<[number, number, boolean] | null>('get_playlist_info');
}

/**
 * 画像パスをTauriのURLに変換
 */
export function getImageUrl(imagePath: string): string {
  // Tauri v2ではデフォルトプロトコルを使用
  return convertFileSrc(imagePath);
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
 * シェアマーク：画像をPictures/sssフォルダにコピー
 */
export async function shareImage(imagePath: string): Promise<string> {
  return await invoke<string>('share_image', { imagePath });
}

/**
 * 除外：画像を.sssignoreに追加
 */
export async function excludeImage(imagePath: string, excludeType: 'date' | 'file' | 'directory'): Promise<string> {
  return await invoke<string>('exclude_image', { imagePath, excludeType });
}

/**
 * 統計データを取得（グラフ用）
 */
export async function getDisplayStats(): Promise<Array<[string, number]>> {
  return await invoke<Array<[string, number]>>('get_display_stats');
}
