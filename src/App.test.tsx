// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// #65: App.tsx が「hasDirectory + notice.kind」から選ぶ案内画面（ようこそ/空/
// 接続不可/読込失敗/エラー、uiText・noticeMessages）と、キーリピート(e.repeat)の
// 無視は、これまでApp.tsx単体のテストが無く一度もピン留めされていなかった
// （useSlideshow/Slideshow/OverlayUI/IntervalSectionはそれぞれ個別にテストされて
// いるが、App.tsxの案内画面の出し分けそのものはどこにも現れない）。
//
// 起動シーケンス(runStartupSequence)自体はstartup.test.tsxで純粋関数として
// 個別に検証済みのため、ここではrestorePlaylist=trueの「復元成功」経路を使い
// （initialize()が即座に呼ばれ、以降はgetNextImageの応答だけで状態を制御できる）、
// 案内画面の文言選択とキーボードガードだけに焦点を絞る。

const getSetting = vi.fn();
const getLastDirectoryPath = vi.fn();
const restorePlaylist = vi.fn();
const scanDirectory = vi.fn();
const getPlaylistInfo = vi.fn();
const getNextImage = vi.fn();
const getPreviousImage = vi.fn();
const undoDisplayCount = vi.fn();

vi.mock('./lib/tauri', () => ({
  getSetting: (...a: unknown[]) => getSetting(...a),
  getLastDirectoryPath: (...a: unknown[]) => getLastDirectoryPath(...a),
  restorePlaylist: (...a: unknown[]) => restorePlaylist(...a),
  scanDirectory: (...a: unknown[]) => scanDirectory(...a),
  getPlaylistInfo: (...a: unknown[]) => getPlaylistInfo(...a),
  getNextImage: (...a: unknown[]) => getNextImage(...a),
  getPreviousImage: (...a: unknown[]) => getPreviousImage(...a),
  undoDisplayCount: (...a: unknown[]) => undoDisplayCount(...a),
}));

const listen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...a: unknown[]) => listen(...a),
}));

const win = {
  isFullscreen: vi.fn(),
  onResized: vi.fn(),
  setFullscreen: vi.fn(),
  setDecorations: vi.fn(),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => win,
}));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const exit = vi.fn();
vi.mock('@tauri-apps/plugin-process', () => ({
  exit: (...a: unknown[]) => exit(...a),
}));

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

// Settings（未使用時は`isOpen`でnullを返すのでこれらのテストでは一切マウントされない）
// はGraphSectionを経由してuplotを引き込み、uplotはimport時にwindow.matchMediaを
// 呼ぶ。jsdomにはmatchMediaが無くこれらのシナリオでは不要なため、モジュール
// グラフごと軽量なスタブに差し替える（全テスト共通のsetup.tsを汚さないため）。
vi.mock('./components/Settings', () => ({
  Settings: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="settings-stub" /> : null,
}));

import App from './App';

beforeEach(() => {
  getSetting.mockReset().mockResolvedValue(null);
  getLastDirectoryPath.mockReset().mockResolvedValue(null);
  restorePlaylist.mockReset().mockResolvedValue(false);
  scanDirectory.mockReset().mockResolvedValue({ totalFiles: 0 });
  getPlaylistInfo.mockReset().mockResolvedValue(null);
  getNextImage.mockReset().mockResolvedValue({ kind: 'emptyPlaylist' });
  getPreviousImage.mockReset().mockResolvedValue({ kind: 'noHistory' });
  undoDisplayCount.mockReset().mockResolvedValue(undefined);
  listen.mockReset().mockResolvedValue(() => {});
  invoke.mockReset().mockResolvedValue(undefined);
  exit.mockReset();
  openUrl.mockReset();
  win.isFullscreen.mockReset().mockResolvedValue(true);
  win.onResized.mockReset().mockResolvedValue(() => {});
  win.setFullscreen.mockReset().mockResolvedValue(undefined);
  win.setDecorations.mockReset().mockResolvedValue(undefined);
});

/** 「復元成功」経路（restorePlaylist=true）にして initialize() を即座に走らせ、
 * 以降は getNextImage の応答だけで案内画面の状態を制御できるようにする。 */
function useRestoredStartupPath() {
  getLastDirectoryPath.mockResolvedValue('/photos');
  restorePlaylist.mockResolvedValue(true);
}

describe('App empty-state notice display (#65 問題1・9: ようこそ/空/接続不可/読込失敗/エラー)', () => {
  it('shows the welcome screen ("フォルダを選択") when no directory has ever been configured', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
    expect(screen.getByText('フォルダを選択')).toBeTruthy();
  });

  it('shows the dedicated emptyPlaylist notice ("設定を開く", not the welcome screen) once a directory is configured', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValue({ kind: 'emptyPlaylist' });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('表示できる写真がありません')).toBeTruthy();
    });
    // #65 問題1: ディレクトリ設定済みなので「フォルダを選択」ではなく「設定を開く」。
    expect(screen.getByText('設定を開く')).toBeTruthy();
    expect(screen.queryByText('ようこそ SSS へ')).toBeNull();
  });

  it('shows the rootUnavailable notice text', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValue({ kind: 'rootUnavailable' });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('フォルダに接続できません。再接続をお待ちください…')).toBeTruthy();
    });
  });

  it('shows the loadFailedGaveUp notice text after exhausting retries', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValue({ kind: 'loadFailed' });
    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByText('複数の写真の読み込みに失敗しました。フォルダの状態を確認してください。'),
      ).toBeTruthy();
    });
  });

  it('shows a generic error notice with the rejection message on unexpected rejection', async () => {
    useRestoredStartupPath();
    getNextImage.mockRejectedValue(new Error('disk gone'));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeTruthy();
    });
    expect(screen.getByText('Error: disk gone')).toBeTruthy();
  });

  it('shows neither the full-screen empty state nor the bottom banner once an image is found', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValue({
      kind: 'found',
      data: {
        path: '/photos/a.jpg',
        optimizedPath: null,
        isVideo: false,
        width: 10,
        height: 10,
        fileSize: 1,
        exif: null,
        displayCount: 1,
        lastDisplayed: null,
      },
    });
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('ようこそ SSS へ')).toBeNull();
      expect(screen.queryByText('表示できる写真がありません')).toBeNull();
    });
  });
});

describe('App keyboard shortcut: e.repeat is ignored (#65)', () => {
  it('does not advance on a repeated (held-down) ArrowRight keydown, but does on a fresh one', async () => {
    render(<App />);

    // 初期化(setTimeout 0)完了を待つ。ようこそ画面が出ればハンドラは張られている。
    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
    getNextImage.mockClear();

    fireEvent.keyDown(document, { key: 'ArrowRight', repeat: true });
    await Promise.resolve();
    expect(getNextImage).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'ArrowRight', repeat: false });
    await waitFor(() => {
      expect(getNextImage).toHaveBeenCalledTimes(1);
    });
  });
});
