// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setLanguageSetting } from '../../lib/i18n/store';

// #73: スキャン系コマンドが asset scope の安全性チェックで拒否されると Err(String) を返す
// ようになった。Tauri コマンドの Err(String) は Error インスタンスではなく素の文字列で
// reject されるため（handleScan の catch 参照）。
// #80: バックエンドはユーザー向け文言でなくエラーコード（例: "directoryUnsafe"）を
// 返すようになった。フロントは `resolveScanErrorMessage` でロケールに応じた文言へ
// 変換して表示する（未知のコードはそのまま表示するフォールバックのみピン留めする）。
// #93: 「スキャン」ボタンは DB 保存済みの前回フォルダの再スキャン（rescanLastDirectory、引数なし）、
// 「選択」ボタンは Rust 側のダイアログ選択+スキャン（selectAndScan）。どちらもパスを渡さない。
const rescanLastDirectory = vi.fn();
const getLastDirectoryPath = vi.fn();
const selectAndScan = vi.fn();

vi.mock('../../lib/tauri', () => ({
  rescanLastDirectory: (...args: unknown[]) => rescanLastDirectory(...args),
  getLastDirectoryPath: (...args: unknown[]) => getLastDirectoryPath(...args),
  selectAndScan: (...args: unknown[]) => selectAndScan(...args),
}));

const listen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import { ScanSection } from './ScanSection';

beforeEach(() => {
  rescanLastDirectory.mockReset();
  getLastDirectoryPath.mockReset();
  selectAndScan.mockReset();
  listen.mockReset();

  getLastDirectoryPath.mockResolvedValue('/photos/existing');
  listen.mockResolvedValue(() => {});
});

async function clickScanOnceDirectoryLoaded() {
  render(<ScanSection onScanComplete={() => {}} />);

  // 前回ディレクトリの読み込み完了を待つ（読み込み前はスキャンボタンが disabled）。
  // このリポには @testing-library/jest-dom が導入されていないため toBeInTheDocument() 等は
  // 使わず、getBy*（見つからなければ throw）を waitFor 内で呼ぶだけで存在確認とする。
  await waitFor(() => {
    expect(screen.getByDisplayValue('/photos/existing')).toBeTruthy();
  });

  fireEvent.click(screen.getByText('スキャン'));
}

describe('ScanSection scan error display', () => {
  it('translates the "directoryUnsafe" error code and interpolates the attempted directory', async () => {
    // Rust側 commands::scan が sanitize_allow_dir で拒否した際に
    // 返す Err(String) を模した実際のエラーコード（#80）。
    rescanLastDirectory.mockRejectedValue('directoryUnsafe');

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(
        screen.getByText('セキュリティ上の理由でこのフォルダは使用できません: /photos/existing'),
      ).toBeTruthy();
    });
  });

  it('falls back to showing an unknown code as-is when the scan rejects with a plain string', async () => {
    rescanLastDirectory.mockRejectedValue('some future unrecognized code');

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('some future unrecognized code')).toBeTruthy();
    });
  });

  it('falls back to a generic message when the scan rejects with a non-string, non-Error value', async () => {
    // 同値分割: 文字列でも Error でもない reject 値（通常は起こらないが防御的分岐の確認）
    rescanLastDirectory.mockRejectedValue({ unexpected: 'shape' });

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('フォルダのスキャンに失敗しました')).toBeTruthy();
    });
  });

  it('shows an Error instance message when the scan rejects with an Error', async () => {
    rescanLastDirectory.mockRejectedValue(new Error('boom'));

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeTruthy();
    });
  });

  // #82レビューshould1: エラーは確定済み文言でなく生コードで保持し、レンダーの
  // たびに現在のロケールへ解決する。表示中に言語を切り替えても、旧言語の文言が
  // 残ったまま固まらず新しい言語へ即座に更新されることを固定する。
  it('re-resolves the shown error message to the new language after switching locale mid-display (no ja/en mixing)', async () => {
    rescanLastDirectory.mockRejectedValue('directoryUnsafe');
    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(
        screen.getByText('セキュリティ上の理由でこのフォルダは使用できません: /photos/existing'),
      ).toBeTruthy();
    });

    act(() => {
      setLanguageSetting('en');
    });

    await waitFor(() => {
      expect(
        screen.getByText("This folder can't be used for security reasons: /photos/existing"),
      ).toBeTruthy();
    });
    expect(
      screen.queryByText('セキュリティ上の理由でこのフォルダは使用できません: /photos/existing'),
    ).toBeNull();
  });
});

// #63: walkdir/メタデータ取得エラーはScanProgress.errorCount/errorExamplesとして
// 返ってくる。スキャン結果表示にそのまま出すことをピン留めする。
describe('ScanSection scan result error summary', () => {
  it('shows the error count and examples when the scan completed with errors', async () => {
    rescanLastDirectory.mockResolvedValue({
      totalFiles: 100,
      newFiles: 5,
      deletedFiles: 0,
      durationMs: 1234,
      errorCount: 2,
      errorExamples: ['/photos/broken.jpg: failed to read metadata'],
    });

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('2件')).toBeTruthy();
      expect(screen.getByText('/photos/broken.jpg: failed to read metadata')).toBeTruthy();
    });
  });

  it('does not show the error summary when the scan completed without errors', async () => {
    rescanLastDirectory.mockResolvedValue({
      totalFiles: 100,
      newFiles: 5,
      deletedFiles: 0,
      durationMs: 1234,
      errorCount: 0,
      errorExamples: [],
    });

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText(/ファイル数/)).toBeTruthy();
    });
    expect(screen.queryByText(/読み取りエラー/)).toBeNull();
  });
});

// #93: 「選択」ボタン = Rust 側ダイアログで選んでそのままスキャン。
describe('ScanSection select (dialog + scan in one command, #93)', () => {
  const progress = {
    totalFiles: 7,
    newFiles: 7,
    deletedFiles: 0,
    durationMs: 10,
    errorCount: 0,
    errorExamples: [],
  };

  async function renderLoaded(onScanComplete = () => {}) {
    render(<ScanSection onScanComplete={onScanComplete} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('/photos/existing')).toBeTruthy();
    });
  }

  it('select scans the chosen folder, shows the result, refreshes the displayed folder and notifies completion', async () => {
    const onScanComplete = vi.fn();
    selectAndScan.mockResolvedValue(progress);
    await renderLoaded(onScanComplete);
    getLastDirectoryPath.mockResolvedValue('/photos/chosen');

    fireEvent.click(screen.getByText('選択'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('/photos/chosen')).toBeTruthy();
    });
    expect(selectAndScan).toHaveBeenCalledTimes(1);
    expect(selectAndScan).toHaveBeenCalledWith();
    expect(rescanLastDirectory).not.toHaveBeenCalled();
    expect(onScanComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/ファイル数/)).toBeTruthy();
  });

  it('cancelling the dialog (null) is not an error: nothing changes and no completion is notified', async () => {
    const onScanComplete = vi.fn();
    selectAndScan.mockResolvedValue(null);
    await renderLoaded(onScanComplete);

    fireEvent.click(screen.getByText('選択'));

    await waitFor(() => expect(selectAndScan).toHaveBeenCalledTimes(1));
    // 進行状態が解除され（選択ボタンが再び押せる）エラーも結果も出ない
    await waitFor(() => {
      expect((screen.getByText('選択').closest('button') as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(onScanComplete).not.toHaveBeenCalled();
    expect(screen.queryByText(/ファイル数/)).toBeNull();
    expect(screen.queryByText(/見つかりません|使用できません/)).toBeNull();
    expect(screen.getByDisplayValue('/photos/existing')).toBeTruthy();
  });

  it('shows the localized message when the chosen folder is rejected by the backend', async () => {
    selectAndScan.mockRejectedValue('directoryUnsafe');
    await renderLoaded();

    fireEvent.click(screen.getByText('選択'));

    await waitFor(() => {
      expect(
        screen.getByText('セキュリティ上の理由でこのフォルダは使用できません: /photos/existing'),
      ).toBeTruthy();
    });
  });

  it('rescan shows the no-last-directory message when nothing was ever selected', async () => {
    rescanLastDirectory.mockRejectedValue('noLastDirectory');
    await renderLoaded();

    fireEvent.click(screen.getByText('スキャン'));

    await waitFor(() => {
      expect(screen.getByText('スキャンするフォルダがまだ選択されていません')).toBeTruthy();
    });
    expect(rescanLastDirectory).toHaveBeenCalledWith();
  });
});
