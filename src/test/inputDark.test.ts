import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * #122: checkbox / radio / range はOS既定だと WebKit(Linux WebKitGTK)で未チェック時に
 * 白い箱になりダークテーマと不整合になる。全ての `<input type="checkbox|radio|range">` が
 * 型に対応する共通クラス(`sss-checkbox` / `sss-radio` / `sss-range`)を付け、CSS側が
 * appearance: none の自前描画を持つことを固定する(selectDark.test.ts と同じ方針)。
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLASS_FOR: Record<string, string> = {
  checkbox: 'sss-checkbox',
  radio: 'sss-radio',
  range: 'sss-range',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
  });
}

function classTokens(node: ts.Node | undefined): string[] | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text.split(/\s+/);
  if (ts.isTemplateExpression(node)) {
    const joined =
      node.head.text + node.templateSpans.map((sp) => '\u0000' + sp.literal.text).join('');
    return joined.split(/\s+/).filter((t) => !t.includes('\u0000'));
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return classTokens(node.expression);
  }
  if (ts.isJsxExpression(node)) return classTokens(node.expression);
  return null;
}

/** 条件式は全分岐がクラスを持つ場合のみ true。判定不能な動的式(cn() 等)は false(安全側=offender)。 */
function exprHasClass(node: ts.Node | undefined, cls: string): boolean {
  if (!node) return false;
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return exprHasClass(node.expression, cls);
  }
  if (ts.isConditionalExpression(node)) {
    return exprHasClass(node.whenTrue, cls) && exprHasClass(node.whenFalse, cls);
  }
  const tokens = classTokens(node);
  return tokens !== null && tokens.includes(cls);
}

interface Found {
  kind: string; // checkbox | radio | range | dynamic
  ok: boolean;
}

/** ソース中の各 checkbox/radio/range の input について、共通クラスの有無を返す。 */
function scanInputs(src: string): Found[] {
  const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const results: Found[] = [];
  const attrOf = (props: ts.JsxAttributes, name: string) =>
    props.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name,
    );
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === 'input'
    ) {
      const typeAttr = attrOf(node.attributes, 'type');
      let init: ts.Node | undefined = typeAttr?.initializer;
      if (init && ts.isJsxExpression(init)) init = init.expression;
      if (typeAttr && init && ts.isStringLiteralLike(init)) {
        const cls = CLASS_FOR[init.text];
        if (cls) {
          const classAttr = attrOf(node.attributes, 'className');
          results.push({ kind: init.text, ok: exprHasClass(classAttr?.initializer, cls) });
        }
      } else if (typeAttr) {
        // type が動的(変数・三項等)で型を特定できない → 検証不能として offender
        results.push({ kind: 'dynamic', ok: false });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : '';
      const first = node.arguments[0];
      if (
        callee === 'createElement' &&
        first &&
        ts.isStringLiteralLike(first) &&
        first.text === 'input'
      ) {
        results.push({ kind: 'dynamic', ok: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return results;
}

describe('scan helpers (#122)', () => {
  const oks = (src: string) => scanInputs(src).map((f) => f.ok);

  it('ignores comments/strings and non-target input types', () => {
    expect(scanInputs('{/* <input type="checkbox" /> */}')).toEqual([]);
    expect(scanInputs('const a = \'<input type="checkbox">\';')).toEqual([]);
    expect(scanInputs('const x = <input type="text" className="a" />;')).toEqual([]);
    expect(scanInputs('const x = <input className="a" />;')).toEqual([]);
    expect(scanInputs('const x = <input type="number" />;')).toEqual([]);
  });

  it('requires the class that matches the input type, as a whole token', () => {
    expect(oks('const x = <input type="checkbox" className="sss-checkbox mt-1" />;')).toEqual([
      true,
    ]);
    expect(oks('const x = <input type="radio" className="sss-radio" />;')).toEqual([true]);
    expect(oks('const x = <input type="range" className="flex-1 sss-range" />;')).toEqual([true]);
    expect(oks('const x = <input type="checkbox" />;')).toEqual([false]);
    expect(oks('const x = <input type="checkbox" className="sss-radio" />;')).toEqual([false]);
    expect(oks('const x = <input type="range" className="sss-range-foo" />;')).toEqual([false]);
    expect(oks('const x = <input type={"radio"} className="sss-radio" />;')).toEqual([true]);
  });

  it('treats dynamic className / type and createElement as offenders', () => {
    expect(oks('const x = <input type="checkbox" className={cn("sss-checkbox", a)} />;')).toEqual([
      false,
    ]);
    expect(
      oks('const x = <input type="checkbox" className={a ? "sss-checkbox" : "b"} />;'),
    ).toEqual([false]);
    expect(
      oks('const x = <input type="checkbox" className={a ? "sss-checkbox" : "sss-checkbox x"} />;'),
    ).toEqual([true]);
    expect(oks('const x = <input type={t} className="sss-checkbox" />;')).toEqual([false]);
    expect(scanInputs("const x = createElement('input', { type: 'checkbox' });")).toEqual([
      { kind: 'dynamic', ok: false },
    ]);
  });
});

describe('checkbox / radio / range dark styling (#122)', () => {
  it('every checkbox/radio/range input in src carries its shared class', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of walk(SRC)) {
      for (const f of scanInputs(readFileSync(file, 'utf8'))) {
        found++;
        if (!f.ok) offenders.push(`${file} (${f.kind})`);
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('css draws them explicitly with appearance: none (WebKit-safe)', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    const block = (sel: string) => {
      const m = css.match(new RegExp(`${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
      return m ? m[1] : '';
    };
    expect(css).toMatch(/\.sss-checkbox,\s*\.sss-radio\s*\{[^}]*appearance:\s*none/);
    expect(css).toMatch(/\.sss-checkbox,\s*\.sss-radio\s*\{[^}]*-webkit-appearance:\s*none/);
    expect(css).toMatch(/\.sss-checkbox,\s*\.sss-radio\s*\{[^}]*width:\s*20px/);
    expect(css).toMatch(/\.sss-checkbox,\s*\.sss-radio\s*\{[^}]*height:\s*20px/);
    // チェック済みは明るい塗り + チェックマークは clip-path (画像・絵文字不使用)
    expect(css).toMatch(/\.sss-checkbox:checked,\s*\.sss-radio:checked\s*\{[^}]*background-color/);
    expect(block('.sss-checkbox::after')).toMatch(/clip-path:\s*polygon/);
    // 状態: フォーカス・disabled
    expect(css).toMatch(/\.sss-checkbox:focus-visible[^{]*\{[^}]*outline:\s*2px solid/);
    expect(css).toMatch(/\.sss-checkbox:disabled[^{]*\{[^}]*opacity/);
    // range: つまみ/トラックを WebKit・Firefox 両方で明示
    expect(block('.sss-range')).toMatch(/appearance:\s*none/);
    expect(css).toMatch(/\.sss-range::-webkit-slider-thumb\s*\{/);
    expect(css).toMatch(/\.sss-range::-webkit-slider-runnable-track\s*\{/);
    expect(css).toMatch(/\.sss-range::-moz-range-thumb\s*\{/);
    expect(css).toMatch(/\.sss-range::-moz-range-track\s*\{/);
  });
});
