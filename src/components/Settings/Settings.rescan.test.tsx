// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguageSetting } from '../../lib/i18n/store';

// #111: 除外ルール変更後の再スキャン案内は Settings（親）が状態を持つ。
// タブ往復・フォルダタブのスキャン・履歴タブの除外との連動という「配線」を固定する。
const getIgnorePatterns = vi.fn();
const addIgnorePattern = vi.fn();
const removeIgnorePattern = vi.fn();
const rescanLastDirectory = vi.fn();
const getLastDirectoryPath = vi.fn();
const getRecentImages = vi.fn();
const excludeImage = vi.fn();
const getThumbnail = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getIgnorePatterns: (...a: unknown[]) => getIgnorePatterns(...a),
  addIgnorePattern: (...a: unknown[]) => addIgnorePattern(...a),
  removeIgnorePattern: (...a: unknown[]) => removeIgnorePattern(...a),
  rescanLastDirectory: (...a: unknown[]) => rescanLastDirectory(...a),
  selectAndScan: vi.fn(),
  getLastDirectoryPath: (...a: unknown[]) => getLastDirectoryPath(...a),
  getRecentImages: (...a: unknown[]) => getRecentImages(...a),
  excludeImage: (...a: unknown[]) => excludeImage(...a),
  getThumbnail: (...a: unknown[]) => getThumbnail(...a),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { Settings } from './index';

const progress = (totalFiles: number) => ({
  totalFiles,
  newFiles: 0,
  deletedFiles: 0,
  durationMs: 10,
  errorCount: 0,
  errorExamples: [],
});

const NOW = '今すぐ再スキャン';

function setup() {
  const onScanComplete = vi.fn();
  render(<Settings isOpen onClose={() => {}} onScanComplete={onScanComplete} />);
  return { onScanComplete };
}
const tab = (id: string) => fireEvent.click(document.getElementById(`tab-${id}`)!);

async function addRule(pattern: string) {
  const input = await screen.findByPlaceholderText(/パターンを入力/);
  fireEvent.change(input, { target: { value: pattern } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

beforeEach(() => {
  setLanguageSetting('ja');
  getIgnorePatterns.mockReset().mockResolvedValue([]);
  addIgnorePattern.mockReset().mockResolvedValue(undefined);
  removeIgnorePattern.mockReset().mockResolvedValue(undefined);
  rescanLastDirectory.mockReset();
  getLastDirectoryPath.mockReset().mockResolvedValue('/photos');
  getRecentImages
    .mockReset()
    .mockResolvedValue([
      { path: '/photos/a.jpg', displayCount: 1, lastDisplayed: '2026-01-01T00:00:00Z' },
    ]);
  excludeImage.mockReset();
  getThumbnail.mockReset().mockResolvedValue({ kind: 'image', path: '/cache/t.jpg' });
});

describe('Settings exclude-rescan wiring (#111)', () => {
  it('survives a tab round trip during a rescan: button stays disabled, one IPC, change made meanwhile keeps its notice', async () => {
    let resolve!: (v: ReturnType<typeof progress>) => void;
    rescanLastDirectory.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onScanComplete } = setup();
    tab('exclude');
    await addRule('**/a/');
    fireEvent.click(await screen.findByRole('button', { name: NOW }));
    await screen.findByRole('button', { name: '再スキャン中...' });

    tab('history');
    tab('exclude');
    const busy = await screen.findByRole('button', { name: '再スキャン中...' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(rescanLastDirectory).toHaveBeenCalledTimes(1);

    // 実行中（戻ったあと）に追加したルール
    await addRule('**/b/');
    await screen.findByText('**/b/');

    resolve(progress(7));
    await waitFor(() => expect(onScanComplete).toHaveBeenCalledTimes(1));
    // b は今回の再スキャンに間に合っていないので案内が残る
    expect(await screen.findByText(/除外ルールを追加しました: \*\*\/b\//)).toBeTruthy();
    expect(rescanLastDirectory).toHaveBeenCalledTimes(1);
  });

  it('shows the completion message on return when the rescan finished while on another tab, and drops it after it was seen (N4)', async () => {
    let resolve!: (v: ReturnType<typeof progress>) => void;
    rescanLastDirectory.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    tab('exclude');
    await addRule('**/a/');
    fireEvent.click(await screen.findByRole('button', { name: NOW }));
    await screen.findByRole('button', { name: '再スキャン中...' });
    tab('history');
    resolve(progress(5));
    await waitFor(() => expect(rescanLastDirectory).toHaveBeenCalledTimes(1));
    tab('exclude');
    expect(await screen.findByText(/再スキャンしました。除外ルールを反映しました/)).toBeTruthy();
    // 見終えて離れたら、次に開いたときには残っていない
    tab('history');
    tab('exclude');
    await screen.findByPlaceholderText(/パターンを入力/);
    expect(screen.queryByText(/再スキャンしました/)).toBeNull();
  });

  it('keeps the notice across a tab round trip', async () => {
    setup();
    tab('exclude');
    await addRule('**/a/');
    await screen.findByRole('button', { name: NOW });
    tab('history');
    tab('exclude');
    expect(await screen.findByRole('button', { name: NOW })).toBeTruthy();
  });

  it('clears the notice after a successful scan from the Folder tab', async () => {
    rescanLastDirectory.mockResolvedValue(progress(3));
    const { onScanComplete } = setup();
    tab('exclude');
    await addRule('**/a/');
    await screen.findByRole('button', { name: NOW });
    tab('scan');
    fireEvent.click(await screen.findByRole('button', { name: 'スキャン' }));
    await waitFor(() => expect(onScanComplete).toHaveBeenCalledTimes(1));
    tab('exclude');
    await screen.findByPlaceholderText(/パターンを入力/);
    expect(screen.queryByRole('button', { name: NOW })).toBeNull();
    expect(screen.queryByTestId('exclude-rescan-notice')).toBeNull();
  });

  it('shows the notice on the Exclude tab after a folder exclusion from the History tab', async () => {
    excludeImage.mockResolvedValue({
      pattern: '/photos/{**,*}',
      needsRescan: true,
      ruleType: 'glob',
      ruleAdded: true,
      removedPaths: [],
    });
    setup();
    tab('history');
    fireEvent.click(await screen.findByTitle('除外'));
    fireEvent.click(screen.getByText('このフォルダを除外'));
    await screen.findByText(/除外パターン追加/);
    tab('exclude');
    expect(await screen.findByText(/除外ルールを追加しました: \/photos\//)).toBeTruthy();
    expect(screen.getByRole('button', { name: NOW })).toBeTruthy();
  });
});
