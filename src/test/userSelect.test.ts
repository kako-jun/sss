import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';

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

  // 要素単位の検証: 各ファイルで「この中身を含む JSX 要素」が className に select-text を持つこと。
  // （出現数だけでは別の要素に付け替えても通ってしまうため、構文木で要素とその中身を突き合わせる。）
  const EXPECTED: Array<[string, string]> = [
    ['components/ConfirmDialog.tsx', '{body}'],
    ['components/ConfirmDialog.tsx', '{finalParagraph}'],
    ['components/Settings/ScanSection.tsx', '{errorMessage}'],
    ['components/Settings/ScanSection.tsx', '{example}'],
    ['components/Settings/ExcludeRulesSection.tsx', '{rescanErrorMessage}'],
    ['components/Settings/ExcludeRulesSection.tsx', '{addErrorMessage}'],
    ['components/Settings/ExcludeRulesSection.tsx', '{pattern}'],
    ['components/Settings/HistorySection.tsx', 'role="alert"'],
    ['components/Settings/ShareDirectorySection.tsx', 'role="alert"'],
    ['components/Settings/InfoSection.tsx', "t('versionLabel'"],
    ['components/Settings/GraphSection.tsx', '{meanText}'],
    ['components/Settings/GraphSection.tsx', 'displayStats.bins'],
    ['components/OverlayUI.tsx', '{fileNameParts.head}'],
    ['components/OverlayUI.tsx', '{capturedDate}'],
    ['App.tsx', '{directoryErrorMessage}'],
  ];

  function selectTextElements(file: string): string[] {
    const src = readFileSync(join(SRC, file), 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const cls = opening.attributes.properties.find(
          (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'className',
        );
        if (cls && /(^|[\s"'`])select-text($|[\s"'`])/.test(cls.getText(sf))) {
          out.push(node.getText(sf));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  it.each(EXPECTED)('%s: %s を含む要素に select-text が付いている', (file, needle) => {
    expect(selectTextElements(file).some((el) => el.includes(needle))).toBe(true);
  });
});
