// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
  setTitle: vi.fn(),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => win,
}));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  // Slideshowが`found`な画像を描画する際に呼ぶ。jsdomには実装が無く、呼ぶと
  // window.__TAURI_INTERNALS__が無いとして例外になるため素通しモックに差し替える。
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
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
  win.setTitle.mockReset().mockResolvedValue(undefined);
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

describe('App directoryError notice (#65レビュー: 起動時スキャン失敗理由がどの経路でも表示されないバグ)', () => {
  it('shows the dedicated "前回のフォルダを読めません" full-screen notice with the reason when the foreground scan itself fails (restorePlaylist=false)', async () => {
    // restorePlaylist=falseだとinitialize()（=最初のgetNextImage）が一度も呼ばれず
    // notice はnullのまま。旧実装はemptyStateContentのif連鎖が全部外れてnullになり、
    // directoryErrorのdiv自体がその内側にあるため描画されなかった（テスト担当が発見）。
    getLastDirectoryPath.mockResolvedValue('/photos');
    restorePlaylist.mockResolvedValue(false);
    scanDirectory.mockRejectedValue(new Error('permission denied'));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('前回のフォルダを読めません')).toBeTruthy();
    });
    expect(
      screen.getByText('前回のフォルダに接続できませんでした: permission denied'),
    ).toBeTruthy();
    // ディレクトリは設定済み（前回パスがあった）なので「ようこそ」ではない。
    expect(screen.queryByText('ようこそ SSS へ')).toBeNull();
    // 起動失敗直後でも設定を開けること（フォルダを選び直せる）。
    expect(screen.getByText('設定を開く')).toBeTruthy();
  });

  it('does not clear currentImage or show the full-screen notice when the background scan fails after a successful restore; shows a bottom toast instead', async () => {
    useRestoredStartupPath();
    scanDirectory.mockRejectedValue(new Error('nas offline'));
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
        displayCount: 0,
        lastDisplayed: null,
      },
    });
    render(<App />);

    // 復元成功パスは即座に最初の画像を表示する。
    await waitFor(() => {
      expect(screen.queryByText('ようこそ SSS へ')).toBeNull();
      expect(screen.queryByText('前回のフォルダを読めません')).toBeNull();
    });

    // バックグラウンドスキャンの失敗が伝播すると、写真を隠さず控えめなトーストで
    // 理由を出す（旧実装はcurrentImageが非nullだと外側の!currentImage条件で
    // directoryErrorの表示自体が一切出なかった＝テスト担当が発見したバグ）。
    await waitFor(() => {
      expect(screen.getByText('前回のフォルダに接続できませんでした: nas offline')).toBeTruthy();
    });
    // 全画面の案内(タイトル)は出ない＝写真を邪魔しない。
    expect(screen.queryByText('前回のフォルダを読めません')).toBeNull();
  });

  it('auto-dismisses the background-scan-failure toast after a few seconds', async () => {
    // shouldAdvanceTime: 実時間の経過に合わせてフェイク時計も自動で進むモード。
    // 起動シーケンス(setTimeout(0)+複数awaitの連鎖)やwaitFor自身のポーリングは
    // 通常どおり実時間で動きつつ、最後の6秒待ちだけ vi.advanceTimersByTimeAsync で
    // 早送りできる（実時間6秒待つ低速テストにしないため）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useRestoredStartupPath();
    scanDirectory.mockRejectedValue(new Error('nas offline'));
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
        displayCount: 0,
        lastDisplayed: null,
      },
    });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('前回のフォルダに接続できませんでした: nas offline')).toBeTruthy();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(screen.queryByText('前回のフォルダに接続できませんでした: nas offline')).toBeNull();
  });
});

function findPhotoImg(): HTMLImageElement {
  return Array.from(document.querySelectorAll('img')).find(
    (el) => el.getAttribute('alt') !== 'SSS Logo',
  ) as HTMLImageElement;
}

function foundImage(path: string) {
  return {
    kind: 'found' as const,
    data: {
      path,
      optimizedPath: null,
      isVideo: false,
      width: 10,
      height: 10,
      fileSize: 1,
      exif: null,
      displayCount: 0,
      lastDisplayed: null,
    },
  };
}

// #65レビュー質問決定: 「前へ」の途中でonErrorになった場合はloadPreviousImageで
// さらに戻る、前進中（既定含む）は次へ進む。方向の引き継ぎロジック自体
// （continueInLastDirection、初期値/next後/previous後の分岐）は
// useSlideshow.test.tsx で決定的に検証済み。ここではApp経由の配線が既定方向
// （フォワード）で正しく動くことだけを確認する。「前へ」を挟むケースは
// AnimatePresence(mode="wait")の退場アニメーション完了待ちが必要で、この
// テストファイルでは他テストとの組み合わせ実行時に実時間待ちが不安定だった
// （単体実行では安定して通る）ため、Slideshow.test.tsx側のDOM構造検証と
// useSlideshow.test.tsx側の方向ロジック検証の組み合わせでカバーする。
describe('App onError continues in the last navigation direction (#65レビュー質問決定)', () => {
  it('continues forward (getNextImage) when onError happens during normal forward viewing', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });

    getNextImage.mockClear();
    getNextImage.mockResolvedValueOnce(foundImage('/b.jpg'));
    fireEvent.error(findPhotoImg());

    await waitFor(() => {
      expect(getNextImage).toHaveBeenCalledTimes(1);
    });
    expect(getPreviousImage).not.toHaveBeenCalled();
    expect(undoDisplayCount).toHaveBeenCalledWith('/a.jpg');
  });

  // #65レビュー2巡目nit: undoDisplayCountの完了を待ってからcontinueInLastDirection
  // を呼ぶ（順序確定）。並行に発火すると、continueInLastDirection側が先に次の
  // get_next_imageを完了させ、バックエンドのlast_incremented_displayを次のpathへ
  // 進めてしまい、その後に届くundo_display_count(古いpath)がパス不一致で無視
  // されてしまう競合が起こり得るため。
  it('awaits undoDisplayCount before calling continueInLastDirection (ordering)', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });

    let resolveUndo!: () => void;
    undoDisplayCount.mockReset().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveUndo = resolve;
      }),
    );
    getNextImage.mockClear();
    getNextImage.mockResolvedValueOnce(foundImage('/b.jpg'));
    fireEvent.error(findPhotoImg());

    // undoDisplayCountがまだ解決していない間は、次のget_next_imageは呼ばれない。
    await Promise.resolve();
    await Promise.resolve();
    expect(getNextImage).not.toHaveBeenCalled();

    resolveUndo();
    await waitFor(() => {
      expect(getNextImage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('App shows a bottom toast (not a full-screen takeover) on a mid-viewing error notice (#65レビューS3)', () => {
  it('keeps the current image and shows the rejection message in a toast', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });

    getNextImage.mockClear();
    getNextImage.mockRejectedValueOnce('backend hiccup');
    fireEvent.keyDown(document, { key: 'ArrowRight', repeat: false });

    await waitFor(() => {
      expect(screen.getByText('backend hiccup')).toBeTruthy();
    });
    // 全画面の案内には落ちず、写真は維持される。
    expect(findPhotoImg()).toBeTruthy();
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

// #80: 言語決定は app_settings.language ('ja'|'en'|'auto') → auto は
// navigator.language（ja*ならja、それ以外en）。src/test/setup.tsがnavigator.languageを
// 'ja-JP'に固定しているため、他のテストは全てja表示を前提にできる。ここでは
// navigator.languageをen-USへ一時的に上書きして、autoがenへ解決されることと、
// 明示的な'ja'設定がnavigator.languageより優先されることを確認する。
describe('App i18n (#80): language setting resolution', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'language', { value: 'ja-JP', configurable: true });
  });

  it('renders in English when no language is saved (auto) and navigator.language is non-Japanese', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to SSS')).toBeTruthy();
    });
    expect(screen.getByText('Select Folder')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders in Japanese when the saved language setting is "ja", even if navigator.language is English', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    getSetting.mockImplementation(async (key: string) => (key === 'language' ? 'ja' : null));
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('ja');
  });

  it('renders in English when the saved language setting is "en", even if navigator.language is Japanese', async () => {
    // src/test/setup.ts の既定（ja-JP）のまま。settingが常にnavigatorに勝つことを
    // 前のテスト（ja設定がnavigator=enに勝つ）と逆方向でも確認する。
    getSetting.mockImplementation(async (key: string) => (key === 'language' ? 'en' : null));
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to SSS')).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('en');
  });

  it('sets the native window title to the translated windowTitle for the resolved locale', async () => {
    getSetting.mockImplementation(async (key: string) => (key === 'language' ? 'en' : null));
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(win.setTitle).toHaveBeenCalledWith('sss - Smart Slide Show');
    });
  });
});
