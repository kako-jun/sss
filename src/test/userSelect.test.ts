import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

// #116: Ctrl+A で画面全体が青くハイライトされない（body は user-select:none）一方、
// 入力欄・エラー詳細・確認モーダル本文など選択が有用な箇所は選択/コピーできることを、
// CSS と TSX の走査で固定する（実描画は e2e の "Ctrl+A ..." シナリオ）。

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function declsFor(selectorMatch: (sel: string) => boolean): Map<string, string> {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');
  const out = new Map<string, string>();
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.some(selectorMatch)) return;
    rule.walkDecls((d) => {
      out.set(d.prop, d.value);
    });
  });
  return out;
}

describe('user-select (#116)', () => {
  it('body は user-select:none（-webkit- 付きも）', () => {
    const d = declsFor((s) => s.trim() === 'body');
    expect(d.get('user-select')).toBe('none');
    expect(d.get('-webkit-user-select')).toBe('none');
  });

  it('input / textarea は user-select:text に戻す', () => {
    for (const tag of ['input', 'textarea']) {
      const d = declsFor((s) => s.trim() === tag);
      expect(d.get('user-select'), tag).toBe('text');
      expect(d.get('-webkit-user-select'), tag).toBe('text');
    }
  });

  it.each([
    ['components/ConfirmDialog.tsx', 2], // 本文・最終段落
    ['components/Settings/ScanSection.tsx', 2], // エラーメッセージ・読み取りエラー例
    ['components/Settings/ExcludeRulesSection.tsx', 3], // 再スキャン/追加エラー・パターン
    ['components/Settings/HistorySection.tsx', 1],
    ['components/Settings/ShareDirectorySection.tsx', 1],
    ['App.tsx', 1], // フォルダエラー詳細
  ])('%s は選択が有用な箇所に select-text を付ける（最低 %i 箇所）', (file, min) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    const count = (src.match(/\bselect-text\b/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(min);
  });
});
