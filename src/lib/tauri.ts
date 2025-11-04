import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import type { ImageInfo, ScanProgress, Stats } from '../types';

/**
 * フォルダ選択ダイアログを開く
 */
export async function selectFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Select Photo Folder',
  });

  if (typeof selected === 'string') {
    return selected;
  }

  return null;
}

/**
 * フォルダをスキャンしてプレイリストを初期化
 */
export async function scanFolder(folderPath: string): Promise<ScanProgress> {
  return await invoke<ScanProgress>('scan_folder', { folderPath });
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
  // Tauri v1ではデフォルトプロトコルを使用
  return convertFileSrc(imagePath);
}

/**
 * 最後に選択したフォルダパスを取得
 */
export async function getLastFolderPath(): Promise<string | null> {
  return await invoke<string | null>('get_last_folder_path');
}
