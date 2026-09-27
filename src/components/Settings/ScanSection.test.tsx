// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// #73: scan_directory が asset scope の安全性チェックで拒否されると Err(String) を返す
// ようになった。Tauri コマンドの Err(String) は Error インスタンスではなく素の文字列で
// reject されるため（handleScan の catch 参照）。
// #80: バックエンドはユーザー向け文言でなくエラーコード（例: "directoryUnsafe"）を
// 返すようになった。フロントは `resolveScanErrorMessage` でロケールに応じた文言へ
// 変換して表示する（未知のコードはそのまま表示するフォールバックのみピン留めする）。
const scanDirectory = vi.fn();
const getLastDirectoryPath = vi.fn();
const selectDirectory = vi.fn();

vi.mock('../../lib/tauri', () => ({
  scanDirectory: (...args: unknown[]) => scanDirectory(...args),
  getLastDirectoryPath: (...args: unknown[]) => getLastDirectoryPath(...args),
  selectDirectory: (...args: unknown[]) => selectDirectory(...args),
}));

const listen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import { ScanSection } from './ScanSection';

beforeEach(() => {
  scanDirectory.mockReset();
  getLastDirectoryPath.mockReset();
  selectDirectory.mockReset();
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
    // Rust側 commands::scan::scan_directory が sanitize_allow_dir で拒否した際に
    // 返す Err(String) を模した実際のエラーコード（#80）。
    scanDirectory.mockRejectedValue('directoryUnsafe');

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(
        screen.getByText('セキュリティ上の理由でこのフォルダは使用できません: /photos/existing'),
      ).toBeTruthy();
    });
  });

  it('falls back to showing an unknown code as-is when scan_directory rejects with a plain string', async () => {
    scanDirectory.mockRejectedValue('some future unrecognized code');

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('some future unrecognized code')).toBeTruthy();
    });
  });

  it('falls back to a generic message when scan_directory rejects with a non-string, non-Error value', async () => {
    // 同値分割: 文字列でも Error でもない reject 値（通常は起こらないが防御的分岐の確認）
    scanDirectory.mockRejectedValue({ unexpected: 'shape' });

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('フォルダのスキャンに失敗しました')).toBeTruthy();
    });
  });

  it('shows an Error instance message when scan_directory rejects with an Error', async () => {
    scanDirectory.mockRejectedValue(new Error('boom'));

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeTruthy();
    });
  });
});

// #63: walkdir/メタデータ取得エラーはScanProgress.errorCount/errorExamplesとして
// 返ってくる。スキャン結果表示にそのまま出すことをピン留めする。
describe('ScanSection scan result error summary', () => {
  it('shows the error count and examples when the scan completed with errors', async () => {
    scanDirectory.mockResolvedValue({
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
    scanDirectory.mockResolvedValue({
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
