// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

// #64: 「設定を初期化」ボタンの 確認→実行 の流れ、および失敗時に日本語メッセージを
// 表示することを固定する。成功時は backend（reset_all_data）が最後にアプリの
// プロセス自体を再起動するため、フロント側は resetAllData() を呼ぶだけで以降は
// 何もしない（window.location.reload() 等は呼ばない。プロセスごと終了して
// ようこそ画面から再スタートする）。
// #79レビュー nit: 確認ダイアログ・実行中メッセージには「完了後アプリが再起動する」
// ことを明記する。実行中メッセージ（ボタン下の補足欄）はボタン表示（「初期化中...」）
// と文言を分け、同じ文字列が2箇所に重複表示されないようにする。
describe('InfoSection reset button (resetAllData)', () => {
  it('does not call resetAllData when the confirmation dialog is declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<InfoSection />);
    fireEvent.click(screen.getByText('設定を初期化'));

    expect(confirmSpy).toHaveBeenCalledWith(
      '全ての設定、プレイリスト、表示履歴を完全に削除して初期化しますか？\n\nこの操作は取り消せません。完了後アプリが再起動します。',
    );
    expect(resetAllData).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('calls resetAllData when confirmed, and leaves the button disabled afterward without reloading', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // 実際の本番環境では、成功すればバックエンドがプロセスごと再起動するため
    // このinvokeは戻ってこない。テストではモックがresolveするが、それでも
    // コンポーネント側はreload等の後処理を一切行わないことを固定する。
    resetAllData.mockResolvedValue(undefined);

    render(<InfoSection />);
    const button = screen.getByText('設定を初期化').closest('button') as HTMLButtonElement;
    fireEvent.click(button);

    // 実行中はボタンが無効化される（重複クリック防止）
    expect(button.disabled).toBe(true);
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
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // #64: scan_in_progress中の拒否も含め、バックエンドのエラーはエラーコードの
    // 文字列として reject される（Tauri commandの `Result<_, String>`。#80でコード化）。
    // フロントは `resolveResetAllDataErrorMessage` でロケールに応じた文言へ変換する。
    resetAllData.mockRejectedValue('scanInProgress');

    render(<InfoSection />);
    fireEvent.click(screen.getByText('設定を初期化'));

    // このリポには @testing-library/jest-dom が導入されていないため toBeInTheDocument() 等は
    // 使わず、getBy*（見つからなければ throw）を waitFor 内で呼ぶだけで存在確認とする
    // （ScanSection.test.tsx と同じ流儀）。
    await waitFor(() => {
      expect(screen.getByText('エラー: スキャン実行中です。完了までお待ちください。')).toBeTruthy();
    });

    // ボタンが再度クリックできる状態（disabled解除）に戻ること
    const button = screen.getByText('設定を初期化').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    consoleError.mockRestore();
  });

  // #82レビューshould1: resetMessageは確定済み文言でなく状態種別＋生コードで保持し、
  // レンダーのたびに現在のロケールへ解決する。表示中に言語を切り替えても
  // 新旧混在しないことを固定する。
  it('re-resolves the reset error message to the new language after switching locale mid-display', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetAllData.mockRejectedValue('scanInProgress');

    render(<InfoSection />);
    fireEvent.click(screen.getByText('設定を初期化'));

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
