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
const rescanLastDirectory = vi.fn();
const getPlaylistInfo = vi.fn();
const getNextImage = vi.fn();
const getPreviousImage = vi.fn();
const undoDisplayCount = vi.fn();
const getOsLocale = vi.fn();

vi.mock('./lib/tauri', () => ({
  getSetting: (...a: unknown[]) => getSetting(...a),
  getLastDirectoryPath: (...a: unknown[]) => getLastDirectoryPath(...a),
  restorePlaylist: (...a: unknown[]) => restorePlaylist(...a),
  rescanLastDirectory: (...a: unknown[]) => rescanLastDirectory(...a),
  getPlaylistInfo: (...a: unknown[]) => getPlaylistInfo(...a),
  getNextImage: (...a: unknown[]) => getNextImage(...a),
  getPreviousImage: (...a: unknown[]) => getPreviousImage(...a),
  undoDisplayCount: (...a: unknown[]) => undoDisplayCount(...a),
  getOsLocale: (...a: unknown[]) => getOsLocale(...a),
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
import { setLanguageSetting } from './lib/i18n/store';

beforeEach(() => {
  getSetting.mockReset().mockResolvedValue(null);
  getLastDirectoryPath.mockReset().mockResolvedValue(null);
  restorePlaylist.mockReset().mockResolvedValue(false);
  rescanLastDirectory.mockReset().mockResolvedValue({ totalFiles: 0 });
  getPlaylistInfo.mockReset().mockResolvedValue(null);
  getNextImage.mockReset().mockResolvedValue({ kind: 'emptyPlaylist' });
  getPreviousImage.mockReset().mockResolvedValue({ kind: 'noHistory' });
  undoDisplayCount.mockReset().mockResolvedValue(undefined);
  getOsLocale.mockReset().mockResolvedValue(null); // 既定: OSロケール取得不可 → navigator.languageにフォールバック
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
      expect(screen.getByText('フォルダに接続できません。再接続をお待ちください...')).toBeTruthy();
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
    rescanLastDirectory.mockRejectedValue(new Error('permission denied'));
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
    rescanLastDirectory.mockRejectedValue(new Error('nas offline'));
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
    rescanLastDirectory.mockRejectedValue(new Error('nas offline'));
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

  // #82レビューmust: 以前は `initLocale(getSetting).then(...)` に `.catch()` が無く、
  // `getSetting('language')` がrejectすると`.then()`が一生呼ばれず、
  // `runStartupSequence`（ようこそ画面等への遷移を含む）が永久に走らなかった
  // （起動画面のまま固まる）。`initLocale`自身が内部で吸収して常にresolveする
  // ことを、App全体を通した回帰テストとして固定する。
  it('does not hang on the loading screen when getSetting("language") rejects (#82 must)', async () => {
    getSetting.mockImplementation(async (key: string) => {
      if (key === 'language') throw new Error('db locked');
      return null;
    });
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
  });

  // #82レビューshould3: navigator.languageはmacOSのWKWebViewでCFBundleLocalizations
  // 未設定だとOS設定に関わらずen-US固定になる既知の制約があるため、`auto`解決時は
  // `getOsLocale`（`get_os_locale`、sys-localeクレート経由）を優先する。
  it('prefers the OS locale (getOsLocale) over navigator.language when the setting is "auto" (#82 should3)', async () => {
    // src/test/setup.ts の既定でnavigator.languageは'ja-JP'（→通常はja）だが、
    // OSロケールがen-USを返せばそちらが勝ってenになるはず。
    getSetting.mockResolvedValue(null); // language未設定 → 'auto'
    getOsLocale.mockResolvedValue('en-US');
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to SSS')).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('en');
  });

  it('falls back to navigator.language when getOsLocale rejects (#82 should3)', async () => {
    getSetting.mockResolvedValue(null); // 'auto'
    getOsLocale.mockRejectedValue(new Error('not supported on this platform'));
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    // navigator.languageは既定でja-JPなので、OSロケール取得に失敗してもjaになる。
    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('ja');
  });
});

// #82レビューshould1: App.tsxの`directoryError`はraw（バックエンドのエラーコード等）
// のまま保持し、表示のたびに現在のロケールへ解決する。エラー表示中に言語を
// 切り替えても、確定済みの旧言語の文言のまま固まらず、新しい言語へ即座に
// 切り替わることを固定する（新旧言語が混在しないことの回帰テスト）。
// #66 問題1: 設定中のESCはモーダルを閉じる。それ以外はexit_appを呼ぶ。以前は
// フェーズに関わらず常にexit_appを呼んでいたため、設定画面でESCを押しただけで
// アプリごと終了していた。
describe('App Escape key (#66 問題1)', () => {
  it('closes the Settings modal instead of exiting the app when Settings is open', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    // App自身が描画する設定ボタン（右上）をクリックして開く（Settingsコンポーネント
    // 自体はこのファイルでスタブ化されているため、data-testid="settings-stub" が
    // 現れることで開いたことを確認する）。
    fireEvent.click(screen.getByTitle('設定'));
    expect(screen.getByTestId('settings-stub')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('settings-stub')).toBeNull();
    });
    expect(invoke).not.toHaveBeenCalledWith('exit_app');
  });

  it('calls exit_app when Escape is pressed and nothing is open', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('exit_app');
    });
  });
});

// #66 問題4: Space=一時停止/再開、F/F11=フルスクリーン切替、?=ショートカット一覧。
describe('App keyboard shortcuts: Space, F, ? (#66 問題4)', () => {
  it('toggles the pause icon/tooltip in the overlay when Space is pressed on the document body', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });
    // 再生中は「一時停止」ツールチップ/アイコン。
    expect(screen.getByTitle('一時停止')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: ' ' });

    await waitFor(() => {
      expect(screen.getByTitle('再生')).toBeTruthy();
    });
    expect(screen.queryByTitle('一時停止')).toBeNull();

    // もう一度押すと再生に戻る。
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => {
      expect(screen.getByTitle('一時停止')).toBeTruthy();
    });
  });

  it('toggles fullscreen via setFullscreen/setDecorations when F is pressed', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
    // 起動時のisFullscreen()解決(true)を待つ。
    await waitFor(() => {
      expect(win.isFullscreen).toHaveBeenCalled();
    });

    fireEvent.keyDown(document, { key: 'f' });

    await waitFor(() => {
      expect(win.setFullscreen).toHaveBeenCalledWith(false);
    });
    expect(win.setDecorations).toHaveBeenCalledWith(true);
  });

  it('toggles the shortcuts overlay when ? is pressed, and Escape closes it without exiting', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: '?' });
    await waitFor(() => {
      expect(screen.getByText('キーボードショートカット')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('キーボードショートカット')).toBeNull();
    });
    expect(invoke).not.toHaveBeenCalledWith('exit_app');
  });

  it('does not toggle pause when Space is pressed while a button has real keyboard (:focus-visible) focus (avoids double-firing the native click)', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });
    expect(screen.getByTitle('一時停止')).toBeTruthy();

    const settingsButton = screen.getByTitle('設定');
    settingsButton.focus();
    fireEvent.keyDown(settingsButton, { key: ' ' });

    // フォーカスがボタンにある間はグローバルのSpaceショートカットを発火しない
    // （ボタン自身のネイティブなクリック相当の挙動に譲る）。jsdomは
    // `:focus-visible`を「今フォーカスされているか」だけで判定する（実際に
    // .focus()されたこのボタンはtrueになる）ため、追加のスタブ無しでこの
    // ケースを再現できる。
    await Promise.resolve();
    expect(screen.getByTitle('一時停止')).toBeTruthy();
  });

  // #66レビューmust2(b): 実ブラウザ(Chromium/WebView2)では「前へ/次へ」等の
  // ボタンをマウスでクリックした後もそのボタンにフォーカスが残り続けるが、
  // それは`:focus-visible`にならない（キーボード操作等で意図的にフォーカス
  // された場合だけ真になる）。この「クリック直後の残留フォーカス」を
  // シミュレートするため、実際に.focus()した上で`matches`を明示的にfalseへ
  // スタブする（jsdomの`:focus-visible`は「フォーカスの有無」だけで判定して
  // しまい、この違いを自然には再現できないため）。
  //
  // #66レビュー2巡目must1（案a）: 実際の根本対策は、操作バー・右上ピルの
  // コンテナに`onMouseDown={e => e.preventDefault()}`を付け、マウスクリックが
  // そもそもボタンへフォーカスを残さないようにしたこと（実ブラウザではこの
  // シナリオ自体が起きなくなった）。このテストはSpaceハンドラ自身のロジック
  // （`document.activeElement`が実際に`:focus-visible`かどうかをその場で判定
  // する、という単純な形に戻した）に対する保険的な単体テストとして残す
  // （何らかの経路でボタンに非キーボード的な残留フォーカスが生じても、Space
  // は正しくアプリの一時停止として扱われることを確認する）。
  it('still toggles pause via Space when a button has residual (non-:focus-visible) focus from a prior mouse click (#66レビューmust2b)', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });
    expect(screen.getByTitle('一時停止')).toBeTruthy();

    const nextButton = screen.getByTitle('次へ (→)');
    vi.spyOn(nextButton, 'matches').mockReturnValue(false);
    nextButton.focus();

    fireEvent.keyDown(nextButton, { key: ' ' });

    await waitFor(() => {
      expect(screen.getByTitle('再生')).toBeTruthy();
    });
  });
});

// #66レビューmust1: キーボードハンドラが参照する値をrefで持つようにしたことの
// 回帰テスト。以前はhandleToggleWindowMode（とその中のisFullscreen）がeffectの
// deps配列に無く、初回レンダー時点のクロージャに固定されたままだったため、
// Fキーを複数回押しても実際には毎回同じ`!isFullscreen`（常に同じ値）しか
// 計算されず、2回目以降で正しく切り替わらなかった（実ブラウザで再現確認済み）。
//
// #66レビュー2巡目must2: CI環境限定でこのテストがflakyだった。原因は、
// マウント直後に自動実行される「OSの実態からisFullscreenを取得して同期する」
// 非同期effect（win.isFullscreen().then(setIsFullscreen)）が、beforeEachの既定
// モック値(true)を返しており、コンポーネントの初期state(useState(true))と
// 同じ値だったこと。同じ値へのsetStateはReactが再レンダーを省略しうるため、
// 「非同期解決が実際にstateへ反映・コミットされた」ことをUIから積極的に確認
// する手段が無かった。CI環境でこの非同期解決がFキー押下と競合するタイミングで
// 届くと、テストが期待する順序と食い違い稀に失敗していた（と推測される）。
// 修正: このテストだけ`win.isFullscreen`をあえて初期state(true)と異なる値
// (false)に解決させ、それがコミットされたこと（タイトルが実際に反転すること）
// を明示的に待ってからFキーを押し始める。これにより「非同期解決は必ずFキー
// 押下より前に完了している」ことをテスト自体が保証できる。
describe('App keyboard shortcut F toggles correctly across repeated presses (#66レビューmust1)', () => {
  it('alternates on every press, not stuck after the first, and is unaffected by a same-tick async isFullscreen() resolution (#66レビュー2巡目must2)', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    win.isFullscreen.mockReset().mockResolvedValue(false);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    // 起動直後のuseState(true)による初期表示は「ウィンドウモードに切り替え」
    // （isFullscreen=trueの時の表示）。win.isFullscreen()の非同期解決(false)が
    // 実際にstateへ反映・コミットされると「フルスクリーンに戻す」
    // （isFullscreen=falseの時の表示）へ変わる。この変化を確認できて初めて、
    // 以降のFキー押下がこの非同期解決と競合しないことを保証できる。
    await waitFor(() => {
      expect(screen.getByTitle('フルスクリーンに戻す')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'f' });
    await waitFor(() => {
      expect(screen.getByTitle('ウィンドウモードに切り替え')).toBeTruthy();
    });
    expect(win.setFullscreen).toHaveBeenNthCalledWith(1, true);

    fireEvent.keyDown(document, { key: 'f' });
    await waitFor(() => {
      expect(screen.getByTitle('フルスクリーンに戻す')).toBeTruthy();
    });
    expect(win.setFullscreen).toHaveBeenNthCalledWith(2, false);

    fireEvent.keyDown(document, { key: 'f' });
    await waitFor(() => {
      expect(screen.getByTitle('ウィンドウモードに切り替え')).toBeTruthy();
    });
    expect(win.setFullscreen).toHaveBeenNthCalledWith(3, true);
  });
});

// #66レビュー2巡目must1（案a）: 右上ピルのコンテナに`onMouseDown`でのpreventDefault
// が実際に配線されていることの単体テスト。jsdomは実ブラウザと異なりmousedown/click
// だけでは要素にフォーカスを与えないため（.focus()を明示的に呼ばない限り
// activeElementは変化しない）、「フォーカスが移らないこと」自体はここでは検証
// できない（それは実ブラウザe2eが担当する）。ここでは「mousedownイベントの
// preventDefault()が実際に呼ばれているか」をイベントのdefaultPrevented（＝
// dispatchEventの戻り値がfalseになること）で直接確認する。
describe('App top-right pill suppresses focus-stealing on mouse click (#66レビュー2巡目must1案a)', () => {
  it('calls preventDefault() on mousedown for buttons inside the pill', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    const settingsButton = screen.getByTitle('設定');
    const notCancelled = fireEvent.mouseDown(settingsButton);
    expect(notCancelled).toBe(false);
  });
});

// #66レビューmust2: meta/ctrl/altのいずれかを伴う場合、アプリ側のショートカット
// として扱わない（Cmd+F/Ctrl+F等、OS/ブラウザ標準のショートカットとの衝突を
// 避ける）。
describe('App keyboard shortcuts ignore modifier-key combinations (#66レビューmust2)', () => {
  it('does not toggle fullscreen for Cmd+F or Ctrl+F', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    await Promise.resolve();

    expect(win.setFullscreen).not.toHaveBeenCalled();
  });

  it('does not exit the app for Ctrl+Escape', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'Escape', ctrlKey: true });
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalledWith('exit_app');
  });
});

// #66レビューshould: オーバーレイの「…」メニュー（除外サブメニュー含む）が
// 開いている間のESCは、それを閉じるだけにする。
describe('App Escape closes the overlay "…" menu without exiting (#66レビューshould)', () => {
  it('closes the more-menu on Escape instead of calling exit_app', async () => {
    useRestoredStartupPath();
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    render(<App />);

    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle('メニュー'));
    expect(screen.getByText('ファイルマネージャーで開く')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('ファイルマネージャーで開く')).toBeNull();
    });
    expect(invoke).not.toHaveBeenCalledWith('exit_app');
  });
});

describe('App directoryError follows locale switches without mixing languages (#82 should1)', () => {
  it('re-resolves the startup directory error message to the new language after switching locale mid-display', async () => {
    getLastDirectoryPath.mockResolvedValue('/photos');
    restorePlaylist.mockResolvedValue(false);
    rescanLastDirectory.mockRejectedValue('directoryNotFound');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('指定したフォルダが見つかりません: /photos')).toBeTruthy();
    });

    // 設定画面を介さず、ストアを直接切り替えて言語切替の即時反映を確認する
    // （LanguageSection自体の検証は別ファイルで行い、ここではApp側の再描画のみ見る）。
    act(() => {
      setLanguageSetting('en');
    });

    await waitFor(() => {
      expect(screen.getByText("Couldn't find the selected folder: /photos")).toBeTruthy();
    });
    // 古い日本語の文言が残っていない（新旧混在しない）。
    expect(screen.queryByText('指定したフォルダが見つかりません: /photos')).toBeNull();
  });
});

// #78: 写真上のマウス操作。写真クリック=一時停止/再開、ホイール=前/次。
describe('App mouse gestures on the photo (#78)', () => {
  async function setupPhoto() {
    getLastDirectoryPath.mockResolvedValue('/photos');
    restorePlaylist.mockResolvedValue(true);
    getNextImage.mockResolvedValueOnce(foundImage('/a.jpg'));
    getPlaylistInfo.mockResolvedValue([2, 5, true]); // 戻れる状態
    render(<App />);
    await waitFor(() => {
      expect(findPhotoImg()).toBeTruthy();
    });
    return findPhotoImg() as HTMLElement;
  }

  it('toggles pause/resume when the photo is clicked, and folds a rapid double click into one toggle', async () => {
    const photo = await setupPhoto();
    expect(screen.getByTitle('一時停止')).toBeTruthy();

    fireEvent.click(photo);
    await waitFor(() => expect(screen.getByTitle('再生')).toBeTruthy());

    // 直後の連打（ダブルクリックの2発目）は無視され、再生に戻ってしまわない。
    fireEvent.click(photo);
    expect(screen.getByTitle('再生')).toBeTruthy();
  });

  it('does not toggle pause when a control on the overlay is clicked', async () => {
    await setupPhoto();
    // 「次へ」ボタンのクリックはオーバーレイ操作であって写真クリックではない。
    fireEvent.click(screen.getByTitle('次へ (→)'));
    await Promise.resolve();
    expect(screen.getByTitle('一時停止')).toBeTruthy();
  });

  it('goes to the next photo on wheel down / horizontal swipe left, and previous on wheel up', async () => {
    const photo = await setupPhoto();
    getNextImage.mockClear();
    getPreviousImage.mockClear();

    fireEvent.wheel(photo, { deltaY: 100, deltaMode: 0 });
    await waitFor(() => expect(getNextImage).toHaveBeenCalledTimes(1));
    expect(getPreviousImage).not.toHaveBeenCalled();

    // 連続して届く慣性イベントでは、続けて進まない。
    fireEvent.wheel(photo, { deltaY: 100, deltaMode: 0 });
    fireEvent.wheel(photo, { deltaY: 100, deltaMode: 0 });
    await Promise.resolve();
    expect(getNextImage).toHaveBeenCalledTimes(1);
  });

  it('goes to the previous photo on wheel up once the gesture has settled', async () => {
    const photo = await setupPhoto();
    getPreviousImage.mockClear();
    fireEvent.wheel(photo, { deltaY: -100, deltaMode: 0 });
    await waitFor(() => expect(getPreviousImage).toHaveBeenCalledTimes(1));
  });

  it('ignores pinch-zoom (ctrl+wheel)', async () => {
    const photo = await setupPhoto();
    getNextImage.mockClear();
    fireEvent.wheel(photo, { deltaY: 100, deltaMode: 0, ctrlKey: true });
    await Promise.resolve();
    expect(getNextImage).not.toHaveBeenCalled();
  });
});

// #103: capability 不足などで setFullscreen/setDecorations が拒否されても、ボタン
// （とF/F11）が無反応にならず、ユーザーへ失敗を通知する。表示はOSの実態に再同期する。
describe('App window mode toggle failure notice (#103)', () => {
  it('shows an alert and keeps the displayed mode consistent when setFullscreen rejects', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    win.isFullscreen.mockReset().mockResolvedValue(true);
    win.setFullscreen.mockReset().mockRejectedValue(new Error('not allowed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByTitle('ウィンドウモードに切り替え'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        'ウィンドウモードを切り替えられませんでした',
      );
    });
    // 切替に失敗したので表示は元のまま（OSの実態=フルスクリーン）
    expect(screen.getByTitle('ウィンドウモードに切り替え')).toBeTruthy();
    expect(win.setDecorations).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('also shows the alert for the F key and clears it after a successful toggle', async () => {
    getLastDirectoryPath.mockResolvedValue(null);
    win.isFullscreen.mockReset().mockResolvedValue(true);
    win.setFullscreen
      .mockReset()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('ようこそ SSS へ')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'f' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'f' });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(screen.getByTitle('フルスクリーンに戻す')).toBeTruthy();
    errorSpy.mockRestore();
  });
});
