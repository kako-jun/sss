import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ブロック/行コメントを除去する(コメントアウトされた select を拾わない)。
// 文字列リテラル('...' "..." `...`)の中の `//` `/*` はコメント扱いせず保持する。
// '...' "..." は改行で閉じる(JSX テキスト中のアポストロフィで後続行を巻き込まないため)。
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** タグ文字列の className に、境界付きで sss-select があるか。 */
function hasSssSelect(tag: string): boolean {
  const m = tag.match(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/);
  const value = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  return value.split(/\s+/).includes('sss-select');
}

function selectTags(src: string): string[] {
  return [...stripComments(src).matchAll(/<select\b(?:=>|[^>])*>/g)].map((m) => m[0]);
}

describe('scan helpers (#102)', () => {
  it('ignores commented-out selects', () => {
    expect(selectTags('{/* <select className="x"> */}')).toEqual([]);
    expect(selectTags('/* <select> */\n// <select>\n<div/>')).toEqual([]);
    expect(selectTags('<select className="a" onChange={(e) => f(e)}>')).toHaveLength(1);
  });

  it('does not treat // or /* inside string literals as comments', () => {
    expect(selectTags('const a = "a//b"; <select className="x">')).toHaveLength(1);
    expect(selectTags('const a = \'//\'; <select className="x">')).toHaveLength(1);
    expect(selectTags('const a = `//`; <select className="x">')).toHaveLength(1);
    expect(selectTags('const a = "/*"; <select className="x"> ; const b = "*/";')).toHaveLength(1);
    expect(selectTags('a // c\n<select className="x">')).toHaveLength(1);
    expect(selectTags('<p>don\'t</p>\n<select className="x">')).toHaveLength(1);
    expect(selectTags('x = "a//b"; // <select>')).toEqual([]);
  });

  it('matches the class only at a token boundary', () => {
    expect(hasSssSelect('<select className="sss-select px-2">')).toBe(true);
    expect(hasSssSelect('<select className="px-2 sss-select">')).toBe(true);
    expect(hasSssSelect('<select className="sss-select-foo">')).toBe(false);
    expect(hasSssSelect('<select className="foo-sss-select">')).toBe(false);
    expect(hasSssSelect('<select className="px-2">')).toBe(false);
  });
});

describe('select dark popup (#102)', () => {
  it('every <select> in src carries the sss-select class', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of walk(SRC)) {
      for (const tag of selectTags(readFileSync(file, 'utf8'))) {
        found++;
        if (!hasSssSelect(tag)) offenders.push(file);
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
