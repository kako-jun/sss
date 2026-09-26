// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// #73: scan_directory が asset scope の安全性チェックで拒否されると Err(String) を返す
// ようになった。Tauri コマンドの Err(String) は Error インスタンスではなく素の文字列で
// reject されるため（handleScan の catch 参照）、その文字列がそのままエラー表示に
// 使われることをピン留めする。
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
  it('shows the rejected string reason as-is when scan_directory rejects with a plain string', async () => {
    // Rust側 commands::scan::scan_directory が sanitize_allow_dir で拒否した際に
    // 返す Err(String) を模した、実際のメッセージ文言そのもの。
    const rejectionReason =
      'Cannot use this directory for security reasons (e.g. a system drive root): C:\\';
    scanDirectory.mockRejectedValue(rejectionReason);

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText(rejectionReason)).toBeTruthy();
    });
  });

  it('falls back to a generic message when scan_directory rejects with a non-string, non-Error value', async () => {
    // 同値分割: 文字列でも Error でもない reject 値（通常は起こらないが防御的分岐の確認）
    scanDirectory.mockRejectedValue({ unexpected: 'shape' });

    await clickScanOnceDirectoryLoaded();

    await waitFor(() => {
      expect(screen.getByText('Failed to scan directory')).toBeTruthy();
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
