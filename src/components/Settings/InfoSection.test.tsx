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
