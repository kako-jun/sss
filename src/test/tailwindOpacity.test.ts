import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import resolveConfig from 'tailwindcss/resolveConfig';

// #99 / #66: Tailwind 既定の opacity スケールは 0,5,10,...,100 の5刻みのみ。
// 5刻みに無い値（opacity-2 / bg-white/8 等）は tailwind.config.js の
// theme.extend.opacity に登録しないと CSS が生成されず、不透明（100%）で描画される。
// このファイルは「設定の解決」「CSS 生成」「ソース中の未登録クラス」の3層で再発を防ぐ。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = join(ROOT, 'tailwind.config.js');
const SRC_DIR = join(ROOT, 'src');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadUserConfig(): Promise<any> {
  return (await import(/* @vite-ignore */ pathToFileURL(CONFIG_PATH).href)).default;
}

// content を raw 文字列にして、渡した設定で `@tailwind utilities` を処理する。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateCss(config: any, classes: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: classes }], corePlugins: { preflight: false } }),
  ]).process('@tailwind utilities;', { from: undefined });
  return result.css;
}

// `opacity: 0.02` / `opacity: .02` / 空白揺れを許容する。
function hasOpacityRule(css: string, className: string, value: number): boolean {
  const re = new RegExp(`\\.${className.replace(/[/.]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) return false;
  const decl = m[1].match(/opacity\s*:\s*([0-9.]+)/);
  return decl !== null && Number(decl[1]) === value;
}

describe('tailwind opacity 設定の解決 (#99)', () => {
  it('theme.opacity に 2 と 8 が登録され、既定スケールも保持される', async () => {
    const resolved = resolveConfig(await loadUserConfig());
    expect(resolved.theme.opacity['2']).toBe('0.02');
    expect(resolved.theme.opacity['8']).toBe('0.08');
    expect(resolved.theme.opacity['50']).toBe('0.5');
  });
});

describe('tailwind CSS 生成 (#99)', () => {
  const classes = 'opacity-2 opacity-50 bg-white/8 border-white/8';

  it('現行設定で .opacity-2 が opacity: 0.02 として生成される', async () => {
    const css = await generateCss(await loadUserConfig(), classes);
    expect(hasOpacityRule(css, 'opacity-2', 0.02)).toBe(true);
  });

  it('現行設定で bg-white/8・border-white/8 が生成される（#66）', async () => {
    const css = await generateCss(await loadUserConfig(), classes);
    expect(css).toMatch(/\.bg-white\\\/8\s*\{/);
    expect(css).toMatch(/\.border-white\\\/8\s*\{/);
  });

  it('対照: opacity 拡張が無い設定では .opacity-2 が生成されない', async () => {
    const config = await loadUserConfig();
    const { opacity: _opacity, ...extendWithoutOpacity } = config.theme.extend;
    void _opacity;
    const css = await generateCss({ ...config, theme: { extend: extendWithoutOpacity } }, classes);
    expect(css).toMatch(/\.opacity-50\s*\{/);
    expect(css).not.toMatch(/\.opacity-2\s*\{/);
    expect(css).not.toMatch(/\.bg-white\\\/8\s*\{/);
  });
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// opacity-N と 色系ユーティリティ(…/N) の整数 N を拾う。`[..]` 任意値や小数は対象外。
// 先頭の hover: / group-hover: 等のバリアントは読み飛ばす。
const OPACITY_CLASS_RE = new RegExp(
  '(?<![\\w-])(?:[\\w-]+:)*' +
    '(?:(opacity-(\\d+))|((?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|shadow|accent|caret|decoration|placeholder)-[\\w-]+\\/(\\d+)))' +
    '(?![\\w\\[./-])',
  'g',
);

// 限界: 文字列リテラルとして直接書かれたクラスのみ走査する。clsx 等で動的に組み立てたクラスと .css は対象外。
describe('ソース中の未登録 opacity クラス検出 (#66/#99 再発防止)', () => {
  it('src の opacity-N / 色/N は既定5刻みか theme.opacity 登録値のみ', async () => {
    const resolved = resolveConfig(await loadUserConfig());
    const registered = new Set<number>();
    for (let n = 0; n <= 100; n += 5) registered.add(n);
    for (const v of Object.values(resolved.theme.opacity as Record<string, string>)) {
      registered.add(Math.round(Number(v) * 100));
    }

    const problems: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(OPACITY_CLASS_RE)) {
        const n = Number(m[2] ?? m[4]);
        if (!registered.has(n)) {
          const cls = m[0];
          problems.push(
            `${relative(ROOT, file)}: "${cls}" の ${n} は未登録。tailwind.config.js の theme.extend.opacity に ${n}: '${n / 100}' を追加してください`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('検出用正規表現がバリアント付き・未登録値を拾い、任意値・登録値は拾わない', () => {
    const pick = (s: string) => [...s.matchAll(OPACITY_CLASS_RE)].map((m) => Number(m[2] ?? m[4]));
    expect(pick('"opacity-3"')).toEqual([3]);
    expect(pick('hover:bg-white/7 group-hover:opacity-12')).toEqual([7, 12]);
    expect(pick('focus-visible:border-white/9')).toEqual([9]);
    expect(pick('bg-white/[0.07] opacity-[.3] opacity-50 bg-black/10')).toEqual([50, 10]);
  });
});
