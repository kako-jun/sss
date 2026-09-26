// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import { InfoSection } from './InfoSection';

beforeEach(() => {
  openUrl.mockReset();
  resetAllData.mockReset();
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

// #64: 「設定を初期化」ボタンの 確認→実行→ようこそ画面へ戻る流れ、および
// エラー時に日本語メッセージを表示することを固定する。
describe('InfoSection reset button (resetAllData)', () => {
  it('does not call resetAllData when the confirmation dialog is declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<InfoSection />);
    fireEvent.click(screen.getByText('設定を初期化'));

    expect(confirmSpy).toHaveBeenCalledWith(
      '全ての設定、プレイリスト、表示履歴を完全に削除して初期化しますか？\n\nこの操作は取り消せません。',
    );
    expect(resetAllData).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('calls resetAllData and reloads the page when confirmed and successful', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    resetAllData.mockResolvedValue(undefined);

    render(<InfoSection />);
    const button = screen.getByText('設定を初期化').closest('button') as HTMLButtonElement;
    fireEvent.click(button);

    // 実行中はボタンが無効化される（重複クリック防止）
    expect(button.disabled).toBe(true);

    await waitFor(() => {
      expect(resetAllData).toHaveBeenCalledTimes(1);
      // ようこそ画面へ戻る唯一の経路（App側の状態を作り直すためリロードする）
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a Japanese error message and re-enables the button without reloading when resetAllData fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    // #64: scan_in_progress中の拒否も含め、バックエンドのエラーは日本語メッセージの
    // 文字列として reject される（Tauri commandの `Result<_, String>`）。
    resetAllData.mockRejectedValue('スキャン実行中です。完了までお待ちください。');

    render(<InfoSection />);
    fireEvent.click(screen.getByText('設定を初期化'));

    // このリポには @testing-library/jest-dom が導入されていないため toBeInTheDocument() 等は
    // 使わず、getBy*（見つからなければ throw）を waitFor 内で呼ぶだけで存在確認とする
    // （ScanSection.test.tsx と同じ流儀）。
    await waitFor(() => {
      expect(screen.getByText('エラー: スキャン実行中です。完了までお待ちください。')).toBeTruthy();
    });

    expect(reloadSpy).not.toHaveBeenCalled();
    // ボタンが再度クリックできる状態（disabled解除）に戻ること
    const button = screen.getByText('設定を初期化').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    consoleError.mockRestore();
  });
});
