import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri runtime modules. tauri.ts is a thin layer over `invoke` and the
// dialog plugin; these tests are characterization tests that pin (a) the exact
// command string each wrapper sends, (b) the argument object shape / key casing,
// and (c) how each wrapper passes the invoke return value straight through.
const invoke = vi.fn();
const open = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => open(...args),
}));

import * as tauri from './tauri';
import type { ImageInfo, ScanProgress, Stats, RecentImage } from '../types';

beforeEach(() => {
  invoke.mockReset();
  open.mockReset();
});

describe('tauri command wrappers', () => {
  it('getDefaultShareDirectory invokes get_default_share_directory and returns the value', async () => {
    invoke.mockResolvedValue('/home/me/Pictures');
    const result = await tauri.getDefaultShareDirectory();
    expect(invoke).toHaveBeenCalledWith('get_default_share_directory');
    expect(result).toBe('/home/me/Pictures');
  });

  it('scanDirectory passes directoryPath (camelCase) and returns ScanProgress', async () => {
    const progress: ScanProgress = {
      totalFiles: 10,
      newFiles: 3,
      deletedFiles: 1,
      durationMs: 42,
    };
    invoke.mockResolvedValue(progress);
    const result = await tauri.scanDirectory('/photos');
    expect(invoke).toHaveBeenCalledWith('scan_directory', { directoryPath: '/photos' });
    expect(result).toEqual(progress);
  });

  it('getNextImage invokes get_next_image and returns ImageInfo', async () => {
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
    invoke.mockResolvedValue(image);
    const result = await tauri.getNextImage();
    expect(invoke).toHaveBeenCalledWith('get_next_image');
    expect(result).toEqual(image);
  });

  it('getNextImage passes through a null result (end-of-playlist)', async () => {
    invoke.mockResolvedValue(null);
    const result = await tauri.getNextImage();
    expect(result).toBeNull();
  });

  it('getPreviousImage invokes get_previous_image', async () => {
    invoke.mockResolvedValue(null);
    await tauri.getPreviousImage();
    expect(invoke).toHaveBeenCalledWith('get_previous_image');
  });

  it('openInExplorer passes imagePath', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.openInExplorer('/a.jpg');
    expect(invoke).toHaveBeenCalledWith('open_in_explorer', { imagePath: '/a.jpg' });
  });

  it('getStats invokes get_stats and returns Stats', async () => {
    const stats: Stats = { totalImages: 5, displayedImages: 2 };
    invoke.mockResolvedValue(stats);
    expect(await tauri.getStats()).toEqual(stats);
    expect(invoke).toHaveBeenCalledWith('get_stats');
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

  it('getDisplayStats returns the [label, count] pairs', async () => {
    invoke.mockResolvedValue([
      ['2024-01', 5],
      ['2024-02', 8],
    ]);
    expect(await tauri.getDisplayStats()).toEqual([
      ['2024-01', 5],
      ['2024-02', 8],
    ]);
  });

  it('removeIgnorePattern invokes remove_ignore_pattern with pattern', async () => {
    invoke.mockResolvedValue(undefined);
    await tauri.removeIgnorePattern('*.tmp');
    expect(invoke).toHaveBeenCalledWith('remove_ignore_pattern', { pattern: '*.tmp' });
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

  it('propagates rejections from invoke', async () => {
    invoke.mockRejectedValue(new Error('backend boom'));
    await expect(tauri.getNextImage()).rejects.toThrow('backend boom');
  });
});

describe('selectDirectory (dialog plugin)', () => {
  it('returns the selected path when a string is chosen', async () => {
    open.mockResolvedValue('/chosen/dir');
    const result = await tauri.selectDirectory();
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Select Photo Directory',
    });
    expect(result).toBe('/chosen/dir');
  });

  it('returns null when the dialog is cancelled (open resolves null)', async () => {
    open.mockResolvedValue(null);
    expect(await tauri.selectDirectory()).toBeNull();
  });

  it('returns null when open resolves a non-string (e.g. array)', async () => {
    open.mockResolvedValue(['/a', '/b']);
    expect(await tauri.selectDirectory()).toBeNull();
  });
});
