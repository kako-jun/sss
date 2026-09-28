// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { IgnoreRule } from '../../types';
import { setLanguageSetting } from '../../lib/i18n/store';

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

  // #61レビュー S2: 不正なglob（閉じていない `{` 等）は addIgnorePattern がバックエンドの
  // Err文字列で reject するようになった。従来は画面上に何も表示されなかったので、
  // エラーメッセージが表示されること・ルール一覧に追加されないことをピン留めする。
  // #80: バックエンドは "invalidPattern:{detail}" 形式のエラーコードを返すようになり、
  // フロントは `resolveAddPatternErrorMessage` でロケールに応じた文言へ変換する。
  it('shows the translated backend error message and does not add the rule when addIgnorePattern rejects', async () => {
    getIgnorePatterns.mockResolvedValue([]);
    addIgnorePattern.mockRejectedValue('invalidPattern:unclosed alternate group');

    render(<ExcludeRulesSection />);

    await waitFor(() => {
      expect(screen.getByText('除外ルールはありません')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText('パターンを入力（例: **/thumbs/）');
    fireEvent.change(input, { target: { value: 'a{b.jpg' } });
    fireEvent.click(screen.getByText('追加'));

    await waitFor(() => {
      expect(screen.getByText('無効なパターンです: unclosed alternate group')).toBeTruthy();
    });
    expect(screen.queryByText('a{b.jpg')).toBeNull();
    expect(screen.getByText('除外ルールはありません')).toBeTruthy();

    // 入力を変えるとエラーが消える
    fireEvent.change(input, { target: { value: 'a{b.jpg2' } });
    expect(screen.queryByText('無効なパターンです: unclosed alternate group')).toBeNull();
  });

  // #82レビューshould1: addErrorは確定済み文言でなく生コードで保持し、レンダーの
  // たびに現在のロケールへ解決する。表示中に言語を切り替えても新旧混在しない。
  it('re-resolves the add-pattern error message to the new language after switching locale mid-display', async () => {
    getIgnorePatterns.mockResolvedValue([]);
    addIgnorePattern.mockRejectedValue('invalidPattern:unclosed alternate group');

    render(<ExcludeRulesSection />);
    await waitFor(() => {
      expect(screen.getByText('除外ルールはありません')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText('パターンを入力（例: **/thumbs/）');
    fireEvent.change(input, { target: { value: 'a{b.jpg' } });
    fireEvent.click(screen.getByText('追加'));

    await waitFor(() => {
      expect(screen.getByText('無効なパターンです: unclosed alternate group')).toBeTruthy();
    });

    act(() => {
      setLanguageSetting('en');
    });

    await waitFor(() => {
      expect(screen.getByText('Invalid pattern: unclosed alternate group')).toBeTruthy();
    });
    expect(screen.queryByText('無効なパターンです: unclosed alternate group')).toBeNull();
  });

  // #61レビュー nit: ignore_rulesの主キーが (pattern, ruleType) の複合キーになったため、
  // 解除ボタンは pattern だけでなく ruleType も渡す。同じpattern文字列でrule_typeが
  // 違う行が2つあっても、片方だけ消せる（key衝突で両方消えたり、両方に手が届かない
  // という事故を防ぐ）。
  it('removes only the row matching both pattern and ruleType when duplicated pattern strings exist', async () => {
    const rules: IgnoreRule[] = [
      { pattern: '2020-01-01', ruleType: 'glob' },
      { pattern: '2020-01-01', ruleType: 'date' },
    ];
    getIgnorePatterns.mockResolvedValue(rules);
    removeIgnorePattern.mockResolvedValue(undefined);

    render(<ExcludeRulesSection />);

    await waitFor(() => {
      expect(screen.getAllByText('2020-01-01')).toHaveLength(2);
    });

    // 撮影日バッジが付いている方（date側）の解除ボタンを押す
    const dateRow = screen.getByText('撮影日').closest('div')!.parentElement!;
    fireEvent.click(dateRow.querySelector('button')!);

    expect(removeIgnorePattern).toHaveBeenCalledWith('2020-01-01', 'date');

    await waitFor(() => {
      expect(screen.getAllByText('2020-01-01')).toHaveLength(1);
    });
    // glob側は残っている（バッジなし）
    expect(screen.queryByText('撮影日')).toBeNull();
  });
});
