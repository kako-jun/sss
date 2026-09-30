#!/usr/bin/env node
// sss のUI刷新（#66）向けスクリーンショット撮影スクリプト。
//
// e2e/run.js と同じ仕組み（playwright-core + システムのChrome/Edge、
// e2e/init.jsによるTauri IPCモック）でvite devを実ブラウザから操作し、
// 主要画面（スライド表示＋オーバーレイ、右上ボタン、各設定タブ、ようこそ、
// 各種案内/トースト、ショートカット一覧）をja/en・幅1280/720で撮影する。
//
// 実行方法: node e2e/screenshots.js <出力先ディレクトリ>
//   例: node e2e/screenshots.js /path/to/ui66/before
//       node e2e/screenshots.js /path/to/ui66/after
//
// 刷新前後を同条件で比較するため、CLAUDE.md「実機での仕様達成」原則に従い
// vite dev + 実ブラウザで撮影する（静的な見た目の推測をしない）。刷新前の
// スクリーンショットを撮る時は、このスクリプト自体は新規追加ファイルなので
// `git stash`で刷新コミット前のソースに戻してから実行し、戻したら
// `git stash pop`で復元する（CLAUDE.mdのライブ比較原則）。
//
// 新しい画面/要素（例: ショートカット一覧、idle時のカーソル非表示）は
// 刷新前のコードには存在しないため、見つからない場合は警告を出してスキップし、
// 他のショットの撮影は継続する。

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const PORT = 1421; // npm run e2e (1420) と衝突しないよう別ポートを使う
const BASE_URL = `http://localhost:${PORT}`;
const INIT_SCRIPT = path.join(__dirname, 'init.js');

const outDir = process.argv[2];
if (!outDir) {
  console.error('使い方: node e2e/screenshots.js <出力先ディレクトリ>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '127.0.0.1');
  });
}

function waitForServer(url, timeoutMs, viteProcess) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(`vite dev サーバーが起動前に終了した (code=${code}, signal=${signal})`));
    };
    viteProcess.once('exit', onExit);
    viteProcess.once('error', onExit);

    const attempt = () => {
      if (settled) return;
      const req = http.get(url, (res) => {
        res.resume();
        if (settled) return;
        settled = true;
        viteProcess.off('exit', onExit);
        viteProcess.off('error', onExit);
        resolve();
      });
      req.on('error', () => {
        if (settled) return;
        if (Date.now() > deadline) {
          settled = true;
          viteProcess.off('exit', onExit);
          viteProcess.off('error', onExit);
          reject(new Error(`vite dev サーバーが ${timeoutMs}ms 以内に起動しなかった: ${url}`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

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
      console.log(`[screenshots] ${channel} を使用`);
      return browser;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`システムに Chrome も Edge も見つからなかった: ${lastError?.message}`);
}

/**
 * #66レビュー2巡目nit: JSの`.click()`（DOMメソッド直呼び）は実ブラウザだと
 * mousedown/mouseupを経由しないため、OverlayUI/右上ピルに付けた
 * `onMouseDown={e => e.preventDefault()}`（#66レビュー2巡目must1）が効かず、
 * ボタンにフォーカスリングが残ったまま撮影されてしまうことがあった
 * （実際のユーザー操作と乖離した見た目になる）。撮影用のクリックは必ず
 * Playwrightの本物のマウスクリック（mousedown/mouseup/clickイベント一式）で
 * 行う。
 */
async function realClick(page, selector) {
  await page.locator(selector).click();
}

/**
 * idle中（既定でマウス未操作）はオーバーレイ・右上ピルに`pointer-events:none`
 * が付いており、本物のマウスクリックはヒットテストに失敗してタイムアウト
 * する（JSの`.click()`はこれを素通りしていたため今まで問題にならなかった）。
 * 本物のクリックへ切り替えたことで、先に実際のマウス移動でidleを解除する
 * 必要がある（e2e/run.jsのwakeFromIdleと同じ理由）。
 */
async function wakeFromIdle(page) {
  await page.mouse.move(640, 400);
  await page.mouse.move(641, 401);
  await page.waitForTimeout(400); // IDLE_FADE_BASEのtransition-opacity(300ms)+余裕
}

/** 設定を開く（gearアイコンのlucideクラス名で選ぶ。ロケールに左右されない）。 */
async function openSettings(page) {
  await wakeFromIdle(page);
  await realClick(page, 'button:has(svg.lucide-settings)');
  await page.waitForTimeout(350); // モーダルのopenアニメーション(200ms)待ち
}

/** タブ行の中のN番目のタブボタンをクリックする（役割は無い場合もあるので位置で選ぶ）。 */
async function clickTabByIndex(page, index) {
  await realClick(page, `.overflow-x-auto > button:nth-child(${index + 1})`);
  await page.waitForTimeout(200);
}

const TAB_LABELS = ['scan', 'options', 'exclude', 'pick', 'history', 'stats', 'info'];

async function shoot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[screenshots] ${name}.png`);
}

async function tryStep(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.warn(`[screenshots] skip "${label}": ${err.message}`);
  }
}

/**
 * シナリオ（hash）ごとに新しいページを開く。#65/#66のe2e/run.jsと同じ理由:
 * `page.goto()`でhashだけを変えても同一ドキュメント内のフラグメント遷移と
 * 判定されると`addInitScript`が再注入されず、`init.js`の`location.hash`読取
 * （モジュール初期化時に1回だけ）が古いシナリオのまま固定されてしまう
 * （最初に開いたシナリオの画面が全ショットで使い回されるバグを実際に踏んだ）。
 * シナリオごとに独立したページを開くことで、これを確実に避ける。
 */
async function openScenario(browser, { width, height, locale, hash }) {
  const page = await browser.newPage({ viewport: { width, height }, locale });
  await page.addInitScript({ path: INIT_SCRIPT });
  await page.goto(`${BASE_URL}/#${hash}`);
  return page;
}

async function captureForViewport(browser, { width, height, locale, localeTag }) {
  const suffix = `${localeTag}_${width}x${height}`;
  const opts = { width, height, locale };

  // --- ようこそ画面 ---
  await tryStep(`welcome_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'welcome' });
    await page.waitForTimeout(500);
    await shoot(page, `welcome_${suffix}`);
    await page.close();
  });

  // --- スライド表示＋オーバーレイ（マウス操作でアクティブ状態にする）→ idle状態
  //     （#66: オーバーレイ・右上ボタン・カーソルが消える）。同じページで連続撮影する
  //     （idleはactiveから継続してマウスを動かさないことで再現するため）。
  await tryStep(`overlay_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'slides' });
    await page.waitForTimeout(900); // 最初の画像の表示を待つ
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 2 + 10, height / 2 + 10); // idle解除のため実際に動かす
    await page.waitForTimeout(300);
    await shoot(page, `overlay_active_${suffix}`);

    await tryStep(`overlay_idle_${suffix}`, async () => {
      // マウスを動かさず3秒超待つ。
      await page.waitForTimeout(3300);
      await shoot(page, `overlay_idle_${suffix}`);
    });
    await page.close();
  });

  // --- 空プレイリストの案内 ---
  await tryStep(`empty_notice_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'empty' });
    await page.waitForTimeout(500);
    await shoot(page, `empty_notice_${suffix}`);
    await page.close();
  });

  // --- 前回フォルダを読めない全画面案内 ---
  await tryStep(`unreachable_notice_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'unreach' });
    await page.waitForTimeout(1000);
    await shoot(page, `unreachable_notice_${suffix}`);
    await page.close();
  });

  // --- 背景スキャン失敗の控えめなトースト（写真は維持） ---
  await tryStep(`toast_notice_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'toast' });
    await page.waitForTimeout(1200);
    await shoot(page, `toast_notice_${suffix}`);
    await page.close();
  });

  // --- 設定モーダル: 各タブ ---
  await tryStep(`settings_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'slides' });
    await page.waitForTimeout(900);
    await openSettings(page);
    for (let i = 0; i < TAB_LABELS.length; i++) {
      await tryStep(`settings_${TAB_LABELS[i]}_${suffix}`, async () => {
        await clickTabByIndex(page, i);
        await shoot(page, `settings_${TAB_LABELS[i]}_${suffix}`);
      });
    }
    await page.close();
  });

  // --- 統計タブ（#67）: 均等な分布と偏りのある分布。集計済みヒストグラムを
  //     init.js の 'stats' / 'statsspread' シナリオが返す。ホバー時の
  //     ツールチップ状態も撮る。 ---
  for (const hash of ['stats', 'statsspread']) {
    await tryStep(`${hash}_${suffix}`, async () => {
      const page = await openScenario(browser, { ...opts, hash });
      await page.waitForTimeout(900);
      await openSettings(page);
      await clickTabByIndex(page, TAB_LABELS.indexOf('stats'));
      await page.waitForSelector('.u-over', { timeout: 3000 });
      await page.waitForTimeout(300);
      await shoot(page, `${hash}_${suffix}`);
      const over = await page.locator('.u-over').boundingBox();
      await page.mouse.move(over.x + over.width * 0.58, over.y + over.height * 0.7);
      await page.waitForTimeout(200);
      await shoot(page, `${hash}_hover_${suffix}`);
      await page.close();
    });
  }

  // --- ショートカット一覧（#66で新規追加。刷新前のコードには存在しない） ---
  await tryStep(`shortcuts_${suffix}`, async () => {
    const page = await openScenario(browser, { ...opts, hash: 'slides' });
    await page.waitForTimeout(900);
    await page.keyboard.press('?');
    await page.waitForTimeout(300);
    await shoot(page, `shortcuts_${suffix}`);
    await page.close();
  });
}

async function main() {
  if (await isPortInUse(PORT)) {
    throw new Error(`ポート ${PORT} は使用中。先に閉じてから実行してください。`);
  }

  console.log(`[screenshots] vite dev サーバーを起動中 (port ${PORT})...`);
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
      await waitForServer(BASE_URL, 15000, vite);
    } catch (err) {
      console.error(viteOutput);
      throw err;
    }

    const browser = await launchSystemBrowser();
    try {
      const viewports = [
        { width: 1280, height: 800 },
        { width: 720, height: 800 },
      ];
      const locales = [
        { locale: 'ja-JP', localeTag: 'ja' },
        { locale: 'en-US', localeTag: 'en' },
      ];
      for (const viewport of viewports) {
        for (const loc of locales) {
          await captureForViewport(browser, { ...viewport, ...loc });
        }
      }
    } finally {
      await browser.close();
    }
    console.log(`[screenshots] 完了: ${outDir}`);
  } finally {
    killVite();
  }
}

main().catch((err) => {
  console.error('[screenshots] 致命的エラー:', err);
  process.exitCode = 1;
});
