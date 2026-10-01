import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #116: ウィンドウの最小サイズ。これ未満に縮めると設定の「フォルダ」タブの「選択」ボタンが
// 切れる等、レイアウトが崩れる（実測の根拠は CLAUDE.md の「ウィンドウの最小サイズ」）。
// 値を下げる/消す変更は、e2e の "layout holds at the minimum window size" で崩れが無いことを
// 確認してから行う。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  app: { windows: Array<{ minWidth?: number; minHeight?: number }> };
};

describe('window minimum size (#116)', () => {
  it('メインウィンドウに minWidth >= 480 / minHeight >= 420 が設定されている', () => {
    const w = conf.app.windows[0];
    expect(w.minWidth).toBeGreaterThanOrEqual(480);
    expect(w.minHeight).toBeGreaterThanOrEqual(420);
  });
});
