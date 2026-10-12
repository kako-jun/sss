import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOOL_SETTING_DEFAULTS, SETTING_KEYS, parseBoolSetting } from './constants';

// 設定キーと真偽値の既定値の正本は Rust 側（commands/settings.rs）。ソースを直接読んで照合する（#148）。
const rustSource = readFileSync(
  fileURLToPath(new URL('../src-tauri/src/commands/settings.rs', import.meta.url)),
  'utf8',
);

function rustBlock(name: string): string {
  const m = rustSource.match(new RegExp(`pub const ${name}:[^=]*=\\s*&\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`${name} not found in settings.rs`);
  // コメント内の文字列をキーと誤認しないよう除去する
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('setting keys single source (#148)', () => {
  it('SETTING_KEYS equals the Rust WRITABLE_SETTING_KEYS', () => {
    const rustKeys = [...rustBlock('WRITABLE_SETTING_KEYS').matchAll(/"([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(rustKeys.length).toBeGreaterThan(0);
    expect([...SETTING_KEYS].sort()).toEqual(rustKeys.sort());
  });

  it('BOOL_SETTING_DEFAULTS equals the Rust BOOL_SETTING_DEFAULTS', () => {
    const rustDefaults = Object.fromEntries(
      [...rustBlock('BOOL_SETTING_DEFAULTS').matchAll(/\("([a-z_]+)",\s*(true|false)\)/g)].map(
        (m) => [m[1], m[2] === 'true'],
      ),
    );
    expect(Object.keys(rustDefaults).length).toBeGreaterThan(0);
    expect(BOOL_SETTING_DEFAULTS).toEqual(rustDefaults);
  });

  it('bool defaults are all writable keys', () => {
    for (const key of Object.keys(BOOL_SETTING_DEFAULTS)) {
      expect(SETTING_KEYS as readonly string[]).toContain(key);
    }
  });
});

describe('parseBoolSetting (#148)', () => {
  for (const key of Object.keys(BOOL_SETTING_DEFAULTS) as (keyof typeof BOOL_SETTING_DEFAULTS)[]) {
    it(`${key}: 'true'/'false' are literal, anything else is the default`, () => {
      expect(parseBoolSetting(key, 'true')).toBe(true);
      expect(parseBoolSetting(key, 'false')).toBe(false);
      for (const broken of [null, undefined, '', 'TRUE', '1', 'yes', ' true']) {
        expect(parseBoolSetting(key, broken)).toBe(BOOL_SETTING_DEFAULTS[key]);
      }
    });
  }

  it('apply_exif_rotation defaults to ON like the Rust side', () => {
    expect(parseBoolSetting('apply_exif_rotation', null)).toBe(true);
  });
});
