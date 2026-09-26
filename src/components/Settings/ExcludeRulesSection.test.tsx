// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { IgnoreRule } from '../../types';

// #61: getIgnorePatterns が pattern + ruleType（"glob" | "date"）を返すようになった。
// 撮影日ルール（ruleType: "date"）にだけ「撮影日」バッジが付き、通常globルールには
// 付かないことをピン留めする。
const getIgnorePatterns = vi.fn();
const removeIgnorePattern = vi.fn();
const addIgnorePattern = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getIgnorePatterns: (...args: unknown[]) => getIgnorePatterns(...args),
  removeIgnorePattern: (...args: unknown[]) => removeIgnorePattern(...args),
  addIgnorePattern: (...args: unknown[]) => addIgnorePattern(...args),
}));

import { ExcludeRulesSection } from './ExcludeRulesSection';

beforeEach(() => {
  getIgnorePatterns.mockReset();
  removeIgnorePattern.mockReset();
  addIgnorePattern.mockReset();
});

describe('ExcludeRulesSection captured-date badge (#61)', () => {
  it('shows a "撮影日" badge only on the date-type row, not on glob-type rows', async () => {
    const rules: IgnoreRule[] = [
      { pattern: '**/.thumbnails/', ruleType: 'glob' },
      { pattern: '2023-05-15', ruleType: 'date' },
    ];
    getIgnorePatterns.mockResolvedValue(rules);

    render(<ExcludeRulesSection />);

    await waitFor(() => {
      expect(screen.getByText('**/.thumbnails/')).toBeTruthy();
    });

    // ちょうど1件だけバッジが表示される（date ルールの分だけ）
    expect(screen.getAllByText('撮影日')).toHaveLength(1);

    // globルールの行には「撮影日」が含まれない
    const globRow = screen.getByText('**/.thumbnails/').closest('div');
    expect(globRow?.textContent).not.toContain('撮影日');

    // 撮影日ルールの行には含まれる
    const dateRow = screen.getByText('2023-05-15').closest('div');
    expect(dateRow?.textContent).toContain('撮影日');
  });

  it('renders no badge when every rule is a normal glob rule', async () => {
    const rules: IgnoreRule[] = [
      { pattern: '*.tmp', ruleType: 'glob' },
      { pattern: 'private/', ruleType: 'glob' },
    ];
    getIgnorePatterns.mockResolvedValue(rules);

    render(<ExcludeRulesSection />);

    await waitFor(() => {
      expect(screen.getByText('*.tmp')).toBeTruthy();
    });

    expect(screen.queryByText('撮影日')).toBeNull();
  });

  it('shows badges on every row when all rules are date rules', async () => {
    const rules: IgnoreRule[] = [
      { pattern: '2023-05-15', ruleType: 'date' },
      { pattern: '2024-02-29', ruleType: 'date' },
    ];
    getIgnorePatterns.mockResolvedValue(rules);

    render(<ExcludeRulesSection />);

    await waitFor(() => {
      expect(screen.getAllByText('撮影日')).toHaveLength(2);
    });
  });

  it('manually added rule has no badge (manual add is always rule_type: glob)', async () => {
    getIgnorePatterns.mockResolvedValue([]);
    addIgnorePattern.mockResolvedValue(undefined);

    render(<ExcludeRulesSection />);

    await waitFor(() => {
      expect(screen.getByText('除外ルールはありません')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText('パターンを入力（例: **/thumbs/）');
    fireEvent.change(input, { target: { value: '*.bak' } });
    fireEvent.click(screen.getByText('追加'));

    await waitFor(() => {
      expect(screen.getByText('*.bak')).toBeTruthy();
    });
    expect(screen.queryByText('撮影日')).toBeNull();
  });
});
