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

// JSX/ブロック/行コメントを除去する(コメントアウトされた select を拾わない)。
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** タグ文字列の className に、境界付きで sss-select があるか。 */
export function hasSssSelect(tag: string): boolean {
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
