// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setLanguageSetting } from '../../lib/i18n/store';

// #59: tauri-plugin-shell の open() から tauri-plugin-opener の openUrl() への移行。
// GitHubリンクボタンが openUrl を正しい引数で呼ぶこと、失敗時に既存の catch が
// 変わらず機能する（例外を投げずコンソールに記録するだけ）ことをピン留めする。
const openUrl = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

// resetAllData はこのテストの対象外（#59 の変更範囲外）だが、コンポーネントが
// import しているためモックしておく。
const resetAllData = vi.fn();
vi.mock('../../lib/tauri', () => ({
  resetAllData: (...args: unknown[]) => resetAllData(...args),
}));

// #66 問題7: バージョン表示を「1.0.0」のハードコードから `getVersion()`
// （`@tauri-apps/api/app`、Tauriが`tauri.conf.json`のバージョンを返す）に変更した。
const getVersion = vi.fn();
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: (...args: unknown[]) => getVersion(...args),
}));

import { InfoSection } from './InfoSection';
import { ConfirmDialogHost } from '../ConfirmDialog';

function renderInfo() {
  return render(
    <>
      <InfoSection />
      <ConfirmDialogHost />
    </>,
  );
}

const clickDialogButton = (name: string) =>
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText(name));

beforeEach(() => {
  openUrl.mockReset();
  resetAllData.mockReset();
  getVersion.mockReset().mockResolvedValue('1.2.3');
});

describe('InfoSection version display (#66 問題7)', () => {
  it('shows the version returned by getVersion(), not a hardcoded value', async () => {
    render(<InfoSection />);

    await waitFor(() => {
      expect(screen.getByText('バージョン: 1.2.3')).toBeTruthy();
    });
    expect(screen.queryByText('バージョン: 1.0.0')).toBeNull();
  });

  it('logs and does not crash when getVersion() rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getVersion.mockRejectedValue(new Error('not available'));

    render(<InfoSection />);

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Failed to get app version:', expect.any(Error));
    });

    consoleError.mockRestore();
  });
});

describe('InfoSection GitHub link (openUrl)', () => {
  it('calls openUrl with the repository URL when clicked', async () => {
    render(<InfoSection />);

    fireEvent.click(screen.getByText('GitHubで見る'));

    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://github.com/kako-jun/sss');
    });
  });

  it('logs the error and does not throw when openUrl rejects', async () => {
    // 失敗系: openUrl が reject しても handleOpenGitHub の try/catch がそのまま機能する
    // ことを固定する（open → openUrl 移行で例外契約が変わっていないことの確認）。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    openUrl.mockRejectedValue(new Error('denied'));

    render(<InfoSection />);
    fireEvent.click(screen.getByText('GitHubで見る'));

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Failed to open GitHub:', expect.any(Error));
    });

    consoleError.mockRestore();
  });
});

// #64: 「すべてのデータを初期化」ボタンの 確認→実行 の流れ、および失敗時に日本語メッセージを
// 表示することを固定する。成功時は backend（reset_all_data）が最後にアプリの
// プロセス自体を再起動するため、フロント側は resetAllData() を呼ぶだけで以降は
// 何もしない（window.location.reload() 等は呼ばない。プロセスごと終了して
// ようこそ画面から再スタートする）。
// #79レビュー nit: 確認ダイアログ・実行中メッセージには「完了後アプリが再起動する」
// ことを明記する。実行中メッセージ（ボタン下の補足欄）はボタン表示（「初期化中...」）
// と文言を分け、同じ文字列が2箇所に重複表示されないようにする。
describe('InfoSection reset button (resetAllData)', () => {
  const CONFIRM_TEXT =
    'すべてのデータを初期化しますか？\n\n設定、除外ルール、スキャン済みのファイル情報、プレイリスト、スキャン履歴、表示履歴、キャッシュを削除し、前回のフォルダも忘れます。ピック先の設定は既定（ピクチャフォルダ内の sss-picked）に戻り、ピックタブにはそのフォルダのファイルが表示されます。ピック先を変更していた場合、以前のピック先のファイルは削除されませんがタブには表示されなくなります。ウィンドウの位置・サイズは保持されます。\n\nこの操作は取り消せません。完了後アプリが再起動します。';

  // #119: 実アプリでは window.confirm が Promise 版に差し替わっており、確認なしで
  // 初期化が走っていた。setup.ts の Promise 版 window.confirm の下でも、
  // アプリ内モーダルでキャンセル/ESC/背景クリックした時に resetAllData が呼ばれない。
  it('opens an alertdialog (not window.confirm) and does not call resetAllData until confirmed', () => {
    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const describedBy = dialog.getAttribute('aria-describedby') as string;
    expect(document.getElementById(describedBy)?.textContent).toBe(CONFIRM_TEXT);
    expect(resetAllData).not.toHaveBeenCalled();
  });

  it('does not call resetAllData when cancelled via the Cancel button', () => {
    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    clickDialogButton('キャンセル');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(resetAllData).not.toHaveBeenCalled();
  });

  it('does not call resetAllData when cancelled via ESC', () => {
    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(resetAllData).not.toHaveBeenCalled();
  });

  it('does not call resetAllData when the backdrop is clicked', () => {
    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(resetAllData).not.toHaveBeenCalled();
  });

  it('does not call resetAllData when the click lands inside the panel (not the backdrop)', () => {
    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    fireEvent.click(screen.getByRole('alertdialog'));

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(resetAllData).not.toHaveBeenCalled();
  });

  it('does not call resetAllData when no ConfirmDialogHost is mounted (fail-safe: cancel)', async () => {
    render(<InfoSection />);
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    await act(async () => {});

    expect(resetAllData).not.toHaveBeenCalled();
  });

  it('calls resetAllData when confirmed, and leaves the button disabled afterward without reloading', async () => {
    // 実際の本番環境では、成功すればバックエンドがプロセスごと再起動するため
    // このinvokeは戻ってこない。テストではモックがresolveするが、それでも
    // コンポーネント側はreload等の後処理を一切行わないことを固定する。
    resetAllData.mockResolvedValue(undefined);

    renderInfo();
    const button = screen
      .getByText('すべてのデータを初期化')
      .closest('button') as HTMLButtonElement;
    fireEvent.click(button);
    clickDialogButton('すべてのデータを初期化');

    // 実行中はボタンが無効化される（重複クリック防止）。確認は非同期（await）なので待つ。
    await waitFor(() => expect(button.disabled).toBe(true));
    // ボタン表示（「初期化中...」）とは別に、再起動する旨のメッセージを表示する
    // （#79レビュー nit: 同じ文字列の重複表示を避ける）。
    expect(screen.getByText('初期化しています。完了後アプリが再起動します。')).toBeTruthy();

    await waitFor(() => {
      expect(resetAllData).toHaveBeenCalledTimes(1);
    });

    // 成功後も再起動を待つだけで、ボタンを再度有効化する処理は無い
    // （isResettingをfalseに戻すのはcatchブロックのみ）。
    expect(button.disabled).toBe(true);
  });

  it('shows a Japanese error message and re-enables the button when resetAllData fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // #64: scan_in_progress中の拒否も含め、バックエンドのエラーはエラーコードの
    // 文字列として reject される（Tauri commandの `Result<_, String>`。#80でコード化）。
    // フロントは `resolveResetAllDataErrorMessage` でロケールに応じた文言へ変換する。
    resetAllData.mockRejectedValue('scanInProgress');

    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    clickDialogButton('すべてのデータを初期化');

    // このリポには @testing-library/jest-dom が導入されていないため toBeInTheDocument() 等は
    // 使わず、getBy*（見つからなければ throw）を waitFor 内で呼ぶだけで存在確認とする
    // （ScanSection.test.tsx と同じ流儀）。
    await waitFor(() => {
      expect(screen.getByText('エラー: スキャン実行中です。完了までお待ちください。')).toBeTruthy();
    });

    // ボタンが再度クリックできる状態（disabled解除）に戻ること
    const button = screen
      .getByText('すべてのデータを初期化')
      .closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    consoleError.mockRestore();
  });

  // #82レビューshould1: resetMessageは確定済み文言でなく状態種別＋生コードで保持し、
  // レンダーのたびに現在のロケールへ解決する。表示中に言語を切り替えても
  // 新旧混在しないことを固定する。
  it('re-resolves the reset error message to the new language after switching locale mid-display', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetAllData.mockRejectedValue('scanInProgress');

    renderInfo();
    fireEvent.click(screen.getByText('すべてのデータを初期化'));
    clickDialogButton('すべてのデータを初期化');

    await waitFor(() => {
      expect(screen.getByText('エラー: スキャン実行中です。完了までお待ちください。')).toBeTruthy();
    });

    act(() => {
      setLanguageSetting('en');
    });

    await waitFor(() => {
      expect(
        screen.getByText('Error: A scan is already in progress. Please wait for it to finish.'),
      ).toBeTruthy();
    });
    expect(screen.queryByText('エラー: スキャン実行中です。完了までお待ちください。')).toBeNull();

    consoleError.mockRestore();
  });
});

// #112: en のボタン・確認ダイアログ文言と、破壊範囲（ピック先フォルダのファイルは残る）の表現を固定する。
describe('InfoSection reset button in English (#112)', () => {
  it('shows "Reset All Data" and the full confirmation text in the in-app dialog', () => {
    act(() => {
      setLanguageSetting('en');
    });

    renderInfo();
    fireEvent.click(screen.getByText('Reset All Data'));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain(
      'Reset all data?\n\nThis deletes your settings, exclude rules, scanned file information, playlist, scan history, display history, and caches, and forgets the last folder. The pick destination setting returns to the default (the sss-picked folder in Pictures), and the Picks tab shows the files in that folder. If you had changed it, files in your previous pick destination are not deleted but no longer appear in the tab. Window position and size are kept.\n\nThis cannot be undone. The app will restart when finished.',
    );
    expect(within(dialog).getByText('Reset All Data')).toBeTruthy();
    expect(resetAllData).not.toHaveBeenCalled();
  });
});
