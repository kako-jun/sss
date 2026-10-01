import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #119: window.confirm/alert/prompt は Tauri（tauri_plugin_dialog）が Promise 版に差し替えるため
// 常に truthy となり確認が素通りする。eslint の no-restricted-globals と二重で走査し、
// lint を飛ばした場合・別名参照（['confirm'] 等）も拾う。確認は confirmDialog() を使う。

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const FORBIDDEN = [
  /(?<![\w.$])(confirm|alert|prompt)\s*\(/,
  /\b(window|globalThis|self)\s*\.\s*(confirm|alert|prompt)\b/,
  /\b(window|globalThis|self)\s*\[\s*['"`](confirm|alert|prompt)['"`]\s*\]/,
];

describe('no native dialogs (#119)', () => {
  it('src never calls window.confirm/alert/prompt', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line
          .replace(/\/\*.*?\*\//g, '')
          .replace(/\/\/.*$/, '')
          .replace(/^\s*\*.*$/, '');
        if (FORBIDDEN.some((re) => re.test(code))) {
          offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
