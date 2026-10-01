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

describe('select dark popup (#102)', () => {
  it('every <select> in src carries the sss-select class', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<select\b(?:=>|[^>])*>/g)) {
        found++;
        if (!/className="[^"]*\bsss-select\b/.test(m[0])) offenders.push(file);
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
