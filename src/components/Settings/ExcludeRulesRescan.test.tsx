// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguageSetting } from '../../lib/i18n/store';

// #111: 除外ルールの追加・削除は DB に書くだけでプレイリストへ反映されない。
// 変更直後に「再スキャンが必要」の案内（1件に集約）と「今すぐ再スキャン」ボタンを出し、
// ボタンで rescan_last_directory を呼ぶ。自動では再スキャンしない。
const getIgnorePatterns = vi.fn();
const removeIgnorePattern = vi.fn();
const addIgnorePattern = vi.fn();
const rescanLastDirectory = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getIgnorePatterns: (...args: unknown[]) => getIgnorePatterns(...args),
  removeIgnorePattern: (...args: unknown[]) => removeIgnorePattern(...args),
  addIgnorePattern: (...args: unknown[]) => addIgnorePattern(...args),
  rescanLastDirectory: (...args: unknown[]) => rescanLastDirectory(...args),
}));

import {
  ExcludeRulesSection,
  foldExcludeRescanNotice,
  type ExcludeRescanNotice,
} from './ExcludeRulesSection';

const progress = (totalFiles: number) => ({
  totalFiles,
  newFiles: 0,
  deletedFiles: 0,
  durationMs: 10,
  errorCount: 0,
  errorExamples: [],
});

// Settings（親）と同じ配線: 案内状態は親が持ち、成功時に applied なら消す。
function Harness({ onScanComplete }: { onScanComplete: () => void }) {
  const [notice, setNotice] = useState<ExcludeRescanNotice | null>(null);
  return (
    <ExcludeRulesSection
      notice={notice}
      onRuleChanged={(c) => setNotice((p) => foldExcludeRescanNotice(p, c))}
      onRescanned={(applied) => {
        if (applied) setNotice(null);
        onScanComplete();
      }}
    />
  );
}

beforeEach(() => {
  getIgnorePatterns.mockReset().mockResolvedValue([{ pattern: '**/old/', ruleType: 'glob' }]);
  removeIgnorePattern.mockReset().mockResolvedValue(undefined);
  addIgnorePattern.mockReset().mockResolvedValue(undefined);
  rescanLastDirectory.mockReset();
  setLanguageSetting('ja');
});

afterEach(() => {
  setLanguageSetting('ja');
});

async function addRule(pattern: string) {
  const input = await screen.findByPlaceholderText(/パターンを入力|Enter a pattern/);
  fireEvent.change(input, { target: { value: pattern } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('ExcludeRulesSection rescan notice (#111)', () => {
  it('shows no notice before any change', async () => {
    render(<Harness onScanComplete={() => {}} />);
    await screen.findByText('**/old/');
    expect(screen.queryByTestId('exclude-rescan-notice')).toBeNull();
  });

  it('shows the add notice and does NOT rescan automatically', async () => {
    render(<Harness onScanComplete={() => {}} />);
    await addRule('**/thumbs/');
    await waitFor(() => {
      expect(
        screen.getByText(
          /除外ルールを追加しました: \*\*\/thumbs\/。反映するには再スキャンが必要です/,
        ),
      ).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '今すぐ再スキャン' })).toBeTruthy();
    expect(rescanLastDirectory).not.toHaveBeenCalled();
  });

  it('shows the remove notice (different wording) after removing a rule', async () => {
    render(<Harness onScanComplete={() => {}} />);
    await screen.findByText('**/old/');
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    await waitFor(() => {
      expect(
        screen.getByText(/除外ルールを解除しました: \*\*\/old\/。再スキャンすると/),
      ).toBeTruthy();
    });
    expect(rescanLastDirectory).not.toHaveBeenCalled();
  });

  it('keeps a single notice for consecutive changes (generic wording, no duplicates)', async () => {
    render(<Harness onScanComplete={() => {}} />);
    await addRule('**/a/');
    await screen.findByText(/除外ルールを追加しました: \*\*\/a\//);
    await addRule('**/b/');
    await waitFor(() => {
      expect(
        screen.getByText('除外ルールを変更しました。反映するには再スキャンが必要です'),
      ).toBeTruthy();
    });
    expect(screen.getAllByTestId('exclude-rescan-notice')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '今すぐ再スキャン' })).toHaveLength(1);
  });

  it('calls rescanLastDirectory (no args) on click, shows scanning state, then done and clears the notice', async () => {
    let resolve!: (v: ReturnType<typeof progress>) => void;
    rescanLastDirectory.mockReturnValue(new Promise((r) => (resolve = r)));
    const onScanComplete = vi.fn();
    render(<Harness onScanComplete={onScanComplete} />);
    await addRule('**/thumbs/');
    fireEvent.click(await screen.findByRole('button', { name: '今すぐ再スキャン' }));

    expect(rescanLastDirectory).toHaveBeenCalledTimes(1);
    expect(rescanLastDirectory).toHaveBeenCalledWith();
    const busy = await screen.findByRole('button', { name: '再スキャン中...' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy); // 二重実行されない
    expect(rescanLastDirectory).toHaveBeenCalledTimes(1);

    resolve(progress(1234));
    await waitFor(() => {
      expect(
        screen.getByText('再スキャンしました。除外ルールを反映しました（1,234件）'),
      ).toBeTruthy();
    });
    expect(onScanComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '今すぐ再スキャン' })).toBeNull();
  });

  it('shows the error and keeps the notice + button when the rescan fails', async () => {
    rescanLastDirectory.mockRejectedValue('directoryNotFound:/mnt/gone');
    const onScanComplete = vi.fn();
    render(<Harness onScanComplete={onScanComplete} />);
    await addRule('**/thumbs/');
    fireEvent.click(await screen.findByRole('button', { name: '今すぐ再スキャン' }));
    await waitFor(() => {
      expect(screen.getByText('指定したフォルダが見つかりません: /mnt/gone')).toBeTruthy();
    });
    expect(onScanComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '今すぐ再スキャン' })).toBeTruthy();
  });

  it('keeps the notice when a rule changes while the rescan is running', async () => {
    let resolve!: (v: ReturnType<typeof progress>) => void;
    rescanLastDirectory.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Harness onScanComplete={() => {}} />);
    await addRule('**/a/');
    fireEvent.click(await screen.findByRole('button', { name: '今すぐ再スキャン' }));
    await screen.findByRole('button', { name: '再スキャン中...' });
    await addRule('**/b/'); // 実行中に追加（このルールは今回の再スキャンに間に合っていない）
    await screen.findByText('**/b/');
    resolve(progress(10));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '今すぐ再スキャン' })).toBeTruthy();
    });
  });

  it('renders the English wording', async () => {
    setLanguageSetting('en');
    render(<Harness onScanComplete={() => {}} />);
    await addRule('**/thumbs/');
    await waitFor(() => {
      expect(
        screen.getByText('Exclude rule added: **/thumbs/. Rescan to apply the change'),
      ).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Rescan now' })).toBeTruthy();
  });
});

describe('foldExcludeRescanNotice (#111)', () => {
  it('keeps the first change as is and folds later ones into "multiple"', () => {
    const first = foldExcludeRescanNotice(null, { kind: 'added', pattern: 'x' });
    expect(first).toEqual({ kind: 'added', pattern: 'x' });
    expect(foldExcludeRescanNotice(first, { kind: 'removed', pattern: 'y' })).toEqual({
      kind: 'multiple',
    });
  });
});
