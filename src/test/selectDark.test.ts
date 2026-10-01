import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * #102: select のポップアップはOS既定だと明るい背景になる。全 <select> が
 * 共通クラス `sss-select` を付け、CSS側で option/optgroup が不透明なダーク背景を
 * 持つことを固定する。
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
  });
}

/**
 * 対象範囲: JSX の `<select>` タグのみ。`<Select>` ラッパーや `as="select"` は対象外
 * (現 src に無い)。`createElement(..., 'select')` は構文木で検出し、検証不能として
 * offender 扱いにする(JSX を使えという運用ガード)。
 *
 * TypeScript の構文木から <select> を列挙し、className に sss-select が
 * 完全一致のトークンとして含まれるかを判定する。コメント・文字列・正規表現内の
 * `<select` は構文木に現れないので誤検出しない(手書きスキャナは使わない)。
 */
function classTokens(node: ts.Node | undefined): string[] | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text.split(/\s+/);
  if (ts.isTemplateExpression(node)) {
    // `${}` を非空白のセンチネルに置き換えて分割し、`${}` に隣接するトークン
    // (`a${b}sss-select` のように別クラスと連結し得る断片)を除外する。
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

/** 条件式は全分岐が sss-select を持つ場合のみ true。判定不能な動的式は false(安全側=offender)。 */
function exprHasSssSelect(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return exprHasSssSelect(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return exprHasSssSelect(node.whenTrue) && exprHasSssSelect(node.whenFalse);
  }
  const tokens = classTokens(node);
  return tokens !== null && tokens.includes('sss-select');
}

/** ソース中の各 <select> について sss-select を持つかを返す(パースエラーでも落ちない)。 */
function scanSelects(src: string): boolean[] {
  const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const results: boolean[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === 'select'
    ) {
      const attr = node.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className',
      );
      results.push(exprHasSssSelect(attr?.initializer));
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
        first.text === 'select'
      ) {
        results.push(false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return results;
}

describe('scan helpers (#102)', () => {
  const count = (src: string) => scanSelects(src).length;

  it('ignores selects in comments, strings, templates and regex literals', () => {
    expect(count('{/* <select className="x"> */}')).toBe(0);
    expect(count('/* <select> */\n// <select>\n<div/>')).toBe(0);
    expect(count('const a = "<select>"; const b = \'<select>\';')).toBe(0);
    expect(count('const a = `<select>`;')).toBe(0);
    expect(count('const r = /<select>/g; const x = <div/>;')).toBe(0);
    expect(count('const a = 1 /**/ + 2; /* <select> */')).toBe(0);
  });

  it('does not let strings, apostrophes or // confuse the scan', () => {
    expect(count('const a = "a//b"; const x = <select className="x" />;')).toBe(1);
    expect(count('const a = \'//\'; const x = <select className="x" />;')).toBe(1);
    expect(count('const a = `//`; const x = <select className="x" />;')).toBe(1);
    expect(count('const a = "/*"; const x = <select className="x" />; const b = "*/";')).toBe(1);
    expect(count('const x = <div><p>don\'t</p> <select className="x" /> // x</div>;')).toBe(1);
    expect(count('const x = <div>\n// not a comment <select className="x" />\n</div>;')).toBe(1);
  });

  it('survives unterminated block comments and syntax errors', () => {
    expect(() => scanSelects('const x = <select className="a" />; /* oops')).not.toThrow();
    expect(count('const x = <select className="a" />; /* <select>')).toBe(1);
    expect(() => scanSelects('<select className="a"')).not.toThrow();
  });

  it('flags createElement("select") as an offender (JSX required)', () => {
    expect(
      scanSelects("const x = React.createElement('select', { className: 'sss-select' });"),
    ).toEqual([false]);
    expect(scanSelects("const x = createElement('select');")).toEqual([false]);
    expect(scanSelects("const x = createElement('div');")).toEqual([]);
  });

  it('matches sss-select only as a whole token', () => {
    const one = (cls: string) => scanSelects(`const x = <select className=${cls} />;`);
    expect(one('"sss-select px-2"')).toEqual([true]);
    expect(one('"px-2 sss-select"')).toEqual([true]);
    expect(one("'sss-select'")).toEqual([true]);
    expect(one('"sss-select-foo"')).toEqual([false]);
    expect(one('"foo-sss-select"')).toEqual([false]);
    expect(one('"px-2"')).toEqual([false]);
    expect(scanSelects('const x = <select />;')).toEqual([false]);
  });

  it('handles expression, template, nested ${}, conditional and multiline classNames', () => {
    const one = (cls: string) => scanSelects(`const x = <select className=${cls} />;`);
    expect(one('{"sss-select a"}')).toEqual([true]);
    expect(one('{`sss-select ${a}`}')).toEqual([true]);
    expect(one('{`a ${b ? `${c}` : "d"} sss-select`}')).toEqual([true]);
    expect(one('{`a ${b}-sss-select`}')).toEqual([false]);
    expect(one('{c ? "sss-select a" : "sss-select b"}')).toEqual([true]);
    expect(one('{c ? "sss-select a" : "b"}')).toEqual([false]);
    // 隣接断片は別クラスと連結し得るので不可
    expect(one('{`a ${b}sss-select`}')).toEqual([false]);
    expect(one('{`sss-select${x}`}')).toEqual([false]);
    expect(one('{`${x}sss-select`}')).toEqual([false]);
    expect(one('{`${x} sss-select ${y}`}')).toEqual([true]);
    // 仕様: 連結・論理式は判定不能として安全側(offender)に倒す
    expect(one('{"sss-select " + x}')).toEqual([false]);
    expect(one('{cond && "sss-select"}')).toEqual([false]);
    expect(one('{cond ? "sss-select" : undefined}')).toEqual([false]);
    // 判定不能な動的 className は安全側(offender)
    expect(one('{cn("sss-select", x)}')).toEqual([false]);
    expect(
      scanSelects(
        'const x = (\n<select\n  value={v}\n  className="a sss-select"\n  onChange={f}\n>\n</select>\n);',
      ),
    ).toEqual([true]);
    expect(
      scanSelects('const x = <select className="a">{[1].map((i) => <option key={i} />)}</select>;'),
    ).toEqual([false]);
  });
});

describe('select dark popup (#102)', () => {
  it('every <select> in src carries the sss-select class', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of walk(SRC)) {
      for (const ok of scanSelects(readFileSync(file, 'utf8'))) {
        found++;
        if (!ok) offenders.push(file);
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('css gives select color-scheme dark and opaque dark option colors', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).toMatch(/\.sss-select\s*\{[^}]*color-scheme:\s*dark/);
    const block = css.match(/\.sss-select option,\s*\.sss-select optgroup\s*\{([^}]*)\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/background-color:\s*#0a0a0a/);
    expect(block![1]).toMatch(/color:\s*rgba\(255,\s*255,\s*255,\s*0\.87\)/);
  });
});
