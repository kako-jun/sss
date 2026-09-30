import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri runtime module. tauri.ts is a thin layer over `invoke`; these tests are characterization tests that pin (a) the exact
// command string each wrapper sends, (b) the argument object shape / key casing,
// and (c) how each wrapper passes the invoke return value straight through.
const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import * as tauri from './tauri';
import { setLanguageSetting } from './i18n/store';
import type {
  ImageInfo,
  ImageNavigationResult,
  ScanProgress,
  RecentImage,
  IgnoreRule,
  DisplayStats,
} from '../types';

beforeEach(() => {
  invoke.mockReset();
});

describe('tauri command wrappers', () => {
  it('getShareDirectory invokes get_share_directory and returns the resolved path', async () => {
    invoke.mockResolvedValue('/mnt/ssd/picked');
    expect(await tauri.getShareDirectory()).toBe('/mnt/ssd/picked');
    expect(invoke).toHaveBeenCalledWith('get_share_directory');
  });

  it('getDefaultShareDirectory invokes get_default_share_directory and returns the value', async () => {
    invoke.mockResolvedValue('/home/me/Pictures');
    const result = await tauri.getDefaultShareDirectory();
    expect(invoke).toHaveBeenCalledWith('get_default_share_directory');
    expect(result).toBe('/home/me/Pictures');
  });

  it('selectAndScan sends only the localized dialog title (never a path) and returns ScanProgress (#93)', async () => {
    const progress: ScanProgress = {
      totalFiles: 10,
      newFiles: 3,
      deletedFiles: 1,
      durationMs: 42,
      errorCount: 0,
      errorExamples: [],
    };
    invoke.mockResolvedValue(progress);
    const result = await tauri.selectAndScan();
    // src/test/setup.ts が navigator.language を 'ja-JP' に固定しているため既定は ja
    expect(invoke).toHaveBeenCalledWith('select_and_scan', { title: '写真フォルダを選択' });
    expect(result).toEqual(progress);
  });

  it('selectAndScan uses the English dialog title once the language is "en" and returns null on cancel (#93)', async () => {
    setLanguageSetting('en');
    invoke.mockResolvedValue(null);
    expect(await tauri.selectAndScan()).toBeNull();
    expect(invoke).toHaveBeenCalledWith('select_and_scan', { title: 'Select Photo Folder' });
  });

  it('rescanLastDirectory invokes rescan_last_directory with no arguments (#93)', async () => {
    const progress: ScanProgress = {
      totalFiles: 1,
      newFiles: 0,
      deletedFiles: 0,
      durationMs: 1,
      errorCount: 0,
      errorExamples: [],
    };
    invoke.mockResolvedValue(progress);
    expect(await tauri.rescanLastDirectory()).toEqual(progress);
    expect(invoke).toHaveBeenCalledWith('rescan_last_directory');
  });

  it('selectShareDirectory sends only the dialog title and returns the saved path or null (#93)', async () => {
    invoke.mockResolvedValue('/mnt/ssd/picked');
    expect(await tauri.selectShareDirectory()).toBe('/mnt/ssd/picked');
    expect(invoke).toHaveBeenCalledWith('select_share_directory', {
      title: 'ピック先フォルダを選択',
    });
    invoke.mockResolvedValue(null);
    expect(await tauri.selectShareDirectory()).toBeNull();
  });

  it('restorePlaylist takes no path (the backend restores the saved last directory) and returns the boolean as-is (#93)', async () => {
    invoke.mockResolvedValue(true);
    const result = await tauri.restorePlaylist();
    expect(invoke).toHaveBeenCalledWith('restore_playlist');
    expect(result).toBe(true);
  });

  // #65: get_next_image/get_previous_imageの戻り値はタグ付きImageNavigationResult
  // （{kind, data?}）になった。旧実装は成功時にImageInfoを直接返し、それ以外を
  // 生のnullに潰していたが、バックエンドはもうImageInfoやnullを単体では返さない
  // （必ず`kind`でラップされる）ため、wrapperの「そのまま素通しする」特性を
  // 実際に届く形（タグ付きオブジェクト）でピン留めする。
  it('getNextImage invokes get_next_image and returns the found ImageNavigationResult as-is', async () => {
    const image: ImageInfo = {
      path: '/a.jpg',
      optimizedPath: null,
      isVideo: false,
      width: 100,
      height: 200,
      fileSize: 1234,
      exif: null,
      displayCount: 0,
      lastDisplayed: null,
    };
    const found: ImageNavigationResult = { kind: 'found', data: image };
    invoke.mockResolvedValue(found);
    const result = await tauri.getNextImage();
    expect(invoke).toHaveBeenCalledWith('get_next_image');
    expect(result).toEqual(found);
  });

  it('getNextImage passes through a non-found ImageNavigationResult as-is (e.g. emptyPlaylist)', async () => {
    const empty: ImageNavigationResult = { kind: 'emptyPlaylist' };
    invoke.mockResolvedValue(empty);
    const result = await tauri.getNextImage();
    expect(result).toEqual(empty);
  });

  it('getPreviousImage invokes get_previous_image and passes through a "noHistory" result', async () => {
    const noHistory: ImageNavigationResult = { kind: 'noHistory' };
    invoke.mockResolvedValue(noHistory);
    const result = await tauri.getPreviousImage();
    expect(invoke).toHaveBeenCalledWith('get_previous_image');
    expect(result).toEqual(noHistory);
  });

  it('undoDisplayCount invokes undo_display_count with path and returns nothing (#65)', async () => {
    invoke.mockResolvedValue(undefined);
    const result = await tauri.undoDisplayCount('/a.jpg');
    expect(invoke).toHaveBeenCalledWith('undo_display_count', { path: '/a.jpg' });
    expect(result).toBeUndefined();
  });

  it('openInExplorer passes imagePath', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.openInExplorer('/a.jpg');
    expect(invoke).toHaveBeenCalledWith('open_in_explorer', { imagePath: '/a.jpg' });
  });

  it('getPlaylistInfo returns the [position, total, canGoBack] tuple', async () => {
    invoke.mockResolvedValue([3, 100, true]);
    const result = await tauri.getPlaylistInfo();
    expect(invoke).toHaveBeenCalledWith('get_playlist_info');
    expect(result).toEqual([3, 100, true]);
  });

  it('saveSetting passes key and value', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.saveSetting('theme', 'dark');
    expect(invoke).toHaveBeenCalledWith('save_setting', { key: 'theme', value: 'dark' });
  });

  it('getSetting passes key and returns the stored string', async () => {
    invoke.mockResolvedValue('dark');
    expect(await tauri.getSetting('theme')).toBe('dark');
    expect(invoke).toHaveBeenCalledWith('get_setting', { key: 'theme' });
  });

  it('pickImage passes imagePath and returns the copied path', async () => {
    invoke.mockResolvedValue('/Pictures/sss-picked/a.jpg');
    const result = await tauri.pickImage('/a.jpg');
    expect(invoke).toHaveBeenCalledWith('pick_image', { imagePath: '/a.jpg' });
    expect(result).toBe('/Pictures/sss-picked/a.jpg');
  });

  it('excludeImage forwards imagePath and excludeType verbatim', async () => {
    invoke.mockResolvedValue('ok');
    await tauri.excludeImage('/a.jpg', 'directory');
    expect(invoke).toHaveBeenCalledWith('exclude_image', {
      imagePath: '/a.jpg',
      excludeType: 'directory',
    });
  });

  it('undoExclude maps the exclude outcome onto the undo_exclude arguments (#78)', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.undoExclude({
      pattern: '/a.jpg',
      needsRescan: false,
      ruleType: 'glob',
      ruleAdded: true,
      removedPaths: ['/a.jpg'],
    });
    expect(invoke).toHaveBeenCalledWith('undo_exclude', {
      pattern: '/a.jpg',
      ruleType: 'glob',
      removeRule: true,
      restorePaths: ['/a.jpg'],
    });
  });

  it('getDisplayStats returns the aggregated histogram (not a per-file list, #67)', async () => {
    const stats: DisplayStats = {
      files: 3,
      min: 1,
      max: 2,
      mean: 5 / 3,
      bins: [
        { count: 1, files: 1 },
        { count: 2, files: 2 },
      ],
    };
    invoke.mockResolvedValue(stats);
    expect(await tauri.getDisplayStats()).toEqual(stats);
    expect(invoke).toHaveBeenCalledWith('get_display_stats');
  });

  it('getIgnorePatterns returns rules with pattern + ruleType (glob/date)', async () => {
    const rules: IgnoreRule[] = [
      { pattern: '**/.thumbnails/', ruleType: 'glob' },
      { pattern: '2023-05-15', ruleType: 'date' },
    ];
    invoke.mockResolvedValue(rules);
    expect(await tauri.getIgnorePatterns()).toEqual(rules);
    expect(invoke).toHaveBeenCalledWith('get_ignore_patterns');
  });

  it('removeIgnorePattern invokes remove_ignore_pattern with pattern and ruleType (#61複合キー化)', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.removeIgnorePattern('*.tmp', 'glob');
    expect(invoke).toHaveBeenCalledWith('remove_ignore_pattern', {
      pattern: '*.tmp',
      ruleType: 'glob',
    });
  });

  it('addIgnorePattern invokes add_ignore_pattern with pattern', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.addIgnorePattern('*.tmp');
    expect(invoke).toHaveBeenCalledWith('add_ignore_pattern', { pattern: '*.tmp' });
  });

  it('getRecentImages returns the RecentImage list', async () => {
    const recent: RecentImage[] = [
      { path: '/a.jpg', displayCount: 2, lastDisplayed: '2024-01-01' },
    ];
    invoke.mockResolvedValue(recent);
    expect(await tauri.getRecentImages()).toEqual(recent);
    expect(invoke).toHaveBeenCalledWith('get_recent_images');
  });

  it('deletePickedImage invokes delete_picked_image with imagePath', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.deletePickedImage('/a.jpg');
    expect(invoke).toHaveBeenCalledWith('delete_picked_image', { imagePath: '/a.jpg' });
  });

  it('getThumbnail invokes get_thumbnail with imagePath and returns the tagged result (#67)', async () => {
    invoke.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/x.jpg' });
    expect(await tauri.getThumbnail('/a.jpg')).toEqual({
      kind: 'image',
      path: '/cache/thumbs/x.jpg',
    });
    expect(invoke).toHaveBeenCalledWith('get_thumbnail', { imagePath: '/a.jpg' });
  });

  it('getThumbnail passes a video result through untouched (#67)', async () => {
    invoke.mockResolvedValue({ kind: 'video' });
    expect(await tauri.getThumbnail('/a.mp4')).toEqual({ kind: 'video' });
    expect(invoke).toHaveBeenCalledWith('get_thumbnail', { imagePath: '/a.mp4' });
  });

  it('getThumbnail propagates a backend rejection instead of swallowing it (#67)', async () => {
    invoke.mockRejectedValue('Not a supported image file');
    await expect(tauri.getThumbnail('/a.txt')).rejects.toBe('Not a supported image file');
  });

  it('propagates rejections from invoke', async () => {
    invoke.mockRejectedValue(new Error('backend boom'));
    await expect(tauri.getNextImage()).rejects.toThrow('backend boom');
  });
});
