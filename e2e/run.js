#!/usr/bin/env node
// sss の実ブラウザ e2e（#65レビュー: playwright-core + システムの Edge/Chrome を
// headless 起動して検証する）。
//
// 目的: vitest + jsdom では再現できない、実ブラウザ固有のタイミング問題
// （AnimatePresence の退場アニメーション完了を待つ実マウント、<video> の
// autoplay、真のDOM再構築）を検証する。#65レビューM1（画像→動画・動画→動画で
// 永久停止）・M2（1件プレイリストで同じpathが連続すると進行が止まる）は
// どちらも実ブラウザでしか確実に再現・検証できなかった不具合。
//
// 実行方法: npm run e2e （リポジトリルートから）。
// - CI には組み込まない（ローカル専用。system Chrome/Edge が要るため）。
// - vite dev サーバーをこのスクリプトが起動し、終了時に必ず kill する
//   （既に1420番ポートで別のdevサーバーが動いていると起動に失敗するので、
//   その場合は先に閉じてから実行すること）。
// - Tauri IPC は e2e/init.js が window.__TAURI_INTERNALS__ をモックすることで
//   vite dev 単体（Tauriランタイム無し）で App.tsx をそのまま動かす。
//
// playwright-core は devDependency（ブラウザ本体はダウンロードしない）。
// システムにインストール済みの Chrome または Edge を `channel` 指定で使う。

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const PORT = 1420;
const BASE_URL = `http://localhost:${PORT}`;
const INIT_SCRIPT = path.join(__dirname, 'init.js');

/** vite dev サーバーが応答するまで待つ。 */
function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`vite dev サーバーが ${timeoutMs}ms 以内に起動しなかった: ${url}`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** システムにインストール済みの Chrome または Edge を順に試す。 */
async function launchSystemBrowser() {
  const channels = ['chrome', 'msedge'];
  let lastError;
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({
        channel,
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'],
      });
      console.log(`[e2e] ${channel} を使用`);
      return browser;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `システムに Chrome も Edge も見つからなかった（channels: ${channels.join(', ')}）。` +
      `playwright-core はブラウザ本体を同梱しないため、どちらかをインストールしてください。\n` +
      `詳細: ${lastError?.message}`,
  );
}

/** 実ブラウザのcomputed styleで可視判定する（CLAUDE.md絶対ルール1）。 */
async function isVisible(page, matchText) {
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.textContent && node.textContent.includes(text) && node.children.length === 0) {
        const style = getComputedStyle(node);
        if (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0
        ) {
          return true;
        }
      }
      node = walker.nextNode();
    }
    return false;
  }, matchText);
}

async function findPhotoImgDisplay(page) {
  return page.evaluate(() => {
    const img = [...document.querySelectorAll('img')].find((el) => el.alt !== 'SSS Logo');
    if (!img) return null;
    return { display: getComputedStyle(img).display, src: img.src.slice(0, 40) };
  });
}

const scenarios = [
  {
    // #65レビューM1(must): 画像→動画→動画→画像と回すあいだ、動画が
    // autoplay で再生され続ける（永久停止しない）ことを確認する。
    name: 'i2v_vv continues playing through image→video→video (M1)',
    hash: 'i2v_vv',
    async run(page) {
      // 動画v.webm/v2.webmはe2e用フィクスチャの容量を抑えるため同じバイト列を
      // 使い回しており、DOMのsrcだけでは論理的にどちらが表示中か見分けが
      // つかない。init.jsが公開する__e2eCurrentPath（テスト専用フック）で
      // 論理パス単位に「動画が実際に再生されていたか」を記録する。
      const seenPlayingPaths = new Set();
      const seenPaths = new Set();
      const deadline = Date.now() + 20000;
      const targetVideoPaths = ['/p/v.webm', '/p/v2.webm'];
      while (Date.now() < deadline && !targetVideoPaths.every((p) => seenPlayingPaths.has(p))) {
        await page.waitForTimeout(300);
        const sample = await page.evaluate(() => {
          const v = document.querySelector('video');
          return {
            path: window.__e2eCurrentPath,
            paused: v ? v.paused : null,
          };
        });
        seenPaths.add(sample.path);
        if (sample.paused === false && targetVideoPaths.includes(sample.path)) {
          seenPlayingPaths.add(sample.path);
        }
      }
      const pass = targetVideoPaths.every((p) => seenPlayingPaths.has(p));
      return {
        pass,
        detail: `playingPathsSeen=${[...seenPlayingPaths].join(',')} allPathsSeen=${[...seenPaths].join(',')}`,
      };
    },
  },
  {
    // #65レビューM2(must): 1件だけのプレイリストで同じpathが連続で返っても
    // タイマーが張られなくなって止まったりしない（get_next_imageが
    // 表示間隔ごとに繰り返し呼ばれ続ける）ことを確認する。
    name: 'single-item playlist keeps auto-advancing (M2)',
    hash: 'one',
    async run(page) {
      // display_interval=5000ms。2周分（10秒超）様子を見て、複数回呼ばれ続ける
      // こと自体を確認する（1回で止まっていないか）。
      await page.waitForTimeout(500);
      const before = await page.evaluate(
        () => window.__e2eLog.filter((l) => l[1] === 'get_next_image').length,
      );
      await page.waitForTimeout(11000);
      const after = await page.evaluate(
        () => window.__e2eLog.filter((l) => l[1] === 'get_next_image').length,
      );
      const pass = after - before >= 2;
      return { pass, detail: `get_next_image calls: before=${before} after=${after}` };
    },
  },
  {
    name: 'welcome screen shown when no directory has ever been configured',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(500);
      const pass = await isVisible(page, 'ようこそ SSS へ');
      return { pass, detail: pass ? 'visible' : 'not visible' };
    },
  },
  {
    name: 'dedicated empty-playlist notice shown (not welcome) when directory has 0 items',
    hash: 'empty',
    async run(page) {
      await page.waitForTimeout(500);
      const emptyVisible = await isVisible(page, '表示できる写真がありません');
      const welcomeVisible = await isVisible(page, 'ようこそ SSS へ');
      const pass = emptyVisible && !welcomeVisible;
      return { pass, detail: `emptyVisible=${emptyVisible} welcomeVisible=${welcomeVisible}` };
    },
  },
  {
    // #65レビュー修正: 前景scanDirectory自体が失敗した場合の専用画面。
    name: '"前回のフォルダを読めません" full-screen notice shown on foreground scan failure',
    hash: 'unreach',
    async run(page) {
      await page.waitForTimeout(1000);
      const pass = await isVisible(page, '前回のフォルダを読めません');
      return { pass, detail: pass ? 'visible' : 'not visible' };
    },
  },
  {
    // #65レビューS3/S4 + レビュー修正: 復元成功後の背景スキャン失敗はトースト。
    // 写真を隠さない（imgのcomputed displayがnoneにならない）ことも確認する。
    name: 'background scan failure shows a bottom toast without hiding the photo',
    hash: 'toast',
    async run(page) {
      await page.waitForTimeout(1200);
      const toastVisible = await isVisible(page, '前回のフォルダに接続できませんでした');
      const photo = await findPhotoImgDisplay(page);
      const photoVisible = !!photo && photo.display !== 'none';
      const pass = toastVisible && photoVisible;
      return {
        pass,
        detail: `toastVisible=${toastVisible} photo=${JSON.stringify(photo)}`,
      };
    },
  },
];

async function main() {
  console.log(`[e2e] vite dev サーバーを起動中 (port ${PORT})...`);
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let viteOutput = '';
  vite.stdout.on('data', (d) => (viteOutput += d));
  vite.stderr.on('data', (d) => (viteOutput += d));

  const killVite = () => {
    if (vite.killed) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-vite.pid, 'SIGTERM');
      } else {
        vite.kill();
      }
    } catch {
      // 既に終了している等は無視してよい
    }
  };

  try {
    try {
      await waitForServer(BASE_URL, 15000);
    } catch (err) {
      console.error(viteOutput);
      throw err;
    }

    const browser = await launchSystemBrowser();
    const results = [];
    try {
      for (const scenario of scenarios) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.addInitScript({ path: INIT_SCRIPT });
        const consoleErrors = [];
        page.on('console', (m) => {
          if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
        });
        await page.goto(`${BASE_URL}/#${scenario.hash}`);
        let outcome;
        try {
          outcome = await scenario.run(page);
        } catch (err) {
          outcome = { pass: false, detail: `例外: ${err.message}` };
        }
        results.push({ name: scenario.name, ...outcome, consoleErrors: consoleErrors.slice(0, 3) });
        await page.close();
      }
    } finally {
      await browser.close();
    }

    console.log('\n[e2e] 結果:');
    let allPass = true;
    for (const r of results) {
      const mark = r.pass ? 'PASS' : 'FAIL';
      if (!r.pass) allPass = false;
      console.log(`  [${mark}] ${r.name}\n        ${r.detail}`);
      if (r.consoleErrors.length > 0) {
        console.log(`        console errors: ${r.consoleErrors.join(' | ')}`);
      }
    }
    console.log('');
    if (!allPass) {
      console.error('[e2e] 失敗したシナリオがあります');
      process.exitCode = 1;
    } else {
      console.log('[e2e] 全シナリオ成功');
    }
  } finally {
    killVite();
  }
}

main().catch((err) => {
  console.error('[e2e] 致命的エラー:', err);
  process.exitCode = 1;
});
