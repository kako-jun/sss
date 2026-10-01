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
//   （既定は1420番ポート、環境変数 E2E_PORT で変更可。そのポートで別のdevサーバーが
//   動いていると起動に失敗するので、
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
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT) || 1420;
const BASE_URL = `http://localhost:${PORT}`;
const INIT_SCRIPT = path.join(__dirname, 'init.js');

/**
 * ポートが既に使用中かどうかを、実際にbindを試みて確認する（#65レビュー2巡目）。
 * README で謳っている「先に別のdevサーバーが動いていると起動に失敗する」を、
 * vite起動→タイムアウト待ちという遠回りではなく、起動前に即座に検出する。
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '127.0.0.1');
  });
}

/**
 * vite dev サーバーが応答するまで待つ。子プロセスがその前に終了した場合は
 * タイムアウトを待たず即座にreject する（#65レビュー2巡目: 以前はポート使用中で
 * viteが即終了してもタイムアウトの15秒をまるごと無駄に待っていた）。
 */
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

/** システムにインストール済みの Chrome または Edge を順に試す。 */
async function launchSystemBrowser() {
  // E2E_BROWSER_PATH: channel の Chrome/Edge が無い環境（Playwright 同梱 Chromium 等）用に実行ファイルを直接指定する。
  if (process.env.E2E_BROWSER_PATH) {
    return chromium.launch({
      executablePath: process.env.E2E_BROWSER_PATH,
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    });
  }
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

/**
 * ボタンをJS経由で直接クリックする（実マウント移動を伴わない）。
 * `page.click()`はホバーも実施するため、OverlayUI内のボタンをクリックすると
 * `isOverlayHovered`も同時にtrueになり、`isPausedByUser`単体の効果を検証しにくい。
 * `.click()`はCSSのpointer-events/実ホバー状態と無関係にclickイベントを発火できる。
 */
async function clickButtonByTitle(page, title) {
  await page.evaluate((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    if (!btn) throw new Error(`button[title="${t}"] が見つからない`);
    btn.click();
  }, title);
}

async function countCalls(page, cmd) {
  return page.evaluate((c) => window.__e2eLog.filter((l) => l[1] === c).length, cmd);
}

/**
 * #124: レイアウトが確定する（アニメーション・リサイズ反映が終わる）まで待つ。固定 sleep や
 * 「ポーリング回数」でなく**時間と実フレーム**で判定する: 描画に関わる値（最初のタブ・モーダルの
 * 矩形、ビューポート）が、requestAnimationFrame の3フレーム以上かつ 100ms 以上連続して
 * 変わらなければ確定とみなす。レンダラがフレームを出せない間は rAF が呼ばれず、
 * フレーム数が進まないので、負荷で凍っている間の「同じ値」を確定と誤認しない。
 */
async function waitLayoutStable(page, { timeout = 15000 } = {}) {
  try {
    await page.waitForFunction(
      () => {
        const r = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return [b.top, b.left, b.width, b.height].map((v) => Math.round(v * 100) / 100).join(',');
        };
        const key = [
          r(document.querySelector('[role="tab"]')),
          r(document.querySelector('[role="dialog"]')),
          window.innerWidth,
          window.innerHeight,
        ].join('|');
        const now = performance.now();
        const st = window.__layoutSettle;
        if (!st || st.key !== key) {
          window.__layoutSettle = { key, since: now, frames: 0 };
          return false;
        }
        st.frames++;
        return st.frames >= 3 && now - st.since >= 100;
      },
      null,
      { polling: 'raf', timeout },
    );
  } finally {
    await page.evaluate(() => {
      delete window.__layoutSettle;
    });
  }
}

/** リサイズ後のレイアウト確定を待つ（固定 sleep の代わり。waitLayoutStable 参照）。 */
async function settleLayout(page) {
  await waitLayoutStable(page);
}

/** 設定ボタン（lucideのgearアイコン、ロケール非依存）をクリックして開く。#66用。 */
async function openSettingsModal(page) {
  await page.evaluate(() => {
    const icon = document.querySelector('svg.lucide-settings');
    const btn = icon && icon.closest('button');
    if (!btn) throw new Error('設定ボタンが見つからない');
    btn.click();
  });
  // #124: 固定 350ms 待ちだと、負荷で開閉アニメーション中の値を測って揺れる。
  // タブが現れ、モーダルの矩形が時間・フレーム基準で安定する（アニメーション完了）まで待つ。
  await page.waitForSelector('[role="tab"]', { timeout: 8000 });
  await waitLayoutStable(page);
}

/**
 * #66レビューmust2: idle中は操作バー・右上ピルにpointer-events-noneが付き
 * （constants.tsのIDLE_FADE_HIDDEN）、本物のマウスクリック（下記
 * realMouseClickByTitle）はヒットテストに失敗してタイムアウトする。JSの
 * `.click()`（openSettingsModal等）はDOMメソッド直呼びのためpointer-events を
 * 無視して素通りするが、must2の各シナリオは「本物のマウス操作で得た残留
 * フォーカスが:focus-visibleにならない」ことそのものを検証したいので、事前に
 * 実際のマウス移動でidleを解除しクリック可能な状態にしてから使う。
 */
async function wakeFromIdle(page) {
  await page.mouse.move(640, 400);
  await page.mouse.move(641, 401);
  await page.waitForTimeout(400); // IDLE_FADE_BASEのtransition-opacity(300ms)+余裕
}

/**
 * #113: 操作バー（ファイル名・撮影日・位置表示・各アイコン）と右上ピルのアイコンの
 * 「実効コントラスト比」を実描画から測る。
 *
 * 1. 計測対象（要素の矩形・computed color・祖先の opacity 積）を集める。
 * 2. 前景（文字・アイコン）を透明にしたスクリーンショットを撮る。ここに写る画素が、
 *    背景写真 + backdrop-blur + バー背景が合成された「要素の背後の実際の色」になる。
 * 3. 矩形内の各背景画素ごとに、前景色（computed color × 祖先 opacity）を
 *    その画素へアルファブレンドした色との WCAG コントラスト比を求め、下位2%点を
 *    その要素の代表値にする（高周波パターンでも最悪側を見る）。
 * 4. 参考として、通常のスクリーンショットで矩形内の最も明るい画素（=文字/アイコンの
 *    芯）と、背景の上位2%点との比（peakRatio）も出す。computed 由来の値と大きく
 *    食い違わないことの検算用。
 *
 * 文字 = ファイル名・撮影日・位置表示。アイコン = バーの有効なボタンと右上ピルのアイコン。
 * 無効ボタン（先頭写真での「前へ」）と装飾の区切り点（·）は WCAG の対象外なので測らない。
 *
 * 矩形は CSS px で取り、スクリーンショットの画素座標へは devicePixelRatio を掛けて変換する
 * （DPR 1 で検証済み。DPR 2 以上は座標変換のみ入れてあり未検証）。
 *
 * peakRatio がアイコンで computed 由来の ratio より大きく乖離するのは意図どおり: ratio は
 * アイコンの芯（stroke の色 = /60 の線）の実効色を測るが、peak は矩形内の最大輝度画素
 * （hover 時の強調や、MapPin のように別色で塗られた部分・アンチエイリアスを含む）を拾うため。
 * 文字・均一なアイコンでは両者が一致することを検算に使う。
 */
/**
 * 背景写真のフェードイン(約0.5秒)と操作バーのフェードイン(0.3秒)が終わるまで、実際の computed
 * opacity で待つ(固定の待ち時間だと、負荷時に写真が白に届く前に撮ってコントラストが 1.4 になる)。
 */
async function waitForOverlayOpaque(page) {
  await page.waitForFunction(
    () => {
      const eff = (el) => {
        let o = 1;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          o *= Number(getComputedStyle(n).opacity);
        }
        return o;
      };
      const bar = document.querySelector('.fixed.bottom-6');
      const photos = [...document.querySelectorAll('img')].filter(
        (i) => i.alt !== 'SSS Logo' && !i.closest('.fixed.bottom-6') && i.naturalWidth > 0,
      );
      return !!bar && eff(bar) === 1 && photos.length > 0 && photos.every((i) => eff(i) === 1);
    },
    null,
    { timeout: 15000, polling: 50 },
  );
}

async function measureOverlayContrast(page) {
  await wakeFromIdle(page);
  await waitForOverlayOpaque(page);
  const targets = await page.evaluate(() => {
    const out = [];
    const effOpacity = (el) => {
      let o = 1;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      return o;
    };
    const add = (label, kind, el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      out.push({
        label,
        kind,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        color: getComputedStyle(el).color,
        opacity: effOpacity(el),
      });
    };
    const bar = document.querySelector('.fixed.bottom-6 > div');
    const info = bar && bar.querySelector('div[title]');
    if (info) {
      // #114: 要素は data-overlay で引く（ファイル名は前半/後半の2要素に分かれるため外側を測る）。
      for (const part of ['filename', 'date', 'position']) {
        const el = info.querySelector(`[data-overlay="${part}"]`);
        if (el) add(part, 'text', el);
      }
    }
    if (bar) {
      [...bar.querySelectorAll(':scope button')].forEach((b, i) => {
        const svg = b.querySelector('svg');
        if (svg && !b.disabled && b.closest('[role=menu]') === null) {
          add(`bar-icon-${i}`, 'icon', b);
        }
      });
    }
    [...document.querySelectorAll('.fixed.top-4.right-4 button')].forEach((b, i) => {
      if (b.querySelector('svg')) add(`pill-icon-${i}`, 'icon', b);
    });
    return out;
  });
  if (targets.length === 0) throw new Error('計測対象のオーバーレイ要素が見つからない');

  // スクリーンショットは device pixel 単位なので、CSS px の矩形に DPR を掛けて画素座標にする。
  const dsf = await page.evaluate(() => window.devicePixelRatio);
  const withFg = await page.screenshot({ type: 'png' });
  await page.addStyleTag({
    content:
      '*{color:transparent!important;text-shadow:none!important}' +
      'svg,svg *{stroke:transparent!important;fill:transparent!important;filter:none!important}',
  });
  await page.waitForTimeout(400);
  await waitForOverlayOpaque(page);
  const bgOnly = await page.screenshot({ type: 'png' });

  const results = await page.evaluate(
    async ({ withFgB64, bgOnlyB64, targets, dsf }) => {
      const load = (b64) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0);
            resolve(g);
          };
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
      const gA = await load(withFgB64);
      const gB = await load(bgOnlyB64);
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const pct = (arr, p) => {
        const a = [...arr].sort((x, y) => x - y);
        return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
      };
      return targets.map((t) => {
        const m = t.color.match(/[\d.]+/g).map(Number);
        const fgA = (m[3] === undefined ? 1 : m[3]) * t.opacity;
        const x = Math.max(0, Math.floor(t.rect.x * dsf));
        const y = Math.max(0, Math.floor(t.rect.y * dsf));
        const w = Math.max(1, Math.ceil(t.rect.w * dsf));
        const h = Math.max(1, Math.ceil(t.rect.h * dsf));
        const a = gA.getImageData(x, y, w, h).data;
        const b = gB.getImageData(x, y, w, h).data;
        const ratios = [];
        const bgLums = [];
        let peak = 0;
        for (let i = 0; i < b.length; i += 4) {
          const br = b[i];
          const bg = b[i + 1];
          const bb = b[i + 2];
          const er = m[0] * fgA + br * (1 - fgA);
          const eg = m[1] * fgA + bg * (1 - fgA);
          const eb = m[2] * fgA + bb * (1 - fgA);
          const bl = lum(br, bg, bb);
          bgLums.push(bl);
          ratios.push(ratio(lum(er, eg, eb), bl));
          peak = Math.max(peak, lum(a[i], a[i + 1], a[i + 2]));
        }
        return {
          label: t.label,
          kind: t.kind,
          ratio: pct(ratios, 0.02),
          peakRatio: ratio(peak, pct(bgLums, 0.98)),
        };
      });
    },
    {
      withFgB64: withFg.toString('base64'),
      bgOnlyB64: bgOnly.toString('base64'),
      targets,
      dsf,
    },
  );
  return { results, withFg };
}

/**
 * #113(S1): 画面下端の進捗ヘアライン（2px）のコントラストを実描画から測る。
 * フィル（進んだ分）とトラック（残り）、トラックと写真、フィルと写真の各中央値の色から
 * WCAG 比を出す。写真側はヘアラインの少し上（バーと重ならない行）を使う。
 * 進捗は表示間隔(5秒)で 0→100% に動くので、起動 1.5 秒後（約30%）のフィル範囲を使う。
 */
async function measureHairlineContrast(page) {
  await wakeFromIdle(page);
  // 固定の待ち時間ではなく条件で待つ(負荷時にフィルが 0 のまま/トランジション中の値を読んで
  // fill/track が 1.01 になる不安定さがあった): フィルが 60px 以上かつ終端の手前に来るまで待ち、
  // その時点で全アニメーション(進捗の CSS transition)を止めて、止めた状態の矩形と画素を測る。
  // idle(3秒)になるとヘアラインもフェードアウトする(再生中)ので、待っている間もマウスを動かして
  // idle にしない。条件: フィルが 60px 以上かつ終端の手前、かつ track(祖先含む)が完全に不透明。
  const ready = () =>
    page.evaluate(() => {
      const track = document.querySelector('.fixed.bottom-0.left-0.right-0');
      const fill = track && track.firstElementChild;
      if (!track || !fill) return false;
      let o = 1;
      for (let n = track; n && n.nodeType === 1; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      const w = fill.getBoundingClientRect().width;
      return o === 1 && w > 60 && w < track.getBoundingClientRect().width - 300;
    });
  const deadline = Date.now() + 20000;
  for (let k = 0; !(await ready()); k++) {
    if (Date.now() > deadline) throw new Error('ヘアラインが測れる状態にならなかった');
    await page.mouse.move(640 + (k % 2), 400);
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  await page.waitForTimeout(100);
  const dsf = await page.evaluate(() => window.devicePixelRatio);
  const rects = await page.evaluate(() => {
    const track = document.querySelector('.fixed.bottom-0.left-0.right-0');
    const fill = track && track.firstElementChild;
    if (!track || !fill) return null;
    const t = track.getBoundingClientRect();
    const f = fill.getBoundingClientRect();
    return {
      track: { x: t.left, y: t.top, w: t.width, h: t.height },
      fill: { x: f.left, y: f.top, w: f.width, h: f.height },
    };
  });
  if (!rects) throw new Error('進捗ヘアラインが見つからない');
  const shot = await page.screenshot({ type: 'png' });
  return page.evaluate(
    async ({ b64, rects, dsf }) => {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const lum = ([r, gg, b]) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
      const ratio = (a, b) => {
        const l1 = lum(a);
        const l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const median = (x, y, w, h) => {
        const d = g.getImageData(
          Math.floor(x * dsf),
          Math.floor(y * dsf),
          Math.max(1, Math.floor(w * dsf)),
          Math.max(1, Math.floor(h * dsf)),
        ).data;
        const ch = [[], [], []];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) ch[k].push(d[i + k]);
        return ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
      };
      const { track, fill } = rects;
      const midY = track.y;
      const fillPx = median(fill.x + 4, midY, Math.max(1, fill.w - 40), track.h);
      const trackPx = median(track.x + track.w - 120, midY, 100, track.h);
      const photoPx = median(fill.x + 4, midY - 12, 200, 4);
      return {
        fillTrack: ratio(fillPx, trackPx),
        trackPhoto: ratio(trackPx, photoPx),
        fillPhoto: ratio(fillPx, photoPx),
        fillW: fill.w,
        trackW: track.w,
        fillPx,
        trackPx,
        photoPx,
      };
    },
    { b64: shot.toString('base64'), rects, dsf },
  );
}

/** ヘアラインの合否: フィルがトラックから 3:1 で識別でき、ヘアライン全体が写真からも 3:1 で識別できる。 */
function summarizeHairline(m) {
  const visible = m.trackPhoto >= 3 || m.fillPhoto >= 3;
  return {
    pass: m.fillTrack >= 3 && visible && m.fillW > 50 && m.fillW < m.trackW - 200,
    detail: `hairline fill/track=${m.fillTrack.toFixed(2)} track/photo=${m.trackPhoto.toFixed(2)} fill/photo=${m.fillPhoto.toFixed(2)} fill=${m.fillPx} track=${m.trackPx} photo=${m.photoPx}`,
  };
}

/** #113: 計測結果から、文字 4.5:1 / アイコン 3:1 を満たすかと要約文字列を返す。 */
function summarizeContrast(results) {
  const fails = results.filter((r) => r.ratio < (r.kind === 'text' ? 4.5 : 3));
  const fmt = results.map(
    (r) => `${r.label}=${r.ratio.toFixed(2)}(peak ${r.peakRatio.toFixed(2)})`,
  );
  return { pass: fails.length === 0 && results.length > 0, detail: fmt.join(' ') };
}

/**
 * 本物のマウス操作でボタンをクリックする（Playwrightの`click()`は実ブラウザの
 * pointerdown/mousedown/mouseup/clickイベント一式を発火する）。#66レビュー
 * must2: JSの`.click()`と違い、実ブラウザの`:focus-visible`ヒューリスティックが
 * 本物のマウス操作と同じ扱いになる（＝マウスでクリックしたボタンは
 * `:focus-visible`にならない）ことを前提にする検証にはこちらを使う。
 */
async function realMouseClickByTitle(page, title) {
  await page.click(`button[title="${title}"]`);
}

/**
 * フローティング操作バー（`.bottom-6`）を包むidleフェード用ラッパー要素の
 * 実際のcomputed opacityを返す。CLAUDE.md絶対ルール1: 可視判定はプロパティ
 * ではなく実ブラウザのcomputed styleで行う。
 */
async function getOverlayBarWrapperOpacity(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.bottom-6');
    const wrapper = bar ? bar.parentElement : null;
    return wrapper ? Number(getComputedStyle(wrapper).opacity) : null;
  });
}

/**
 * #119: 「すべてのデータを初期化」は window.confirm ではなくアプリ内モーダル
 * （role=alertdialog）で確認し、OK を押した時だけ reset_all_data を呼ぶ。
 * キャンセル/ESC/背景クリックでは IPC が一切呼ばれず、ESC が設定を閉じたり
 * exit_app を呼んだりしないことをログで確認する。E2E_SHOT_DIR を指定すると
 * 800/1280/480 幅のスクリーンショットも保存する。
 */
const CONFIRM_KINDS = {
  // 設定 > 情報 > すべてのデータを初期化
  info: { tab: -1, cmd: 'reset_all_data', trigger: 'svg.lucide-rotate-ccw' },
  // 設定 > 統計グラフ > 表示回数をリセット（赤い文字ボタン）
  stats: { tab: 5, cmd: 'reset_all_display_counts', trigger: 'button[class*="text-red-400/60"]' },
  // 設定 > ピック > サムネイルの削除ボタン（先頭）
  pick: {
    tab: 3,
    cmd: 'delete_picked_image',
    trigger: 'button[title="削除"], button[title="Delete"]',
  },
};

async function confirmResetScenario(page, lang, kind = 'info') {
  const spec = CONFIRM_KINDS[kind];
  // vite 初回の依存最適化で再読込が入ることがあるので、設定ボタンが出るまで待つ。
  await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
  await page.waitForTimeout(600);
  await openSettingsModal(page);
  await page.evaluate((tabIndex) => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    tabs[tabIndex < 0 ? tabs.length + tabIndex : tabIndex].click();
  }, spec.tab);
  await page.waitForSelector(spec.trigger, { timeout: 8000 });
  await page.waitForTimeout(300);
  const openDialog = async () => {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const btn = el && el.closest('button');
      if (!btn) throw new Error('トリガーのボタンが見つからない');
      btn.click();
    }, spec.trigger);
    await page.waitForSelector('[role="alertdialog"]', { timeout: 2000 });
    // useFocusTrap のフォーカス移動は rAF 遅延なので、ダイアログ内へ移るまで待つ（負荷時の揺れ対策）。
    await page.waitForFunction(
      () => document.querySelector('[role="alertdialog"]')?.contains(document.activeElement),
      null,
      { timeout: 3000 },
    );
  };
  const dialogState = () =>
    page.evaluate(() => {
      const d = document.querySelector('[role="alertdialog"]');
      return d
        ? {
            modal: d.getAttribute('aria-modal'),
            display: getComputedStyle(d).display,
            focus: document.activeElement ? document.activeElement.textContent : null,
            text: d.textContent,
          }
        : null;
    });
  const resets = () => countCalls(page, spec.cmd);
  const detail = [];

  await openDialog();
  const st = await dialogState();
  detail.push('dialog=' + JSON.stringify(st));
  const defaultFocusIsCancel = st && st.focus === (lang === 'ja' ? 'キャンセル' : 'Cancel');

  const shotDir = process.env.E2E_SHOT_DIR;
  const fits = [];
  let fitOk = true;
  {
    for (const [w, h] of [
      [800, 600],
      [1280, 800],
      [480, 700],
      [800, 400],
      [360, 300],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      if (shotDir) {
        await page.screenshot({
          path: path.join(shotDir, `confirm-${kind}-${lang}-${w}x${h}.png`),
        });
      }
      // 最終段落（警告）とボタンが viewport 内に完全に収まっている（スクロール不要で見える）こと。
      const fit = await page.evaluate(() => {
        const inView = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return (
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= innerHeight &&
            r.right <= innerWidth &&
            r.height > 0
          );
        };
        const d = document.querySelector('[role="alertdialog"]');
        const btns = [...d.querySelectorAll('button')];
        const final = d.querySelector('[data-testid="confirm-dialog-final"]');
        // ヒント行（「矢印キーで続きを表示」）が本文スクロール領域・最終段落・ボタンと矩形交差しないこと。
        const hint = d.querySelector('[data-testid="confirm-dialog-hint"]');
        const scroller = d.querySelector('.overflow-y-auto');
        const hit = (a, b) => {
          const p = a.getBoundingClientRect();
          const q = b.getBoundingClientRect();
          return p.left < q.right && p.right > q.left && p.top < q.bottom && p.bottom > q.top;
        };
        const hintOverlaps = hint
          ? [scroller, final, ...btns].filter(Boolean).some((el) => hit(hint, el))
          : false;
        return {
          hintOverlaps,
          hintShown: hint ? hint.textContent.trim() !== '' : false,
          final: final ? inView(final) : 'none',
          buttons: btns.every(inView),
          panel: inView(d),
          // 視覚順: キャンセル(DOM先頭)が左、破壊ボタン(DOM末尾)が右（CSS order での入替を検出）。
          cancelLeftOfOk:
            btns[0].getBoundingClientRect().left <
            btns[btns.length - 1].getBoundingClientRect().left,
        };
      });
      fits.push(`${w}x${h}:${JSON.stringify(fit)}`);
      if (
        !fit.buttons ||
        fit.final === false ||
        !fit.panel ||
        !fit.cancelLeftOfOk ||
        fit.hintOverlaps
      )
        fitOk = false;
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
  }

  // 1) キャンセルボタン
  await page.click('[role="alertdialog"] button:first-of-type');
  await page.waitForTimeout(250);
  const afterCancel = { resets: await resets(), open: !!(await dialogState()) };
  // 2) ESC（設定は閉じず exit_app も呼ばれない）
  await openDialog();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const afterEsc = {
    resets: await resets(),
    open: !!(await dialogState()),
    settingsStillOpen: (await page.$('[role="dialog"]')) !== null,
    exits: await countCalls(page, 'exit_app'),
  };
  // 3) 背景クリック（パネルの外）
  await openDialog();
  await page.mouse.click(4, 4);
  await page.waitForTimeout(250);
  const afterBackdrop = { resets: await resets(), open: !!(await dialogState()) };
  // 3b) 既定フォーカス（キャンセル）で Enter / Space → 閉じるだけで破壊的 IPC は 0 回
  await openDialog();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const afterEnter = { resets: await resets(), open: !!(await dialogState()) };
  await openDialog();
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  const afterSpace = { resets: await resets(), open: !!(await dialogState()) };
  // 3c) スクロール系キー・Tab/Shift+Tab 周回では閉じず、IPC も 0 回、フォーカスはダイアログ内
  await openDialog();
  for (const k of ['PageDown', 'End', 'ArrowDown', 'ArrowUp', 'PageUp', 'Home']) {
    await page.keyboard.press(k);
  }
  for (const k of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(k);
  }
  await page.waitForTimeout(250);
  const afterKeys = {
    resets: await resets(),
    open: !!(await dialogState()),
    focusInside: await page.evaluate(
      () => !!document.querySelector('[role="alertdialog"]')?.contains(document.activeElement),
    ),
  };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  // 4) OK でのみ実行
  await openDialog();
  await page.click('[role="alertdialog"] button:last-of-type');
  await page.waitForTimeout(400);
  const afterOk = { resets: await resets(), open: !!(await dialogState()) };

  detail.push('fit=' + fits.join(' '));
  const pass =
    fitOk &&
    st !== null &&
    st.modal === 'true' &&
    st.display !== 'none' &&
    defaultFocusIsCancel &&
    afterCancel.resets === 0 &&
    !afterCancel.open &&
    afterEsc.resets === 0 &&
    !afterEsc.open &&
    afterEsc.settingsStillOpen &&
    afterEsc.exits === 0 &&
    afterBackdrop.resets === 0 &&
    !afterBackdrop.open &&
    afterEnter.resets === 0 &&
    !afterEnter.open &&
    afterSpace.resets === 0 &&
    !afterSpace.open &&
    afterKeys.resets === 0 &&
    afterKeys.open &&
    afterKeys.focusInside &&
    afterOk.resets === 1 &&
    !afterOk.open;
  detail.push(
    `defaultFocusIsCancel=${defaultFocusIsCancel} cancel=${JSON.stringify(afterCancel)} esc=${JSON.stringify(afterEsc)} backdrop=${JSON.stringify(afterBackdrop)} enter=${JSON.stringify(afterEnter)} space=${JSON.stringify(afterSpace)} keys=${JSON.stringify(afterKeys)} ok=${JSON.stringify(afterOk)}`,
  );
  return { pass, detail: detail.join(' | ') };
}

/**
 * #122: 設定の checkbox / range が自前描画(appearance: none)でダークテーマに合うことを
 * 全状態(未チェック/チェック/フォーカス/disabled)で computed style から検証する。
 * E2E_SHOT_DIR を指定すると各状態のスクリーンショットを保存する(目視確認用)。
 */
async function inputDarkScenario(page, lang) {
  const shotDir = process.env.E2E_SHOT_DIR;
  const shot = async (loc, name) => {
    if (shotDir) await loc.screenshot({ path: path.join(shotDir, `${lang}-${name}.png`) });
  };
  const lum = (rgba) => {
    const m = rgba.match(/[\d.]+/g).map(Number);
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
  };
  const read = (el) =>
    el.evaluate((e) => {
      const cs = getComputedStyle(e);
      const after = getComputedStyle(e, '::after');
      const r = e.getBoundingClientRect();
      return {
        appearance: cs.appearance,
        bg: cs.backgroundColor,
        border: cs.borderTopColor,
        w: r.width,
        h: r.height,
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        opacity: cs.opacity,
        afterDisplay: after.display,
        afterClip: after.clipPath,
      };
    });

  await page.waitForSelector('svg.lucide-settings', { state: 'attached', timeout: 5000 });
  await openSettingsModal(page);
  await page.click('#tab-options');
  // transition を切って最終状態だけを検証する(遷移途中の色は見ない。reduced-motion 相当の副作用は
  // 承知の上)。設定の非同期読み込み完了も待つ。
  await page.addStyleTag({ content: '*, *::after { transition: none !important; }' });
  await page.waitForTimeout(800);
  const boxes = page.locator('input[type="checkbox"]');
  const n = await boxes.count();
  const details = [];
  let pass = n >= 2;
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    if (await box.isChecked()) await box.evaluate((e) => e.click());
    await page.waitForTimeout(250);
    const off = await read(box);
    await shot(box, `checkbox${i}-unchecked`);
    await box.evaluate((e) => e.click());
    await page.waitForTimeout(250);
    const on = await read(box);
    await shot(box, `checkbox${i}-checked`);
    // キーボード操作でフォーカスさせ :focus-visible を成立させる
    await box.evaluate((e) => e.blur());
    await page.keyboard.press('Tab');
    await box.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    const focused = await read(box);
    await shot(box, `checkbox${i}-focus`);
    await box.evaluate((e) => (e.disabled = true));
    const dis = await read(box);
    await shot(box, `checkbox${i}-disabled`);
    // hover の枠の明るさ変化は有効時だけ(disabled では効かない)。チェック済みは枠が元から
    // 明るいので、未チェックに戻して見る。
    await box.evaluate((e) => {
      e.disabled = false;
      e.click();
    });
    await page.waitForTimeout(100);
    const bb = await box.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(100);
    const hoverEnabled = await box.evaluate((e) => getComputedStyle(e).borderTopColor);
    await box.evaluate((e) => (e.disabled = true));
    await page.waitForTimeout(100);
    const hoverDisabled = await box.evaluate((e) => getComputedStyle(e).borderTopColor);
    await box.evaluate((e) => (e.disabled = false));
    await page.mouse.move(0, 0);
    // 箱の中心とラベル1行目の中心が ±1px に収まる(縦位置のずれ検出)
    const align = await box.evaluate((e) => {
      const sib = e.nextElementSibling;
      const w = document.createTreeWalker(sib, NodeFilter.SHOW_TEXT);
      let node = w.nextNode();
      while (node && !node.textContent.trim()) node = w.nextNode();
      const range = document.createRange();
      range.selectNodeContents(node);
      const line = range.getClientRects()[0];
      const b = e.getBoundingClientRect();
      return Math.abs(b.top + b.height / 2 - (line.top + line.height / 2));
    });
    const ok =
      align <= 1 &&
      off.appearance === 'none' &&
      lum(off.bg) < 0.2 &&
      lum(off.border) > 0.45 && // 枠 vs 黒背景で 3:1 以上
      off.afterDisplay === 'none' &&
      on.appearance === 'none' &&
      lum(on.bg) > 0.8 &&
      on.afterDisplay === 'block' &&
      on.afterClip.startsWith('polygon') &&
      off.w >= 20 &&
      off.h >= 20 &&
      focused.outlineStyle === 'solid' &&
      lum(focused.outlineColor) > 0.5 &&
      Number(dis.opacity) < 1 &&
      hoverDisabled === off.border &&
      hoverEnabled !== off.border;
    if (!ok) pass = false;
    details.push(
      `cb${i}=${ok} align=${align.toFixed(1)} off=${off.bg}/${off.border} on=${on.bg} focus=${focused.outlineStyle}/${focused.outlineColor} dis=${dis.opacity} hover=${hoverEnabled}/${hoverDisabled} size=${off.w}x${off.h}`,
    );
  }
  // range は全タブを巡って探す（所属タブに依存しない）
  let rangeInfo = 'range not found';
  const tabIds = await page.$$eval('[role="tab"]', (els) => els.map((e) => e.id));
  for (const id of tabIds) {
    await page.click(`#${id}`);
    await page.waitForTimeout(200);
    const range = page.locator('input[type="range"]');
    if ((await range.count()) === 0) continue;
    const r = await range.first().evaluate((e) => {
      const cs = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      return { appearance: cs.appearance, h: b.height };
    });
    await shot(range.first(), 'range');
    const ok = r.appearance === 'none' && r.h >= 20;
    if (!ok) pass = false;
    rangeInfo = `range=${ok} appearance=${r.appearance} h=${r.h}`;
    break;
  }
  if (rangeInfo === 'range not found') pass = false;
  return { pass, detail: `checkboxes=${n} ${details.join(' ')} ${rangeInfo}` };
}

/**
 * #122: 強制カラー(Windows ハイコントラスト、WebView2 に伝わる)でも、チェック済みが空の箱に
 * ならず、未チェックと視覚的に区別できることを computed style で検証する。
 * E2E_SHOT_DIR を指定すると設定モーダルのスクリーンショットを保存する(目視確認用)。
 */
async function inputForcedColorsScenario(page) {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.waitForSelector('svg.lucide-settings', { state: 'attached', timeout: 5000 });
  await openSettingsModal(page);
  await page.click('#tab-options');
  await page.addStyleTag({ content: '*, *::after { transition: none !important; }' });
  await page.waitForTimeout(800);
  const box = page.locator('input[type="checkbox"]').first();
  const read = () =>
    box.evaluate((e) => {
      const cs = getComputedStyle(e);
      const a = getComputedStyle(e, '::after');
      return {
        bg: cs.backgroundColor,
        border: cs.borderTopColor,
        afterBg: a.backgroundColor,
        afterDisplay: a.display,
        adjust: cs.forcedColorAdjust,
        forced: matchMedia('(forced-colors: active)').matches,
      };
    });
  if (await box.isChecked()) await box.evaluate((e) => e.click());
  await page.waitForTimeout(200);
  const off = await read();
  const shotDir = process.env.E2E_SHOT_DIR;
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'forced-colors-unchecked.png') });
  await box.evaluate((e) => e.click());
  await page.waitForTimeout(200);
  const on = await read();
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'forced-colors-checked.png') });
  // チェック済みは背景が未チェックと異なり、チェックマークは背景と異なる色で、表示されている
  const pass =
    off.forced &&
    on.adjust === 'none' &&
    on.bg !== off.bg &&
    on.afterDisplay === 'block' &&
    on.afterBg !== on.bg &&
    off.afterDisplay === 'none';
  // チェック済み+キーボードフォーカス: リングが塗り・枠と別色で見える(nit: 同色だと消える)
  await box.evaluate((e) => e.blur());
  await page.keyboard.press('Tab');
  await box.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  const ring = await box.evaluate((e) => {
    const cs = getComputedStyle(e);
    return {
      outline: cs.outlineColor,
      style: cs.outlineStyle,
      bg: cs.backgroundColor,
      border: cs.borderTopColor,
    };
  });
  const clip = async (name) => {
    if (!shotDir) return;
    const b = await box.boundingBox();
    await page.screenshot({
      path: path.join(shotDir, name),
      clip: { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 },
    });
  };
  await clip('forced-colors-checked-focus.png');
  // 未チェック+フォーカス
  await box.evaluate((e) => e.click());
  await page.waitForTimeout(150);
  const ringOff = await box.evaluate((e) => {
    const cs = getComputedStyle(e);
    return {
      outline: cs.outlineColor,
      style: cs.outlineStyle,
      bg: cs.backgroundColor,
      border: cs.borderTopColor,
    };
  });
  await clip('forced-colors-unchecked-focus.png');
  await box.evaluate((e) => e.click());
  await page.waitForTimeout(150);
  // checked + disabled: GrayText のまま opacity を重ねて二重に薄くしない
  await box.evaluate((e) => (e.disabled = true));
  const dis = await read();
  const disOpacity = await box.evaluate((e) => getComputedStyle(e).opacity);
  await clip('forced-colors-checked-disabled.png');
  await box.evaluate((e) => (e.disabled = false));
  // disabled では hover の枠変化が効かない(チェック済みは枠が元から Highlight なので未チェックで見る)
  await box.evaluate((e) => e.click());
  await page.waitForTimeout(150);
  const hoverCheck = async (disabled) => {
    await box.evaluate((e, d) => (e.disabled = d), disabled);
    const b = await box.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(150);
    const border = await box.evaluate((e) => getComputedStyle(e).borderTopColor);
    await page.mouse.move(0, 0);
    await box.evaluate((e) => (e.disabled = false));
    return border;
  };
  const hoverEnabled = await hoverCheck(false);
  const hoverDisabled = await hoverCheck(true);
  const colorsOk =
    ring.style === 'solid' &&
    ring.outline !== ring.bg &&
    ring.outline !== ring.border &&
    ringOff.style === 'solid' &&
    ringOff.outline !== ringOff.bg &&
    disOpacity === '1' &&
    dis.bg !== on.bg &&
    hoverDisabled !== hoverEnabled;
  return {
    pass: pass && colorsOk,
    detail: `off=${JSON.stringify(off)} on=${JSON.stringify(on)} ring=${JSON.stringify(ring)} ringOff=${JSON.stringify(ringOff)} disabledChecked=${JSON.stringify(dis)} disOpacity=${disOpacity} hover=${hoverEnabled}/${hoverDisabled}`,
  };
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
    // #93: フォルダ選択ダイアログは Rust 側で開く。ようこそ（未設定）→設定の「選択」→
    // select_and_scan（パスは渡さない）→スキャン完了で写真が表示される golden path。
    name: 'welcome → Select (dialog opened by the backend, no path sent) → scan → photos shown (#93)',
    hash: 'pickfirst',
    async run(page) {
      await page.waitForTimeout(500);
      const welcomeBefore = await isVisible(page, 'ようこそ SSS へ');
      await openSettingsModal(page);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === '選択',
        );
        if (!btn) throw new Error('「選択」ボタンが見つからない');
        btn.click();
      });
      await page.waitForTimeout(1200);
      const selectCalls = await page.evaluate(() =>
        window.__e2eLog.filter((l) => l[1] === 'select_and_scan').map((l) => l[2]),
      );
      const scanDirectoryCalls = await countCalls(page, 'scan_directory');
      const nextImageCalls = await countCalls(page, 'get_next_image');
      const photo = await findPhotoImgDisplay(page);
      const dirShown = await page.evaluate(() =>
        [...document.querySelectorAll('input')].some((i) => i.value === '/p'),
      );
      // 引数はダイアログタイトルのみ（パス文字列を渡す経路が無い）
      const pass =
        welcomeBefore &&
        selectCalls.length === 1 &&
        selectCalls[0] === JSON.stringify({ title: '写真フォルダを選択' }) &&
        scanDirectoryCalls === 0 &&
        nextImageCalls >= 1 &&
        photo !== null &&
        photo.display !== 'none' &&
        dirShown;
      return {
        pass,
        detail: `welcomeBefore=${welcomeBefore} selectCalls=${JSON.stringify(selectCalls)} scanDirectoryCalls=${scanDirectoryCalls} nextImageCalls=${nextImageCalls} photo=${JSON.stringify(photo)} dirShown=${dirShown}`,
      };
    },
  },
  {
    // #93: ダイアログをキャンセル（select_and_scan が null）してもエラー扱いにせず、何も変わらない。
    name: 'cancelling the backend dialog (select_and_scan → null) is not an error and changes nothing (#93)',
    hash: 'pickcancel',
    async run(page) {
      await page.waitForTimeout(500);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === '選択',
        );
        if (!btn) throw new Error('「選択」ボタンが見つからない');
        btn.click();
      });
      await page.waitForTimeout(800);
      const selectCalls = await countCalls(page, 'select_and_scan');
      const nextImageCalls = await countCalls(page, 'get_next_image');
      const errorShown = await page.evaluate(() => !!document.querySelector('.text-red-400\\/70'));
      const resultShown = await isVisible(page, 'スキャン結果');
      const selectEnabled = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === '選択',
        );
        return !!btn && !btn.disabled;
      });
      const pass =
        selectCalls === 1 && nextImageCalls === 0 && !errorShown && !resultShown && selectEnabled;
      return {
        pass,
        detail: `selectCalls=${selectCalls} nextImageCalls=${nextImageCalls} errorShown=${errorShown} resultShown=${resultShown} selectEnabled=${selectEnabled}`,
      };
    },
  },
  {
    // #93: 2回目以降の起動。復元・バックグラウンド再スキャン・設定画面の「スキャン」は
    // すべて引数なし（DB保存済みの前回フォルダが対象）で、パスを渡す経路を通らない。
    name: 'restart restores and rescans the saved last folder with argument-less commands (#93)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(800);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === 'スキャン',
        );
        if (!btn) throw new Error('「スキャン」ボタンが見つからない');
        btn.click();
      });
      await page.waitForTimeout(600);
      const argsOf = (cmd) =>
        page.evaluate((c) => window.__e2eLog.filter((l) => l[1] === c).map((l) => l[2]), cmd);
      const restoreArgs = await argsOf('restore_playlist');
      const rescanArgs = await argsOf('rescan_last_directory');
      const legacyScan = await countCalls(page, 'scan_directory');
      const nextImageCalls = await countCalls(page, 'get_next_image');
      // 起動時の背景スキャン1回 + 設定画面の「スキャン」1回
      const pass =
        restoreArgs.length === 1 &&
        restoreArgs[0] === '{}' &&
        rescanArgs.length === 2 &&
        rescanArgs.every((a) => a === '{}') &&
        legacyScan === 0 &&
        nextImageCalls >= 1;
      return {
        pass,
        detail: `restoreArgs=${JSON.stringify(restoreArgs)} rescanArgs=${JSON.stringify(rescanArgs)} legacyScan=${legacyScan} nextImageCalls=${nextImageCalls}`,
      };
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
  {
    // #65レビュー2巡目: 一時停止中に動画へ移っても再生されない（autoPlayが
    // isPlaying=falseで評価される）、再開すると再生され、終了後は次へ進む。
    name: 'paused video does not autoplay; resumes on unpause and advances on end',
    hash: 'pausevid',
    async run(page) {
      await page.waitForTimeout(1200); // 最初の画像(a)の表示を待つ
      await clickButtonByTitle(page, '一時停止');
      await page.keyboard.press('ArrowRight'); // 動画へ手動で進む(一時停止中でも進める)
      await page.waitForTimeout(900);

      const whilePaused = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { paused: v.paused, t: +v.currentTime.toFixed(2) } : null;
      });
      // 一時停止中はvideoが再生されていない(autoPlay={false})はず。
      // 少し待っても currentTime が進んでいないことも確認する。
      await page.waitForTimeout(500);
      const stillPaused = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { paused: v.paused, t: +v.currentTime.toFixed(2) } : null;
      });
      const notPlayingWhilePaused =
        !!whilePaused &&
        whilePaused.paused === true &&
        !!stillPaused &&
        stillPaused.paused === true &&
        stillPaused.t <= whilePaused.t + 0.05;

      const nextsBeforeResume = await countCalls(page, 'get_next_image');
      await clickButtonByTitle(page, '再生');
      await page.waitForTimeout(600);
      const afterResume = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { paused: v.paused } : null;
      });
      const playingAfterResume = !!afterResume && afterResume.paused === false;

      // 動画が終了して次(b.png)へ進むまで待つ。
      const deadline = Date.now() + 8000;
      let advanced = false;
      while (Date.now() < deadline) {
        const nexts = await countCalls(page, 'get_next_image');
        if (nexts > nextsBeforeResume) {
          advanced = true;
          break;
        }
        await page.waitForTimeout(300);
      }

      return {
        pass: notPlayingWhilePaused && playingAfterResume && advanced,
        detail: `whilePaused=${JSON.stringify(whilePaused)} stillPaused=${JSON.stringify(stillPaused)} afterResume=${JSON.stringify(afterResume)} advanced=${advanced}`,
      };
    },
  },
  {
    // #65レビュー2巡目S9(must): 一時停止中はrootUnavailableの自動再試行が
    // 裏で進まない。再開すると表示間隔ごとの再試行が効いて最終的に回復する。
    name: 'rootUnavailable does not auto-retry while paused, retries after resume (S4/S9)',
    hash: 'root',
    async run(page) {
      await page.waitForTimeout(1200); // 1回目: found(a)
      await clickButtonByTitle(page, '一時停止');
      await page.keyboard.press('ArrowRight'); // 2回目: rootUnavailable
      await page.waitForTimeout(800);

      const nextsWhilePaused = await countCalls(page, 'get_next_image');
      // display_interval=5秒。一時停止中はこの間ずっと再試行が起きないはず。
      await page.waitForTimeout(6000);
      const nextsAfterWaitingPaused = await countCalls(page, 'get_next_image');
      const noRetryWhilePaused = nextsAfterWaitingPaused === nextsWhilePaused;

      // 直前の画像(a)を維持しているはず(rootUnavailableは画像を消さない)。
      const photoWhilePaused = await findPhotoImgDisplay(page);

      await clickButtonByTitle(page, '再生');
      const deadline = Date.now() + 12000;
      let recovered = false;
      while (Date.now() < deadline) {
        const found = await isVisible(page, '前回のフォルダを読めません');
        const nexts = await countCalls(page, 'get_next_image');
        if (!found && nexts >= nextsAfterWaitingPaused + 2) {
          recovered = true;
          break;
        }
        await page.waitForTimeout(500);
      }

      return {
        pass: noRetryWhilePaused && !!photoWhilePaused && recovered,
        detail: `noRetryWhilePaused=${noRetryWhilePaused} photoWhilePaused=${JSON.stringify(photoWhilePaused)} recovered=${recovered}`,
      };
    },
  },
  {
    // #65レビュー2巡目: 壊れた画像(実ブラウザで本物のonErrorが起きるデータURI)は
    // undo_display_countが呼ばれてから即座に次へ進む。
    name: 'a broken image fires a real onError, calls undo, and advances',
    hash: 'broken',
    async run(page) {
      const deadline = Date.now() + 8000;
      let pass = false;
      let lastDetail = '';
      while (Date.now() < deadline) {
        const undoCalls = await countCalls(page, 'undo_display_count');
        const nexts = await countCalls(page, 'get_next_image');
        lastDetail = `undoCalls=${undoCalls} nexts=${nexts}`;
        if (undoCalls >= 1 && nexts >= 2) {
          pass = true;
          break;
        }
        await page.waitForTimeout(300);
      }
      return { pass, detail: lastDetail };
    },
  },
  {
    // #120: 壊れた/0バイトの画像が4件続いても、黒画面のまま表示間隔(5秒)を待たず
    // 即座に読み飛ばして正常な画像に到達し、連続3件目から控えめなトーストが出る。
    name: 'broken/0-byte images are skipped immediately (no black wait) and a soft toast appears (#120)',
    hash: 'brokenrun',
    async run(page) {
      const started = Date.now();
      let reachedMs = null;
      let toastSeen = false;
      while (Date.now() - started < 9000) {
        const st = await page.evaluate(() => {
          const img = [...document.querySelectorAll('img')].find(
            (el) => el.alt !== 'SSS Logo' && el.getAttribute('src'),
          );
          return img ? { w: img.naturalWidth, src: img.src.slice(0, 22) } : null;
        });
        if (!toastSeen && (await isVisible(page, '読み込めない写真をスキップしています'))) {
          toastSeen = true;
          if (process.env.E2E_SHOT_DIR) {
            // 成功までの短い間しか出ないので、フェード分だけ待って即撮る。
            await page.waitForTimeout(120);
            await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/toast-ja.png` });
          }
        }
        if (st && st.w > 0) {
          reachedMs = Date.now() - started;
          break;
        }
        await page.waitForTimeout(50);
      }
      // 表示間隔は5秒。到達が5秒未満（＝間隔を待っていない）であること。
      const undoCalls = await countCalls(page, 'undo_display_count');
      const pass = reachedMs !== null && reachedMs < 5000 && toastSeen && undoCalls >= 4;
      if (process.env.E2E_SHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/brokenrun-ja.png` });
      }
      return {
        pass,
        detail: `reachedMs=${reachedMs} toastSeen=${toastSeen} undoCalls=${undoCalls}`,
      };
    },
  },
  ...[
    {
      name: 'ja',
      hash: 'allbroken',
      locale: 'ja-JP',
      title: '読み込める画像がありません',
      button: '設定を開く',
    },
    {
      name: 'en',
      hash: 'allbrokenen',
      locale: 'en-US',
      title: 'No photos could be loaded',
      button: 'Open Settings',
    },
  ].map((c) => ({
    // #120: 全件が壊れている（失敗セットが再生リスト総数に達した）場合は無限ループ・CPU空転に
    // ならず、すぐ停止して案内（続ける/設定を開く導線つき）を出し、その後 get_next_image を叩き続けない。
    name: `all images broken: stops once every photo failed and shows guidance, no endless loop (${c.name}) (#120)`,
    hash: c.hash,
    locale: c.locale,
    async run(page) {
      const deadline = Date.now() + 15000;
      let shown = false;
      while (Date.now() < deadline) {
        if (await isVisible(page, c.title)) {
          shown = true;
          break;
        }
        await page.waitForTimeout(150);
      }
      const buttonShown = await page.evaluate(
        (label) =>
          [...document.querySelectorAll('button')].some(
            (b) => b.textContent.includes(label) && getComputedStyle(b).display !== 'none',
          ),
        c.button,
      );
      const nextsAtStop = await countCalls(page, 'get_next_image');
      await page.waitForTimeout(6000); // 表示間隔(5秒)以上待って、再試行し続けないことを見る
      const nextsLater = await countCalls(page, 'get_next_image');
      const stillShown = await isVisible(page, c.title);
      if (process.env.E2E_SHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/allbroken-${c.name}.png` });
      }
      return {
        pass: shown && buttonShown && stillShown && nextsAtStop <= 4 && nextsLater === nextsAtStop,
        detail: `shown=${shown} button=${buttonShown} stillShown=${stillShown} nextsAtStop=${nextsAtStop} nextsLater=${nextsLater}`,
      };
    },
  })),
  ...[
    {
      name: 'ja',
      hash: 'streakbroken',
      locale: 'ja-JP',
      title: '連続して読み込めませんでした',
      all: '読み込める画像がありません',
      cont: '続ける',
      settings: '設定を開く',
    },
    {
      name: 'en',
      hash: 'streakbrokenen',
      locale: 'en-US',
      title: 'Several photos in a row failed to load',
      all: 'No photos could be loaded',
      cont: 'Continue',
      settings: 'Open Settings',
    },
  ].map((c) => ({
    // #120: 総数が大きいプレイリストで壊れたファイルが連続10件続いた場合は、「全件破損」と
    // 断定せず「連続して読み込めませんでした」で止まり、「続ける」「設定を開く」の2ボタンを出す。
    // 「続ける」で失敗セットを空にして次の写真を試し直す。
    name: `10 broken in a row in a large playlist: non-final stop with Continue and Settings (${c.name}) (#120)`,
    hash: c.hash,
    locale: c.locale,
    async run(page) {
      const deadline = Date.now() + 15000;
      let shown = false;
      while (Date.now() < deadline) {
        if (await isVisible(page, c.title)) {
          shown = true;
          break;
        }
        await page.waitForTimeout(150);
      }
      const hasButton = (label) =>
        page.evaluate(
          (l) =>
            [...document.querySelectorAll('button')].some(
              (b) => b.textContent.trim().includes(l) && getComputedStyle(b).display !== 'none',
            ),
          label,
        );
      const continueShown = await hasButton(c.cont);
      const settingsShown = await hasButton(c.settings);
      const notFinal = !(await isVisible(page, c.all));
      const nextsAtStop = await countCalls(page, 'get_next_image');
      if (process.env.E2E_SHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/streak-${c.name}.png` });
      }
      // 「続ける」で再開する（カードが閉じ、get_next_image が再び呼ばれる）。
      await page.evaluate((l) => {
        [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim().includes(l))
          .click();
      }, c.cont);
      await page.waitForTimeout(800);
      const nextsAfterContinue = await countCalls(page, 'get_next_image');
      return {
        pass:
          shown &&
          continueShown &&
          settingsShown &&
          notFinal &&
          nextsAtStop >= 10 &&
          nextsAtStop <= 11 &&
          nextsAfterContinue > nextsAtStop,
        detail: `shown=${shown} continue=${continueShown} settings=${settingsShown} notFinal=${notFinal} nextsAtStop=${nextsAtStop} nextsAfterContinue=${nextsAfterContinue}`,
      };
    },
  })),
  {
    // #120: 動画の読み込み失敗（本物の <video> onError）も画像と同じく undo → 次へ進む。
    name: 'a broken video fires a real onError, calls undo, and advances (#120)',
    hash: 'brokenvid',
    async run(page) {
      const deadline = Date.now() + 8000;
      let pass = false;
      let lastDetail = '';
      while (Date.now() < deadline) {
        const undoCalls = await countCalls(page, 'undo_display_count');
        const nexts = await countCalls(page, 'get_next_image');
        lastDetail = `undoCalls=${undoCalls} nexts=${nexts}`;
        if (undoCalls >= 1 && nexts >= 2) {
          pass = true;
          break;
        }
        await page.waitForTimeout(200);
      }
      return { pass, detail: lastDetail };
    },
  },
  {
    // #120: onLoad も onError も来ない（読み込みが永久に pending の）画像で黒画面のまま止まらない。
    // 見張りが max(表示間隔, 下限) 後に失敗として次へ進め、console.warn に原因診断を残す。
    name: 'a never-settling image is force-skipped by the watchdog with a diagnostic warning (#120)',
    hash: 'pending',
    async setup(page) {
      // 応答しない（fulfill も abort もしない）＝ img は pending のまま。
      await page.route('**/__e2e_pending.png', () => {});
    },
    async run(page) {
      const warns = [];
      page.on('console', (m) => {
        if (m.type() === 'warning') warns.push(m.text());
      });
      const started = Date.now();
      let reachedMs = null;
      while (Date.now() - started < 16000) {
        const loaded = await page.evaluate(() =>
          [...document.querySelectorAll('img')].some(
            (el) => el.alt !== 'SSS Logo' && el.getAttribute('src') && el.naturalWidth > 0,
          ),
        );
        if (loaded) {
          reachedMs = Date.now() - started;
          break;
        }
        await page.waitForTimeout(100);
      }
      const undoCalls = await countCalls(page, 'undo_display_count');
      const warned = warns.some((w) => w.includes('media watchdog'));
      // 見張りは表示間隔（5〜10秒）後。それより早く進んだなら別の経路で進んでいる＝見張りの検証にならない。
      return {
        pass: reachedMs !== null && reachedMs >= 4500 && warned && undoCalls >= 1,
        detail: `reachedMs=${reachedMs} warned=${warned} undoCalls=${undoCalls}`,
      };
    },
  },
  {
    // #65レビュー2巡目S8(must): 動画→動画の遷移で、退場中の古い動画要素が
    // play()で先頭から再生し直されない（＝短い動画でonEndedが二重発火して
    // 1枚飛ばすことがない）。同一DOM要素をJSのexpandoプロパティでタグ付けし、
    // 「ended済みだった同一要素が、少し後にended=falseかつcurrentTime≈0で
    // 再び観測される」という再生し直しの兆候が無いことを高頻度サンプリングで
    // 確認する。
    name: 'video→video: the old (exiting) video element is not replayed from the start (S8)',
    hash: 'vv',
    async run(page) {
      let prevEndedSameElement = false;
      let regression = null;
      const seenPaths = new Set();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !regression) {
        const sample = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          const isNewElement = !v.__e2eTagged;
          v.__e2eTagged = true;
          return {
            path: window.__e2eCurrentPath,
            t: +v.currentTime.toFixed(3),
            ended: v.ended,
            isNewElement,
          };
        });
        if (sample) {
          seenPaths.add(sample.path);
          if (sample.isNewElement) {
            prevEndedSameElement = false;
          } else if (prevEndedSameElement && !sample.ended && sample.t < 0.1) {
            regression = sample;
          }
          prevEndedSameElement = sample.ended;
        }
        await page.waitForTimeout(30);
      }
      const bothVideosSeen = seenPaths.has('/p/v.webm') && seenPaths.has('/p/v2.webm');
      return {
        pass: !regression && bothVideosSeen,
        detail: regression
          ? `古い動画要素が再生し直された兆候: ${JSON.stringify(regression)}`
          : `bothVideosSeen=${bothVideosSeen} seenPaths=${[...seenPaths].join(',')}`,
      };
    },
  },
  {
    // #68: 動画設定UI（音声ON/OFF・最大再生時間）の保存と復元。実ブラウザで
    // (1) ラベル経由でチェック/選択でき、(2) save_setting が正しい値で呼ばれ、
    // (3) Slideshow の <video>.muted に反映され、(4) 再読み込み（=アプリ再起動）で
    // 復元され、(5) キーボード（Space）だけでも切り替えられる、ことを確認する。
    name: 'video settings: UI saves audio/max-duration, restores after reload, keyboard operable (#68)',
    hash: 'vidset',
    async run(page) {
      const videoMuted = () =>
        page.evaluate(() => {
          const v = document.querySelector('video');
          return v ? v.muted : null;
        });
      const savedValues = (key) =>
        page.evaluate(
          (k) =>
            window.__e2eLog
              .filter((l) => l[1] === 'save_setting' && l[2].includes(`"key":"${k}"`))
              .map((l) => JSON.parse(l[2]).value),
          key,
        );
      const openOptions = async () => {
        await openSettingsModal(page);
        await page.click('#tab-options');
        await page.waitForTimeout(200);
      };

      await page.waitForSelector('video', { timeout: 5000 });
      const mutedInitially = await videoMuted(); // 既定はOFF=無音

      await openOptions();
      const audio = page.getByLabel('動画の音声を再生する');
      const select = page.getByLabel('動画の最大再生時間');
      const defaultsOk = !(await audio.isChecked()) && (await select.inputValue()) === '0';
      await audio.check();
      await select.selectOption('60');
      await page.waitForTimeout(200);
      const audioSaves = await savedValues('video_audio_enabled');
      const durationSaves = await savedValues('video_max_duration_sec');
      const mutedAfterOn = await videoMuted();

      // 再読み込み=再起動。sessionStorage経由で保存値が復元される。
      await page.reload();
      await page.waitForSelector('video', { timeout: 5000 });
      const mutedAfterReload = await videoMuted();
      await openOptions();
      const restoredAudio = await page.getByLabel('動画の音声を再生する').isChecked();
      const restoredDuration = await page.getByLabel('動画の最大再生時間').inputValue();

      // キーボードだけで切り替える（フォーカス→Space）。
      await page.getByLabel('動画の音声を再生する').focus();
      await page.keyboard.press('Space');
      await page.waitForTimeout(200);
      const keyboardOff = !(await page.getByLabel('動画の音声を再生する').isChecked());
      const audioSavesAfterKey = await savedValues('video_audio_enabled');

      const pass =
        mutedInitially === true &&
        defaultsOk &&
        audioSaves.at(-1) === 'true' &&
        durationSaves.at(-1) === '60' &&
        mutedAfterOn === false &&
        mutedAfterReload === false &&
        restoredAudio === true &&
        restoredDuration === '60' &&
        keyboardOff &&
        audioSavesAfterKey.at(-1) === 'false';
      return {
        pass,
        detail: `mutedInitially=${mutedInitially} defaultsOk=${defaultsOk} audioSaves=${audioSaves} durationSaves=${durationSaves} mutedAfterOn=${mutedAfterOn} mutedAfterReload=${mutedAfterReload} restored=${restoredAudio}/${restoredDuration} keyboardOff=${keyboardOff} audioSavesAfterKey=${audioSavesAfterKey}`,
      };
    },
  },
  {
    // #68: 最大再生時間に達したら次へ進み、1回しか進まず、退場中の古い動画は
    // ミュート+一時停止される（音声ON）。実際に30秒待つ代わりに、動画要素の
    // currentTime を差し替えて timeupdate を発火させる（動画自体は loop で
    // 自然終了させない）。AnimatePresence の実マウント・退場を実ブラウザで通す。
    name: 'video max duration: cap reached advances exactly once and silences the exiting video (#68)',
    hash: 'vidcap',
    async run(page) {
      await page.waitForSelector('video', { timeout: 5000 });
      const before = await countCalls(page, 'get_next_image');
      const state = await page.evaluate(async () => {
        const v = document.querySelector('video');
        v.loop = true; // 2秒の動画が自然終了(ended)しないようにして上限側だけを検証する
        const mutedBefore = v.muted;
        Object.defineProperty(v, 'currentTime', { configurable: true, get: () => 31 });
        v.dispatchEvent(new Event('timeupdate'));
        v.dispatchEvent(new Event('timeupdate')); // 二重発火しても1回しか進まない
        await new Promise((r) => setTimeout(r, 150));
        // 退場アニメーション(500ms)中なので古い動画がまだDOMに残っている
        return {
          mutedBefore,
          exitingMuted: v.muted,
          exitingPaused: v.paused,
          attached: v.isConnected,
        };
      });
      await page.waitForTimeout(2500); // 次の画像は5秒間隔なので、この間は追加で進まない
      const after = await countCalls(page, 'get_next_image');
      const pass =
        state.mutedBefore === false &&
        state.attached &&
        state.exitingMuted === true &&
        state.exitingPaused === true &&
        after === before + 1;
      return {
        pass,
        detail: `state=${JSON.stringify(state)} nextCalls before=${before} after=${after}`,
      };
    },
  },
  {
    // #68: 動画が上限より短い場合は従来どおり onEnded で進む（1回だけ）。
    name: 'video shorter than the cap still advances exactly once via ended (#68)',
    hash: 'vidend',
    async run(page) {
      await page.waitForSelector('video', { timeout: 5000 });
      const before = await countCalls(page, 'get_next_image');
      const mutedOff = await page.evaluate(() => document.querySelector('video').muted);
      let advanced = false;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if ((await countCalls(page, 'get_next_image')) > before) {
          advanced = true;
          break;
        }
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(2000);
      const after = await countCalls(page, 'get_next_image');
      return {
        pass: mutedOff === true && advanced && after === before + 1,
        detail: `muted=${mutedOff} advanced=${advanced} before=${before} after=${after}`,
      };
    },
  },
  {
    // #68: 起動時の拒否経路。音声ON設定で、起動直後から音声付き play() と autoplay
    // 属性が自動再生ポリシーで拒否される。操作なしで onLoadedData の明示 play() が
    // 拒否(NotAllowedError)を観測し、その動画だけミュートへ落として再生に至る。
    name: 'video audio ON at startup: a rejected play() falls back to muted and starts playing (#68)',
    hash: 'vidblock',
    async run(page) {
      await page.waitForSelector('video', { timeout: 5000 });
      // 最初に「再生中」になった瞬間の状態を取る（2秒動画が終わって次へ進む前に）。
      let playing = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        playing = await page.evaluate(() => {
          const v = document.querySelector('video');
          return v && !v.paused
            ? { paused: v.paused, muted: v.muted, blocked: window.__blockedPlays }
            : null;
        });
        if (playing) break;
        await page.waitForTimeout(50);
      }
      return {
        pass: !!playing && playing.muted === true && playing.blocked >= 1,
        detail: `firstPlaying=${JSON.stringify(playing)}`,
      };
    },
  },
  {
    // #68: 再開時の拒否経路。起動時は許可され音声付きで再生している状態から、一時停止
    // 中にポリシーが拒否へ変わり、再開の play() が NotAllowedError で拒否される。
    // 一時停止までは muted=false のまま（起動時経路のフォールバックが効いていない
    // ことの確認）、再開でその要素がミュートへ落ちて再生を続ける。
    name: 'video audio ON: a play() rejected on resume falls back to muted and keeps playing (#68)',
    hash: 'vidresume',
    async run(page) {
      await page.waitForSelector('video', { timeout: 5000 });
      await page.evaluate(() => {
        document.querySelector('video').loop = true;
      });
      await clickButtonByTitle(page, '一時停止');
      await page.waitForTimeout(300);
      const pausedState = await page.evaluate(() => {
        const v = document.querySelector('video');
        const blockedBefore = window.__blockedPlays;
        window.__blockUnmutedPlay = true; // ここから音声付き play() が拒否される
        return { paused: v.paused, muted: v.muted, blockedBefore };
      });
      await clickButtonByTitle(page, '再生');
      await page.waitForTimeout(700);
      const resumed = await page.evaluate(() => {
        const v = document.querySelector('video');
        return { paused: v.paused, muted: v.muted, blocked: window.__blockedPlays };
      });
      return {
        pass:
          pausedState.paused === true &&
          pausedState.muted === false &&
          pausedState.blockedBefore === 0 &&
          resumed.paused === false &&
          resumed.muted === true &&
          resumed.blocked >= 1,
        detail: `pausedState=${JSON.stringify(pausedState)} resumed=${JSON.stringify(resumed)}`,
      };
    },
  },
  {
    // #65レビュー3巡目M4(must): 「同じpathの連続表示はフェード省略」nitが、
    // AnimatePresence(mode="wait")の退場500ms中の再レンダーで誤って発火し、
    // 画像→動画・動画→画像を含む全ての切り替えでフェードインが消えていた
    // （新要素がopacity 0→1ではなく瞬時に1で現れる）。
    //
    // 判定（#124で作り直し）: 「新しくマウントされた要素そのもの」を追跡する。
    // ページ読み込み前（setup）に MutationObserver を仕込み、メディア要素（video/img）が
    // DOM に追加された**その瞬間**（microtask、描画前）の computed opacity を要素ごとに記録する。
    //   - 合格 = 追加直後の最初の値が低く(<0.9)、**同じ要素**が後に高く(>=0.95)なった要素がある。
    //   - 退場中の既存要素が下がる低 opacity は、新要素ではないので数えない
    //     （旧実装は観測窓が長いと自動送りの退場フェードアウトを「低」と誤認し、
    //     次の画像が opacity 1 で瞬時に出ても PASS した）。
    //   - マウントが観測開始より前に終わって低 opacity を見逃す問題もない（観測は操作前から常時）。
    // 窓の長さに依存せず、条件が満たされるまで待つ（上限は退場500ms+フェード500msに対し十分長い）。
    name: 'newly mounted media always fades in over ~0.5s, never appears instantly at opacity 1 (M4)',
    hash: 'fade',
    async setup(page) {
      await page.addInitScript(() => {
        const tracked = [];
        window.__fadeTracked = tracked;
        const record = (el) => {
          if (tracked.some((t) => t.el === el)) return;
          const first = Number(getComputedStyle(el).opacity);
          tracked.push({
            el,
            kind: el.tagName.toLowerCase(),
            first,
            maxAfter: first,
            samples: [Number(first.toFixed(3))],
          });
        };
        const isMedia = (el) =>
          el.nodeType === 1 &&
          (el.tagName === 'VIDEO' || (el.tagName === 'IMG' && el.alt !== 'SSS Logo'));
        new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue;
              if (isMedia(n)) record(n);
              n.querySelectorAll &&
                n.querySelectorAll('video,img').forEach((e) => isMedia(e) && record(e));
            }
          }
        }).observe(document, { childList: true, subtree: true });
        setInterval(() => {
          for (const t of tracked) {
            if (!t.el.isConnected) continue;
            const o = Number(getComputedStyle(t.el).opacity);
            if (o > t.maxAfter) t.maxAfter = o;
            if (t.samples.length < 200) t.samples.push(Number(o.toFixed(3)));
          }
        }, 16);
      });
    },
    async run(page) {
      const summary = () =>
        page.evaluate(() =>
          window.__fadeTracked.map((t, i) => ({
            i,
            kind: t.kind,
            first: Number(t.first.toFixed(3)),
            max: Number(t.maxAfter.toFixed(3)),
          })),
        );
      // `from` 以降に追加された kind の要素で「最初の値<0.9 かつ同じ要素が>=0.95に到達」したものを待つ。
      async function expectFadeIn(from, kind) {
        const ok = await page
          .waitForFunction(
            ([f, k]) =>
              window.__fadeTracked
                .slice(f)
                .some((t) => (k === 'any' || t.kind === k) && t.first < 0.9 && t.maxAfter >= 0.95),
            [from, kind],
            { timeout: 12000, polling: 50 },
          )
          .then(
            () => true,
            () => false,
          );
        return ok;
      }
      const count = () => page.evaluate(() => window.__fadeTracked.length);

      // 初回マウント(画像a)。
      const initial = await expectFadeIn(0, 'img');

      // 手動で次へ進み、2件目(動画)への切り替わりのフェードインも見る。
      const beforeVideo = await count();
      await page.keyboard.press('ArrowRight');
      const toVideo = await expectFadeIn(beforeVideo, 'video');

      // さらに次へ進み、動画→画像の切り替わりも確認する。
      const beforeImage = await count();
      await page.keyboard.press('ArrowRight');
      const toImage = await expectFadeIn(beforeImage, 'img');

      const pass = initial && toVideo && toImage;
      return {
        pass,
        detail: `initial=${initial} toVideo=${toVideo} toImage=${toImage} tracked=${JSON.stringify(await summary())}`,
      };
    },
  },
  {
    // #80: 言語決定は app_settings.language ('ja'|'en'|'auto') → auto は
    // navigator.language（ja*ならja、それ以外en）。`locale: 'en-US'`
    // （Playwrightのbrowser.newPageオプション）でnavigator.languageを
    // en-US化し、ようこそ画面が英語で表示されることを確認する
    // （ディレクトリ未設定=hash 'welcome' の初回起動シナリオを流用）。
    name: 'English locale (navigator.language=en-US): welcome screen renders in English',
    hash: 'welcome',
    locale: 'en-US',
    async run(page) {
      await page.waitForTimeout(500);
      const welcomeVisible = await isVisible(page, 'Welcome to SSS');
      // 「フォルダを選択」ボタンはアイコン(SVG)とテキストが兄弟要素のため、
      // isVisible()の葉ノード限定チェックには乗らない。ボタン本文で直接確認する。
      const selectFolderVisible = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) =>
          b.textContent.includes('Select Folder'),
        ),
      );
      const notJapanese = !(await isVisible(page, 'ようこそ SSS へ'));
      const htmlLang = await page.evaluate(() => document.documentElement.lang);
      const pass = welcomeVisible && selectFolderVisible && notJapanese && htmlLang === 'en';
      return {
        pass,
        detail: `welcomeVisible=${welcomeVisible} selectFolderVisible=${selectFolderVisible} notJapanese=${notJapanese} htmlLang=${htmlLang}`,
      };
    },
  },
  {
    // #80: 英語ロケールでもオーバーレイUI（ウィンドウchrome）の文言が英語になる
    // ことを確認する（終了ボタンのtitle属性で判定。マウスアイドル判定に左右
    // されない安定した検証にするためDOM属性を直接見る）。
    name: 'English locale (navigator.language=en-US): window chrome (exit tooltip) renders in English',
    hash: 'slides',
    locale: 'en-US',
    async run(page) {
      await page.waitForTimeout(500);
      const exitTitle = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          (b.title || '').toLowerCase().includes('esc'),
        );
        return btn ? btn.title : null;
      });
      const pass = exitTitle === 'Exit (Esc)';
      return { pass, detail: `exitTitle=${JSON.stringify(exitTitle)}` };
    },
  },
  {
    // #82レビュー2巡目 should1（回帰）/ 3巡目 should+nit: tabScanを「フォルダ」に
    // した影響で、設定タブ行が幅720・ja だと各タブ文字が1文字ずつ折り返っていた
    // （Settings/index.tsxのタブボタンにwhitespace-nowrap+flex-shrink-0、
    // タブ行にoverflow-x-autoを追加して修正、パディングもpx-4→px-3に縮小）。
    // 幅1280/720（横スクロール不要）・幅320（横スクロールは可能なまま）の
    // 3段階 x ja/enで、各タブボタンの**テキストが実際に1行で描画されている**
    // ことを確認する（3巡目should: 旧実装は「全ボタンのtop座標が一致」だけで
    // 判定しており、全ボタンが同時に2行割れする今回の回帰そのものを検出できな
    // かった。flexコンテナの既定align-items:stretchで、全ボタンが同じ高さに
    // 揃うため外側のtopは折返し有無に関わらず一致してしまう。ボタン内テキストの
    // Range.getClientRects()で実際の行数を見る方式に直した）。
    name: 'Settings tab row: each tab label renders on one line, no h-scroll at 720, scrollable when narrower (ja) (#82レビュー2/3巡目 should1)',
    hash: 'welcome', // ディレクトリ未設定→ようこそ画面。設定ボタンは常設なのでどのhashでも開ける
    async run(page) {
      return measureSettingsTabRowAtWidths(page);
    },
  },
  {
    name: 'Settings tab row: each tab label renders on one line, no h-scroll at 720, scrollable when narrower (en) (#82レビュー2/3巡目 should1)',
    hash: 'welcome',
    locale: 'en-US',
    async run(page) {
      return measureSettingsTabRowAtWidths(page);
    },
  },
  {
    // #66レビュー2巡目should2: 垂直中央寄せ(items-center)だと、タブ切替で
    // 内容の高さが変わるたびにモーダル自体の上端位置（＝ヘッダー・タブ行の
    // 位置）が上下に動いてしまっていた。上寄せ(items-start + pt-[12vh])に
    // 変更したことで、内容量が大きく異なるタブ（フォルダ=長い/情報=短い等）へ
    // 切り替えてもタブ行の画面上でのY座標（getBoundingClientRect().top）が
    // 変わらないことを確認する。
    name: 'Settings modal tab row top position does not move when switching between tabs of different content height (#66レビュー2巡目should2)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await openSettingsModal(page);

      const tabRowTop = () =>
        page.evaluate(() => {
          const row = document.querySelector('.overflow-x-auto');
          return row ? row.getBoundingClientRect().top : null;
        });
      const clickTabByLabel = (label) =>
        page.evaluate((l) => {
          const tabs = [...document.querySelectorAll('[role="tab"]')];
          const tab = tabs.find((t) => t.textContent.includes(l));
          if (!tab) throw new Error(`タブ「${l}」が見つからない`);
          tab.click();
        }, label);

      const initialTop = await tabRowTop();
      // 内容量が大きく異なるタブを順に回る（フォルダ=スキャン結果表示で
      // 縦に長め、情報=短め、除外ルール=中間）。
      const tops = { initial: initialTop };
      for (const label of ['情報', 'フォルダ', '除外ルール', 'オプション']) {
        await clickTabByLabel(label);
        await page.waitForTimeout(150);
        tops[label] = await tabRowTop();
      }

      const allTops = Object.values(tops);
      // 1px未満の丸め誤差は許容する。
      const allSame = allTops.every((t) => t !== null && Math.abs(t - initialTop) < 1);
      return { pass: allSame, detail: JSON.stringify(tops) };
    },
  },
  {
    // #109: 設定モーダルのタブ行（role=tablist）は overflow-x-auto の flex 子で
    // 最小高が0になるため、タブ内容が長い（オプション等）と flex-shrink で
    // 行ごと潰れていた（1280x800 で 39→31px、800x600 で 21px。ラベル下部が
    // 切れる）。shrink-0 で潰れないことを、ja で 3 サイズ × 全 7 タブの
    // getBoundingClientRect().height が一定であることで確認する。
    name: 'Settings tablist height stays constant across all tabs and viewport sizes, ja (#109)',
    hash: 'slides',
    async run(page) {
      return measureSettingsTablistHeights(page);
    },
  },
  {
    name: 'Settings tablist height stays constant across all tabs and viewport sizes, en (#109)',
    hash: 'slides',
    locale: 'en-US',
    async run(page) {
      return measureSettingsTablistHeights(page);
    },
  },
  {
    // #66 問題1: 設定を開いている間のESCはモーダルを閉じるだけで、exit_appは
    // 呼ばない（以前はフェーズに関わらず常にexit_appを呼んでいた）。
    name: 'Escape closes the Settings modal instead of exiting the app while it is open (#66 問題1)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await openSettingsModal(page);
      const tabRowVisibleBefore = await page.evaluate(
        () => !!document.querySelector('.overflow-x-auto'),
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const tabRowVisibleAfter = await page.evaluate(
        () => !!document.querySelector('.overflow-x-auto'),
      );
      const exitCalls = await countCalls(page, 'exit_app');
      const pass = tabRowVisibleBefore && !tabRowVisibleAfter && exitCalls === 0;
      return {
        pass,
        detail: `tabRowVisibleBefore=${tabRowVisibleBefore} tabRowVisibleAfter=${tabRowVisibleAfter} exitCalls=${exitCalls}`,
      };
    },
  },
  {
    name: 'Escape calls exit_app when nothing (Settings/Shortcuts) is open (#66 問題1)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const exitCalls = await countCalls(page, 'exit_app');
      return { pass: exitCalls === 1, detail: `exitCalls=${exitCalls}` };
    },
  },
  {
    // #66 問題2: 旧実装はホバーで自動一時停止する`isPlaying`をアイコンにそのまま
    // 使っていたため、ボタンが見える間(=マウスがオーバーレイ上)は常に▶固定に
    // 見えていた。Space操作後、実ブラウザで▶/⏸ツールチップが正しく切り替わる
    // ことを確認する。
    name: 'Space toggles the pause/play icon+tooltip in the overlay (#66 問題2・4)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(1000);
      // ⏸/▶ボタンはtitle属性でしか文言を持たない(SVGアイコンのみ)ため、
      // isVisible()（可視のテキストノード検索）ではなくDOM属性で直接判定する。
      const initiallyPlaying = await page.evaluate(
        () => !!document.querySelector('button[title="一時停止"]'),
      );
      await page.keyboard.press('Space');
      await page.waitForTimeout(200);
      const nowPaused = await page.evaluate(() => !!document.querySelector('button[title="再生"]'));
      await page.keyboard.press('Space');
      await page.waitForTimeout(200);
      const backToPlaying = await page.evaluate(
        () => !!document.querySelector('button[title="一時停止"]'),
      );
      const pass = initiallyPlaying && nowPaused && backToPlaying;
      return {
        pass,
        detail: `initiallyPlaying=${initiallyPlaying} nowPaused=${nowPaused} backToPlaying=${backToPlaying}`,
      };
    },
  },
  {
    name: 'F toggles fullscreen via setFullscreen/setDecorations IPC calls (#66 問題4)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      const before = await countCalls(page, 'plugin:window|set_fullscreen');
      await page.keyboard.press('f');
      await page.waitForTimeout(300);
      const after = await countCalls(page, 'plugin:window|set_fullscreen');
      const decorationCalls = await countCalls(page, 'plugin:window|set_decorations');
      const pass = after === before + 1 && decorationCalls >= 1;
      return {
        pass,
        detail: `set_fullscreen before=${before} after=${after} set_decorations=${decorationCalls}`,
      };
    },
  },
  {
    // #66レビューmust1: App.tsxのkeydown effectがdeps不足で、古いisFullscreenを
    // 閉じ込めるstale closureになっており、Fキーが1回しか正しく切り替わらな
    // かった（2回目以降が無反応/巻き戻る）。handlersRef経由に直したことで、
    // Fを3回押すたびに前回と逆の値へ交互に切り替わり続けることを確認する
    // （App.tsxはisFullscreen初期値=trueで起動するため、実際の並びは
    // false→true→falseになる。「1回目の値で固定されず、毎回反転すること」を
    // 検証するのが主眼で、初期値そのものはこのテストの対象外）。
    name: 'F pressed three times alternates fullscreen each press, not stuck after the first press (#66レビューmust1)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      const values = [];
      for (let i = 0; i < 3; i++) {
        const before = await countCalls(page, 'plugin:window|set_fullscreen');
        await page.keyboard.press('f');
        const deadline = Date.now() + 3000;
        let after = before;
        while (Date.now() < deadline) {
          after = await countCalls(page, 'plugin:window|set_fullscreen');
          if (after > before) break;
          await page.waitForTimeout(50);
        }
        const lastArgsJson = await page.evaluate(() => {
          const calls = window.__e2eLog.filter((l) => l[1] === 'plugin:window|set_fullscreen');
          return calls.length > 0 ? calls[calls.length - 1][2] : null;
        });
        values.push(lastArgsJson ? JSON.parse(lastArgsJson).value : null);
        await page.waitForTimeout(200);
      }
      const alternates =
        values.length === 3 &&
        values.every((v) => typeof v === 'boolean') &&
        values[0] !== values[1] &&
        values[1] !== values[2] &&
        values[0] === values[2];
      return { pass: alternates, detail: `values=${JSON.stringify(values)}` };
    },
  },
  {
    // #66レビューmust2(a)→2巡目must1（案a）: 当初はChromium(WebView2)実機で、
    // マウスクリック後にボタンへ残るフォーカスがidle判定を妨げ、idleになっても
    // 操作バーが消えない不具合があった。個々のキーを見る対症療法
    // （focusVisibleAtFocusTimeRef）では別のキーで同じ穴が再現するため、
    // 根本対策として操作バーのコンテナに`onMouseDown`でpreventDefaultし、
    // マウスクリックがそもそもボタンへフォーカスを与えないようにした（実際に
    // フォーカスが残らないので、以降どんなキーが押されても:focus-visible化の
    // 心配が無い）。マウスで「次へ」ボタンをクリックした直後、実際に
    // どの要素にもフォーカスが移っていない（document.activeElement===body）
    // ことと、バーの外へマウスを離してidleになれば操作バーが実際に消える
    // （computed opacity===0）ことを確認する。
    name: 'clicking Next does not steal focus, and idle fade still hides the bar afterward (#66レビューmust2(a)→2巡目must1)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await wakeFromIdle(page);
      await realMouseClickByTitle(page, '次へ (→)');
      const focusRightAfterClick = await page.evaluate(
        () => document.activeElement === document.body,
      );
      await page.waitForTimeout(100);
      // バーの外（画面左上）へマウスを離す。mouseleaveでisHoveringがfalseに
      // 戻り、idleタイマーが再開する。
      await page.mouse.move(20, 20);
      await page.waitForTimeout(3600);
      const opacity = await getOverlayBarWrapperOpacity(page);
      const pass = focusRightAfterClick && opacity === 0;
      return { pass, detail: `focusRightAfterClick=${focusRightAfterClick} opacity=${opacity}` };
    },
  },
  {
    // #66レビューmust2(b): 旧実装は、マウスで「次へ」ボタンをクリックして
    // フォーカスが残ったまま次にSpaceを押すと、ブラウザネイティブの
    // 「フォーカス中のbuttonはSpaceで再クリックされる」挙動が働いてしまい、
    // アプリの一時停止/再生ではなく「次へ」が意図せず再発火していた。マウス
    // クリック後のSpaceは、そのボタンを再発火せずアプリの一時停止として
    // 扱われることを確認する。
    name: 'Space after a mouse click on the Next button pauses the app instead of re-triggering Next (#66レビューmust2(b))',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await wakeFromIdle(page);
      await realMouseClickByTitle(page, '次へ (→)');
      await page.waitForTimeout(150);
      const nextsBefore = await countCalls(page, 'get_next_image');
      await page.keyboard.press('Space');
      await page.waitForTimeout(200);
      const nextsAfter = await countCalls(page, 'get_next_image');
      const pausedNow = await page.evaluate(() => !!document.querySelector('button[title="再生"]'));
      const pass = nextsAfter === nextsBefore && pausedNow;
      return {
        pass,
        detail: `nextsBefore=${nextsBefore} nextsAfter=${nextsAfter} pausedNow=${pausedNow}`,
      };
    },
  },
  {
    // #66レビュー2巡目must1（案a）: 個々のキー（Space等）だけを特別扱いする
    // 対症療法では、別のキー（矢印キー等）で同じ「マウスクリック後にキーを
    // 押すと:focus-visibleが反転してidleでもバーが消えない」問題が再現する。
    // 根本対策（操作バー・右上ピルへのonMouseDownでのpreventDefault、マウス
    // クリックそのものでフォーカスを与えない）を入れたことで、クリック後に
    // 何のキーを押しても（ここではSpace）idleへ入れば必ずバーが消えることを
    // 確認する。
    name: '次へクリック→Space→4秒待つとidleへ入りバーが消える (#66レビュー2巡目must1)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await wakeFromIdle(page);
      await realMouseClickByTitle(page, '次へ (→)');
      await page.keyboard.press('Space');
      // クリック直後はマウスカーソルがバー上に残っており、バーの
      // onMouseEnterでisHoveringがtrueのままだとidleタイマー自体が止まって
      // 一生idleにならない（これはアプリの意図した挙動＝ホバー中は操作バーを
      // 隠さない、であってmust1のバグではない）。この検証の主眼はあくまで
      // 「クリック後に何かキーを押しても、後でidleに入れば正しくバーが消える
      // か」なので、実際のユーザー操作同様にマウスをバーの外へ離してから待つ。
      await page.mouse.move(20, 20);
      await page.waitForTimeout(4000);
      const opacity = await getOverlayBarWrapperOpacity(page);
      const focusState = await page.evaluate(() => {
        const el = document.activeElement;
        return { isBody: el === document.body, tag: el ? el.tagName : null };
      });
      const pass = opacity === 0 && focusState.isBody;
      return { pass, detail: `opacity=${opacity} focusState=${JSON.stringify(focusState)}` };
    },
  },
  {
    // #66レビュー2巡目must1（案a）: 上と同じ検証をSpace以外のキー（矢印キー）
    // でも行う。個別のキー対応ではなく「マウスクリックでフォーカスを与えない」
    // という根本対策になっていることを、Space専用ではない別のキーで確認する
    // ことが目的。
    name: '次へクリック→→キー→4秒待つとidleへ入りバーが消える (#66レビュー2巡目must1)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await wakeFromIdle(page);
      await realMouseClickByTitle(page, '次へ (→)');
      await page.keyboard.press('ArrowRight');
      // 上のSpaceシナリオと同じ理由でマウスをバーの外へ離してから待つ
      // （ホバー中はidleタイマーが止まる仕様自体は意図した挙動）。
      await page.mouse.move(20, 20);
      await page.waitForTimeout(4000);
      const opacity = await getOverlayBarWrapperOpacity(page);
      const focusState = await page.evaluate(() => {
        const el = document.activeElement;
        return { isBody: el === document.body, tag: el ? el.tagName : null };
      });
      const pass = opacity === 0 && focusState.isBody;
      return { pass, detail: `opacity=${opacity} focusState=${JSON.stringify(focusState)}` };
    },
  },
  {
    // #66レビューmust2(c): 歯車をマウスでクリックして設定を開き、Escapeで
    // 閉じると、旧実装は同じ歯車ボタンへフォーカスを復帰させていた。その状態で
    // Spaceを押すと、ネイティブなbuttonのSpaceクリック相当の挙動で設定が
    // 再度開いてしまっていた。マウス操作で開いた場合はフォーカスを復帰しない
    // （blurする）ことで、Escape後のSpaceが設定を再オープンしないことを
    // 確認する。
    name: 'gear (mouse click) → Escape → Space does not reopen Settings (#66レビューmust2(c))',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await wakeFromIdle(page);
      // #66視覚刷新: ようこそ画面の中央CTAボタン（「フォルダを選択」/「設定を
      // 開く」）も統一感のため同じ歯車アイコン(SettingsIcon)を内包しており、
      // `svg.lucide-settings`だけでは右上の歯車ボタンと曖昧になる
      // （strict modeで2要素ヒット）。右上の歯車ボタンだけが持つ
      // `title="設定"`で一意に選ぶ。
      await page.click('button[title="設定"]');
      await page.waitForTimeout(300);
      const openedAfterClick = await page.evaluate(
        () => !!document.querySelector('[role="dialog"]'),
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const closedAfterEscape = await page.evaluate(
        () => !document.querySelector('[role="dialog"]'),
      );
      await page.keyboard.press('Space');
      await page.waitForTimeout(300);
      const stillClosedAfterSpace = await page.evaluate(
        () => !document.querySelector('[role="dialog"]'),
      );
      const pass = openedAfterClick && closedAfterEscape && stillClosedAfterSpace;
      return {
        pass,
        detail: `openedAfterClick=${openedAfterClick} closedAfterEscape=${closedAfterEscape} stillClosedAfterSpace=${stillClosedAfterSpace}`,
      };
    },
  },
  {
    // #66レビュー3巡目must: 「…」メニューの背景幕(`fixed inset-0`)が、祖先の
    // 操作バー（transform）とその中のガラス調バー本体（backdrop-blur-md）に
    // よってCSSの含有ブロックがバー自身の矩形に限定され、`inset-0`が画面全体
    // でなくバーの小さな矩形にしかならなかった（1巡目の視覚刷新でバーに
    // transformを持たせて以来の回帰）。写真をクリックしても閉じず、`createPortal`
    // で`document.body`直下に出して解消した。メニューを開いた状態で写真
    // （バー・ピルの外）をクリックすると、メニューが閉じ、かつ「次へ」等の
    // アプリの他の操作は誤って発火しないことを確認する。
    name: '「…」メニューを開いて写真をクリックすると閉じ、次へ等は発火しない (#66レビュー3巡目must)',
    hash: 'slides',
    async run(page) {
      // このメニュー項目は<svg>アイコンとテキストが兄弟のため、isVisible()の
      // 「葉ノードのみ」限定チェックには乗らない（項目自体はbuttonの子に
      // アイコン+テキストの2ノードを持つ）。ボタンのtextContentで直接判定する。
      const menuItemVisible = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('button')].some((b) =>
            b.textContent.includes('ファイルマネージャーで開く'),
          ),
        );
      await page.waitForTimeout(500);
      await wakeFromIdle(page);
      await realMouseClickByTitle(page, 'メニュー');
      await page.waitForTimeout(200);
      const openedAfterClick = await menuItemVisible();
      const nextsBefore = await countCalls(page, 'get_next_image');
      // 写真（バー・ピルの外、画面中央付近）をクリックする。
      await page.mouse.click(640, 200);
      await page.waitForTimeout(200);
      const closedAfterPhotoClick = !(await menuItemVisible());
      const nextsAfter = await countCalls(page, 'get_next_image');
      const pass = openedAfterClick && closedAfterPhotoClick && nextsAfter === nextsBefore;
      return {
        pass,
        detail: `openedAfterClick=${openedAfterClick} closedAfterPhotoClick=${closedAfterPhotoClick} nextsBefore=${nextsBefore} nextsAfter=${nextsAfter}`,
      };
    },
  },
  {
    // #66レビュー3巡目should: マウスで開いた場合、rAF経由で遅延実行される
    // `.focus()`呼び出しは、実ブラウザでは直前のマウス操作から時間的に切り離
    // されているため`:focus-visible`と判定されうる（対象がパネル自身でも
    // 閉じるボタンでも同様）。そのためこのテストでは「`:focus-visible`が
    // falseになる」ことではなく、パネル自身にはCSSで`outline-none`を付けて
    // あるため実際に可視のリングが出ないこと（CLAUDE.md絶対ルール1: 可視判定は
    // 実ブラウザのcomputed styleで行う）と、閉じるボタン自身にはフォーカスが
    // 全く移っていないこと（＝そちらにリングが出ようがない）を確認する。
    name: '設定をマウスクリックで開くと閉じるボタンにフォーカスリングが出ない (#66レビュー3巡目should)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await wakeFromIdle(page);
      await page.click('button[title="設定"]');
      await page.waitForTimeout(300);
      const focusState = await page.evaluate(() => {
        const el = document.activeElement;
        const dialog = document.querySelector('[role="dialog"]');
        const style = el ? getComputedStyle(el) : null;
        return {
          isDialog: !!dialog && el === dialog,
          isCloseButton: !!el && el.tagName === 'BUTTON' && el.title === '閉じる',
          // Tailwindの`outline-none`（`!outline-none`も同様）は`outline-style:
          // none`にはせず、`outline: 2px solid transparent`にする（Windows
          // High Contrast等のためoutline自体は残し、色を透明にして見た目だけ
          // 消す設計）。よって可視判定はstyle/widthでなくcolorの透明度で行う。
          outlineColor: style ? style.outlineColor : null,
        };
      });
      const isTransparentOutline =
        focusState.outlineColor === 'rgba(0, 0, 0, 0)' || focusState.outlineColor === 'transparent';
      const pass = focusState.isDialog && !focusState.isCloseButton && isTransparentOutline;
      return { pass, detail: JSON.stringify(focusState) };
    },
  },
  {
    // 上のshouldケースと対称に、キーボード操作（Tab+Enter）で開いた場合は
    // 従来通り閉じるボタンへフォーカスし、正しく:focus-visibleがtrueになる
    // （＝リングが出る）ことも確認する。回帰でこちらを壊していないことの
    // 確認が目的。
    name: '設定をキーボード操作(Tab+Enter)で開くと閉じるボタンに正しくフォーカスリングが出る (#66レビュー3巡目should)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      let reached = false;
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const isSettingsFocused = await page.evaluate(
          () => document.activeElement?.title === '設定',
        );
        if (isSettingsFocused) {
          reached = true;
          break;
        }
      }
      if (!reached) return { pass: false, detail: 'Tabで設定ボタンに到達できなかった' };
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const focusState = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          isCloseButton: !!el && el.tagName === 'BUTTON' && el.title === '閉じる',
          focusVisible: el ? el.matches(':focus-visible') : null,
        };
      });
      const pass = focusState.isCloseButton && focusState.focusVisible === true;
      return { pass, detail: JSON.stringify(focusState) };
    },
  },
  {
    // #66レビュー3巡目nit: mousedownでのpreventDefaultにより、クリックされた
    // ボタン自身は新しくフォーカスを取らない。だが、既にTabキーボード操作で
    // 別のボタンへ残っていたフォーカスは、それだけでは誰にもblurされず
    // 残り続けてしまい、idleになってもhas-[:focus-visible]が真のままバーが
    // 消えなくなる。同じバー内の別ボタンをマウスで押した時点で、その残留
    // フォーカスをblurすることで、idleで正しくバーが消えることを確認する。
    name: 'Tabでフォーカス中のボタンがある状態で別ボタンをマウスで押すと、残留フォーカスがblurされidleでバーが消える (#66レビュー3巡目nit)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await wakeFromIdle(page);
      let reached = false;
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        const isPauseFocused = await page.evaluate(
          () => document.activeElement?.title === '一時停止',
        );
        if (isPauseFocused) {
          reached = true;
          break;
        }
      }
      if (!reached) return { pass: false, detail: 'Tabで一時停止ボタンに到達できなかった' };
      await realMouseClickByTitle(page, '次へ (→)');
      await page.mouse.move(20, 20);
      await page.waitForTimeout(3600);
      const opacity = await getOverlayBarWrapperOpacity(page);
      return { pass: opacity === 0, detail: `opacity=${opacity}` };
    },
  },
  {
    // #66 問題4: `?`でショートカット一覧を開閉できる。Escapeで閉じる時はアプリを
    // 終了しない。
    name: '? opens the shortcuts overlay; Escape closes it without exiting (#66 問題4)',
    hash: 'slides',
    async run(page) {
      await page.waitForTimeout(500);
      await page.keyboard.press('?');
      await page.waitForTimeout(300);
      const shownAfterOpen = await isVisible(page, 'キーボードショートカット');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const shownAfterClose = await isVisible(page, 'キーボードショートカット');
      const exitCalls = await countCalls(page, 'exit_app');
      const pass = shownAfterOpen && !shownAfterClose && exitCalls === 0;
      return {
        pass,
        detail: `shownAfterOpen=${shownAfterOpen} shownAfterClose=${shownAfterClose} exitCalls=${exitCalls}`,
      };
    },
  },
  {
    // #66 問題3・10: idle（3秒間マウス非操作）でカーソルと右上の常設ボタン列の
    // 両方が消え、マウスを動かすと両方復帰することを実ブラウザのcomputed style
    // で確認する（CLAUDE.md絶対ルール1）。
    name: 'idle hides the cursor and the top-right button row; moving the mouse restores both (#66 問題3・10)',
    hash: 'slides',
    async run(page) {
      // 固定 sleep + 一度きりの読み取りだと、負荷で opacity のトランジション途中（例 0.998）を
      // 読んで揺れる（#124）。状態が確定する（cursor / opacity が目標値に達する）まで条件待ちする。
      const readState = () =>
        page.evaluate(() => {
          const root = document.querySelector('.w-screen.h-screen.bg-black');
          const btnRow = [...document.querySelectorAll('div')].find(
            (el) => el.querySelector('svg.lucide-settings') && el.className.includes('fixed'),
          );
          return {
            cursor: root ? getComputedStyle(root).cursor : null,
            buttonRowOpacity: btnRow ? Number(getComputedStyle(btnRow).opacity) : null,
          };
        });
      const settle = async (isTarget) => {
        const deadline = Date.now() + 8000;
        let st = await readState();
        while (!isTarget(st) && Date.now() < deadline) {
          await page.waitForTimeout(50);
          st = await readState();
        }
        return st;
      };
      // マウスは一度も動かさない（idleは初期状態でtrueのまま）
      const idleState = await settle((st) => st.cursor === 'none' && st.buttonRowOpacity === 0);
      await page.mouse.move(300, 300);
      await page.mouse.move(320, 320);
      const activeState = await settle((st) => st.cursor !== 'none' && st.buttonRowOpacity === 1);
      const pass =
        idleState.cursor === 'none' &&
        idleState.buttonRowOpacity === 0 &&
        activeState.cursor !== 'none' &&
        activeState.buttonRowOpacity === 1;
      return {
        pass,
        detail: `idle=${JSON.stringify(idleState)} active=${JSON.stringify(activeState)}`,
      };
    },
  },
  {
    // #66 問題9(a11y): 設定モーダルにrole=dialog/aria-modal、タブにrole=tab/
    // aria-selectedが付いていることを実ブラウザのDOMで確認する。
    name: 'Settings modal exposes role=dialog/aria-modal and tabs expose role=tab/aria-selected (#66 a11y)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await openSettingsModal(page);
      const result = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
        return {
          hasDialog: !!dialog,
          ariaModal: dialog ? dialog.getAttribute('aria-modal') : null,
          tabCount: tabs.length,
          selectedCount: selected.length,
        };
      });
      const pass =
        result.hasDialog &&
        result.ariaModal === 'true' &&
        result.tabCount === 7 &&
        result.selectedCount === 1;
      return { pass, detail: JSON.stringify(result) };
    },
  },
  {
    // #66 問題9(a11y): モーダル内でTabを繰り返し押しても、フォーカスがモーダルの
    // 外（背後のオーバーレイ等）へ漏れない（フォーカストラップ）。
    name: 'Settings modal traps Tab focus inside the dialog (#66 a11y)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await openSettingsModal(page);
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
      }
      const stillInside = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return !!dialog && dialog.contains(document.activeElement);
      });
      return { pass: stillInside, detail: `stillInside=${stillInside}` };
    },
  },
  {
    // #67: 統計タブ。集計済みヒストグラムが実ブラウザで実際に描画される
    // （canvasに幅・高さがあり、平均ラベルを描く余白が確保されている）・均等バッジ・
    // 棒へのホバーでツールチップが出る（computed styleで可視判定）・表ビューの
    // 行が出る・720px幅でも横にはみ出さない、を確認する。
    name: 'Stats tab draws the histogram, even-badge, hover tooltip and table view (#67)',
    hash: 'stats',
    async run(page) {
      await page.waitForTimeout(600);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.overflow-x-auto > button')];
        const statsTab = tabs.find((b) => b.textContent.includes('統計'));
        if (!statsTab) throw new Error('統計タブが見つからない');
        statsTab.click();
      });
      await page.waitForSelector('.u-over', { timeout: 3000 });
      const chart = await page.evaluate(() => {
        const canvas = document.querySelector('.uplot canvas');
        const rect = canvas ? canvas.getBoundingClientRect() : null;
        const badge = document.querySelector('[data-testid="fairness-badge"]');
        return {
          canvasW: rect ? Math.round(rect.width) : 0,
          canvasH: rect ? Math.round(rect.height) : 0,
          badge: badge ? badge.textContent : null,
          legend: !!document.querySelector('.u-legend'),
        };
      });
      const over = await page.locator('.u-over').boundingBox();
      // 棒2本（2回と3回）のうち右側の棒（3回）の中心付近へマウスを載せる。
      await page.mouse.move(over.x + over.width * 0.58, over.y + over.height * 0.7);
      await page.waitForTimeout(150);
      const tip = await page.evaluate(() => {
        const el = document.querySelector('.u-over .pointer-events-none.z-10');
        return el
          ? { display: getComputedStyle(el).display, text: el.textContent }
          : { display: 'missing', text: '' };
      });
      await page.mouse.move(over.x - 40, over.y - 40);
      await page.waitForTimeout(150);
      const tipAfter = await page.evaluate(() => {
        const el = document.querySelector('.u-over .pointer-events-none.z-10');
        return el ? getComputedStyle(el).display : 'missing';
      });
      await page.click('summary');
      const rows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
      const pass =
        chart.canvasW > 300 &&
        chart.canvasH >= 240 &&
        chart.badge !== null &&
        chart.badge.includes('均等') &&
        !chart.legend &&
        tip.display === 'block' &&
        tip.text.includes('回表示') &&
        tipAfter === 'none' &&
        rows === 2;
      return { pass, detail: JSON.stringify({ chart, tip, tipAfter, rows }) };
    },
  },
  {
    // #67: 偏りがある分布ではバッジが「均等」でなく差を示し、720px幅でも
    // 設定モーダルが横スクロールを起こさない（チャートがモーダル幅に追従する）。
    name: 'Stats tab flags a wide spread and fits at 720px width (#67)',
    hash: 'statsspread',
    viewport: { width: 720, height: 800 },
    async run(page) {
      await page.waitForTimeout(600);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.overflow-x-auto > button')];
        const statsTab = tabs.find((b) => b.textContent.includes('統計'));
        if (!statsTab) throw new Error('統計タブが見つからない');
        statsTab.click();
      });
      await page.waitForSelector('.u-over', { timeout: 3000 });
      const m = await page.evaluate(() => {
        const badge = document.querySelector('[data-testid="fairness-badge"]');
        const canvas = document.querySelector('.uplot canvas');
        const dialog = document.querySelector('[role="dialog"]');
        const panel = canvas ? canvas.closest('.overflow-y-auto') : null;
        return {
          badge: badge ? badge.textContent : null,
          canvasRight: canvas ? Math.round(canvas.getBoundingClientRect().right) : 0,
          dialogRight: dialog ? Math.round(dialog.getBoundingClientRect().right) : 0,
          overflowX: panel ? panel.scrollWidth > panel.clientWidth : null,
        };
      });
      const pass =
        m.badge !== null &&
        m.badge.includes('差 9回') &&
        m.canvasRight > 0 &&
        m.canvasRight <= m.dialogRight &&
        m.overflowX !== true;
      return { pass, detail: JSON.stringify(m) };
    },
  },
  {
    // #67: 一度も表示していない（全件0回）プレイリストでも統計タブが壊れず、
    // 0回の棒1本・均等バッジ・「0 / 総数」・表1行になる（ビンが1つでも軸が潰れない）。
    name: 'Stats tab for a never-shown playlist shows a single 0-count bar, even badge and 0/total (#67)',
    hash: 'statszero',
    async run(page) {
      await page.waitForTimeout(600);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.overflow-x-auto > button')];
        const statsTab = tabs.find((b) => b.textContent.includes('統計'));
        if (!statsTab) throw new Error('統計タブが見つからない');
        statsTab.click();
      });
      await page.waitForSelector('.u-over', { timeout: 3000 });
      await page.click('summary');
      const m = await page.evaluate(() => {
        const canvas = document.querySelector('.uplot canvas');
        const rect = canvas ? canvas.getBoundingClientRect() : null;
        const badge = document.querySelector('[data-testid="fairness-badge"]');
        const rows = [...document.querySelectorAll('tbody tr')];
        const noData = [...document.querySelectorAll('div')].some((d) =>
          d.textContent.includes('データがありません'),
        );
        return {
          canvasW: rect ? Math.round(rect.width) : 0,
          badge: badge ? badge.textContent : null,
          rows: rows.map((r) => r.textContent),
          noData,
          viewed: document.body.textContent.includes('0 / 500'),
        };
      });
      const pass =
        m.canvasW > 300 &&
        m.badge !== null &&
        m.badge.includes('均等') &&
        m.rows.length === 1 &&
        m.rows[0] === '0500100.0%' &&
        !m.noData &&
        m.viewed;
      return { pass, detail: JSON.stringify(m) };
    },
  },
  {
    // #67: ピック済みタブは静止画と動画が混在する。静止画はサムネイル <img>（縮小済み。
    // モックは 160x120 の代役で naturalWidth<=256 かつ実際にデコードされる）、動画は
    // フィルムアイコン+ファイル名（computed style で実際に見えている）を出す。
    name: 'Pick tab shows an image thumbnail and, for a video, the film icon with its file name (#67)',
    hash: 'thumbs',
    async run(page) {
      await page.waitForTimeout(600);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.overflow-x-auto > button')];
        const tab = tabs.find((b) => b.textContent.includes('ピック'));
        if (!tab) throw new Error('ピックタブが見つからない');
        tab.click();
      });
      await page.waitForSelector('svg.lucide-film', { timeout: 3000 });
      await page.waitForFunction(
        () => {
          const img = document.querySelector('[role="dialog"] img');
          return !!img && img.complete && img.naturalWidth > 0;
        },
        null,
        { timeout: 3000 },
      );
      const m = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const img = dialog.querySelector('img');
        const film = dialog.querySelector('svg.lucide-film');
        const label = [...dialog.querySelectorAll('span')].find((s) =>
          s.textContent.includes('v.webm'),
        );
        const visible = (el) => {
          if (!el) return false;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
        return {
          imgs: dialog.querySelectorAll('img').length,
          naturalWidth: img.naturalWidth,
          filmVisible: visible(film),
          labelVisible: visible(label),
          labelText: label ? label.textContent : null,
        };
      });
      const pass =
        m.imgs === 1 &&
        m.naturalWidth > 0 &&
        m.naturalWidth <= 256 &&
        m.filmVisible &&
        m.labelVisible &&
        m.labelText === 'v.webm';
      return { pass, detail: JSON.stringify(m) };
    },
  },
  {
    // #67: 履歴タブでも同様に、静止画=サムネイル・動画=フィルム+ファイル名・表示回数バッジ。
    // 2 件（静止画・動画）とも常に可視なので、get_thumbnail は 1 件につき 1 回＝計 2 回呼ばれる。
    // （画面外を要求しない遅延取得の検証は Thumbnail のユニットテスト側で行う）
    name: 'History tab shows a downscaled thumbnail, a video label and counts, calling get_thumbnail once per listed item (2 calls) (#67)',
    hash: 'thumbs',
    async run(page) {
      await page.waitForTimeout(600);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.overflow-x-auto > button')];
        const tab = tabs.find((b) => b.textContent.includes('履歴'));
        if (!tab) throw new Error('履歴タブが見つからない');
        tab.click();
      });
      await page.waitForSelector('svg.lucide-film', { timeout: 3000 });
      await page.waitForFunction(
        () => {
          const img = document.querySelector('[role="dialog"] img');
          return !!img && img.complete && img.naturalWidth > 0;
        },
        null,
        { timeout: 3000 },
      );
      const m = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const img = dialog.querySelector('img');
        const label = [...dialog.querySelectorAll('span')].find((s) =>
          s.textContent.includes('v.webm'),
        );
        const labelVisible =
          !!label &&
          getComputedStyle(label).display !== 'none' &&
          label.getBoundingClientRect().width > 0;
        return {
          naturalWidth: img.naturalWidth,
          labelVisible,
          counts: dialog.textContent.includes('\u00d73') && dialog.textContent.includes('\u00d71'),
          thumbCalls: window.__e2eLog.filter((e) => e[1] === 'get_thumbnail').length,
        };
      });
      const pass =
        m.naturalWidth > 0 &&
        m.naturalWidth <= 256 &&
        m.labelVisible &&
        m.counts &&
        m.thumbCalls === 2;
      return { pass, detail: JSON.stringify(m) };
    },
  },
  {
    // #66 問題9(#61レビュー由来): 除外ルールの解除ボタンがhoverのみで表示され、
    // キーボード/タッチで見えなかった。既定でも薄く(opacity>0)見えることを確認する。
    name: 'Exclude rule remove button is visible (opacity>0) without hovering (#66 問題9)',
    hash: 'welcome',
    async run(page) {
      await page.waitForTimeout(400);
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tab"], .overflow-x-auto > button')];
        const excludeTab = tabs.find((b) => b.textContent.includes('除外ルール'));
        if (!excludeTab) throw new Error('除外ルールタブが見つからない');
        excludeTab.click();
      });
      await page.waitForTimeout(200);
      await page.fill('input[placeholder*="パターン"]', '*.e2etest');
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          b.textContent.includes('追加'),
        );
        if (!btn) throw new Error('追加ボタンが見つからない');
        btn.click();
      });
      await page.waitForTimeout(300);
      const opacity = await page.evaluate(() => {
        const row = [...document.querySelectorAll('span')].find((s) =>
          s.textContent.includes('*.e2etest'),
        );
        const removeBtn = row ? row.closest('div').parentElement.querySelector('button') : null;
        return removeBtn ? Number(getComputedStyle(removeBtn).opacity) : null;
      });
      const pass = opacity !== null && opacity > 0;
      return { pass, detail: `opacity=${opacity}` };
    },
  },
  {
    // #78: 除外の取り消し。除外直後に「取り消す」が出て、マウスを動かさず idle に
    // なっても（操作バーがフェードアウトしても）押せる状態のまま残り、押すと
    // undo_exclude が除外の結果（removeRule/restorePaths）つきで呼ばれる。
    name: 'exclude shows an undo toast that survives idle and calls undo_exclude (#78)',
    hash: 'undo',
    async run(page) {
      await page.waitForTimeout(800);
      await wakeFromIdle(page);
      await page.click('button[title="メニュー"]');
      await page.click('text=除外');
      await page.click('text=ファイルを除外');
      await page.waitForTimeout(300);
      const shown = await isVisible(page, '取り消す');
      // マウスを動かさず idle（3秒）を越えても残る。
      await page.waitForTimeout(3600);
      const barOpacity = await getOverlayBarWrapperOpacity(page);
      const stillShown = await isVisible(page, '取り消す');
      await page.click('button:has-text("取り消す")');
      await page.waitForTimeout(300);
      const undoCalls = await page.evaluate(() =>
        window.__e2eLog.filter((l) => l[1] === 'undo_exclude').map((l) => l[2]),
      );
      const doneShown = await isVisible(page, '除外を取り消しました');
      const buttonGone = !(await isVisible(page, '取り消す'));
      const pass =
        shown &&
        stillShown &&
        barOpacity === 0 &&
        undoCalls.length === 1 &&
        undoCalls[0].includes('"removeRule":true') &&
        undoCalls[0].includes('"restorePaths":["/p/') &&
        doneShown &&
        buttonGone;
      return {
        pass,
        detail: `shown=${shown} stillShown(idle)=${stillShown} barOpacity=${barOpacity} undoCalls=${JSON.stringify(undoCalls)} doneShown=${doneShown} buttonGone=${buttonGone}`,
      };
    },
  },
  {
    // #111: 除外ルールの追加後に再スキャン案内とボタンが出て、押すと rescan_last_directory が
    // 1回だけ呼ばれる。再スキャン中に別タブへ往復しても、設定を閉じて開き直しても、ボタンは無効のまま・二重実行されず、
    // 完了メッセージは戻ったときに見られる。
    name: 'exclude rule change shows a rescan notice; the button rescans once even across tab round trips (#111)',
    hash: 'exrescan',
    async run(page) {
      await page.waitForTimeout(1500); // 起動時の背景スキャン（rescan 1回目）の完了を待つ
      await openSettingsModal(page);
      await page.click('#tab-exclude');
      await page.waitForTimeout(300);
      const rescanCalls = () => countCalls(page, 'rescan_last_directory');
      const baseline = await rescanCalls();
      const noticeBefore = await isVisible(page, '今すぐ再スキャン');
      await page.fill('input[type=text]', '**/thumbs/');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const noticeShown = await isVisible(page, '反映するには再スキャンが必要です');
      const afterAdd = await rescanCalls(); // 自動では再スキャンしない
      // 再スキャンの完了はテストが明示的に解放するまで保留される（init.js、固定時間に依存しない）。
      await page.evaluate(() => {
        window.__rescanGateArmed = true;
      });
      await page.click('button:has-text("今すぐ再スキャン")');
      await page.waitForSelector('button:has-text("再スキャン中")');
      // 再スキャン中にタブを往復する
      await page.click('#tab-history');
      await page.click('#tab-exclude');
      await page.waitForTimeout(100);
      const busy = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          x.textContent.includes('再スキャン中'),
        );
        return b ? { disabled: b.disabled, display: getComputedStyle(b).display } : null;
      });
      if (busy && !busy.disabled) await page.click('button:has-text("再スキャン中")');
      // 再スキャン中に設定を閉じて開き直す（Settings は再マウントされるが状態は App が保持）
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await openSettingsModal(page);
      await page.click('#tab-exclude');
      await page.waitForTimeout(100);
      const busyReopened = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          x.textContent.includes('再スキャン中'),
        );
        return b ? b.disabled : null;
      });
      // 開き直し後も、追加したルールが一覧に残り（モックの状態保持）、案内も残る
      const ruleListedAfterReopen = await page.evaluate(() =>
        (document.querySelector('[role=tabpanel]')?.innerText ?? '').includes('**/thumbs/'),
      );
      const noticeAfterReopen = await isVisible(page, '反映するには再スキャンが必要です');
      // ゲートの invoke がモックに到達する前に呼ぶと未定義になるため、関数が現れるまで待つ。
      await page.waitForFunction(() => typeof window.__rescanRelease === 'function', null, {
        timeout: 5000,
      });
      await page.evaluate(() => window.__rescanRelease());
      await page
        .waitForFunction(() => document.body.innerText.includes('再スキャンしました'), null, {
          timeout: 5000,
        })
        .catch(() => {});
      const doneShown = await isVisible(page, '再スキャンしました');
      const total = await rescanCalls();
      const buttonGone = !(await isVisible(page, '今すぐ再スキャン'));
      const pass =
        !noticeBefore &&
        noticeShown &&
        afterAdd === baseline &&
        busy !== null &&
        busy.disabled === true &&
        busyReopened === true &&
        ruleListedAfterReopen &&
        noticeAfterReopen &&
        total === baseline + 1 &&
        doneShown &&
        buttonGone;
      return {
        pass,
        detail: `baseline=${baseline} afterAdd=${afterAdd} total=${total} noticeBefore=${noticeBefore} noticeShown=${noticeShown} busy=${JSON.stringify(busy)} busyReopened=${busyReopened} ruleListedAfterReopen=${ruleListedAfterReopen} noticeAfterReopen=${noticeAfterReopen} doneShown=${doneShown} buttonGone=${buttonGone}`,
      };
    },
  },
  {
    // #78: ピックの取り消しはコピーしたファイルだけを delete_picked_image で消す。
    // 取り消さずに放置すれば数秒でトーストは消える（確認ダイアログは出ない）。
    name: 'pick undo deletes only the copied file; the toast expires by itself (#78)',
    hash: 'undo',
    async run(page) {
      await page.waitForTimeout(800);
      await wakeFromIdle(page);
      await page.click('button[title="ピック（コピー）"]');
      await page.waitForTimeout(300);
      const shown = await isVisible(page, '取り消す');
      await page.click('button:has-text("取り消す")');
      await page.waitForTimeout(300);
      const deleteCalls = await page.evaluate(() =>
        window.__e2eLog.filter((l) => l[1] === 'delete_picked_image').map((l) => l[2]),
      );
      const doneShown = await isVisible(page, 'ピックを取り消しました');

      // もう一度ピックして放置 → 6秒で消える。
      await page.click('button[title="ピック（コピー）"]');
      await page.waitForTimeout(300);
      const shownAgain = await isVisible(page, '取り消す');
      await page.waitForTimeout(6300);
      const expired = !(await isVisible(page, '取り消す'));
      const deleteCallsAfterExpiry = await page.evaluate(
        () => window.__e2eLog.filter((l) => l[1] === 'delete_picked_image').length,
      );
      const pass =
        shown &&
        deleteCalls.length === 1 &&
        deleteCalls[0].includes('/tmp/sss-picked/a.png') &&
        doneShown &&
        shownAgain &&
        expired &&
        deleteCallsAfterExpiry === 1;
      return {
        pass,
        detail: `shown=${shown} deleteCalls=${JSON.stringify(deleteCalls)} doneShown=${doneShown} shownAgain=${shownAgain} expired=${expired}`,
      };
    },
  },
  {
    // #78: 写真上のマウス操作。クリック=一時停止/再開（連打は1回に畳む）、
    // ホイール=前/次（連続イベントは1回に畳む）。オーバーレイのボタンは写真クリック扱いにならない。
    name: 'photo click toggles pause and wheel navigates, without interfering with the overlay (#78)',
    hash: 'gestures',
    async run(page) {
      await page.waitForTimeout(1000);
      const pausedTitle = (p) => p.locator('button[title="再生"]').count();
      const playingTitle = (p) => p.locator('button[title="一時停止"]').count();

      // 写真上の実クリック → 一時停止
      await page.mouse.move(640, 300);
      await page.mouse.click(640, 300);
      await page.waitForTimeout(150);
      const pausedAfterClick = (await pausedTitle(page)) === 1;
      // 少し空けてもう一度 → 再生に戻る
      await page.waitForTimeout(450);
      await page.mouse.click(640, 300);
      await page.waitForTimeout(150);
      const playingAfterSecond = (await playingTitle(page)) === 1;
      // ダブルクリック（2発目は無視される）→ 1回分だけ切り替わって一時停止
      await page.waitForTimeout(450);
      await page.mouse.dblclick(640, 300);
      await page.waitForTimeout(150);
      const pausedAfterDouble = (await pausedTitle(page)) === 1;
      await page.waitForTimeout(450);
      await page.mouse.click(640, 300); // 再生へ戻す
      await page.waitForTimeout(150);

      // オーバーレイのボタン（次へ）は一時停止状態を変えない。
      await wakeFromIdle(page);
      const beforeOverlayClick = await countCalls(page, 'get_next_image');
      await realMouseClickByTitle(page, '次へ (→)');
      await page.waitForTimeout(200);
      const overlayStillPlaying = (await playingTitle(page)) === 1;
      const nextAfterOverlay = await countCalls(page, 'get_next_image');

      // ホイール: 下=次へ。続けて届くイベントは1回に畳まれる。
      await page.mouse.move(640, 300);
      await page.waitForTimeout(400);
      const nextBefore = await countCalls(page, 'get_next_image');
      // 連続イベントは1回に畳まれる（アプリの畳み込み窓 WHEEL_QUIET_MS=200ms）。
      // (1) 実ホイール 3 発: 負荷でイベントの到達が遅れると窓を超えて 2 回に割れることがある（#124）
      //     ため、ページ内で各イベントの到達時刻（e.timeStamp）を記録し、「到達間隔が窓以上空いた
      //     回数 + 1」を期待ナビゲーション数として判定する（負荷で割れても、割れ方どおりなら正しい）。
      await page.evaluate(() => {
        window.__wheelStamps = [];
        window.addEventListener('wheel', (e) => window.__wheelStamps.push(e.timeStamp), {
          capture: true,
        });
      });
      await page.mouse.wheel(0, 100);
      await page.mouse.wheel(0, 100);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(400);
      const stamps = await page.evaluate(() => window.__wheelStamps.slice());
      const expectedReal = stamps.reduce(
        (n, t, i) => (i > 0 && t - stamps[i - 1] >= 200 ? n + 1 : n),
        1,
      );
      const nextAfterReal = await countCalls(page, 'get_next_image');
      // (2) 同一フレーム内に 3 発をページ内から発火（isTrusted=false）: 到達間隔が 0 なので
      //     負荷に依らず必ず 1 回に畳まれる。
      await page.waitForTimeout(400);
      const nextBeforeSynth = await countCalls(page, 'get_next_image');
      await page.evaluate(() => {
        const target = document.elementFromPoint(640, 300);
        for (let i = 0; i < 3; i++) {
          target.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
          );
        }
      });
      await page.waitForTimeout(300);
      const nextAfter = await countCalls(page, 'get_next_image');
      const realCollapsed = nextAfterReal - nextBefore === expectedReal;

      // 上=前へ（戻れる状態）。一連の操作が落ち着いてから。
      await page.waitForTimeout(400);
      const prevBefore = await countCalls(page, 'get_previous_image');
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(300);
      const prevAfter = await countCalls(page, 'get_previous_image');

      const pass =
        pausedAfterClick &&
        playingAfterSecond &&
        pausedAfterDouble &&
        overlayStillPlaying &&
        nextAfterOverlay - beforeOverlayClick === 1 &&
        realCollapsed &&
        nextAfter - nextBeforeSynth === 1 &&
        prevAfter - prevBefore === 1;
      return {
        pass,
        detail: `pausedAfterClick=${pausedAfterClick} playingAfterSecond=${playingAfterSecond} pausedAfterDouble=${pausedAfterDouble} overlayStillPlaying=${overlayStillPlaying} overlayNext=${nextAfterOverlay - beforeOverlayClick} wheelNextReal=${nextAfterReal - nextBefore}(expected ${expectedReal}) wheelNextSynth=${nextAfter - nextBeforeSynth} wheelPrev=${prevAfter - prevBefore}`,
      };
    },
  },
  {
    name: 'reset-all-data uses an in-app alertdialog; cancel/ESC/backdrop never call the IPC, OK does (ja) (#119)',
    hash: 'statszero',
    async run(page) {
      return confirmResetScenario(page, 'ja', 'info');
    },
  },
  {
    name: 'reset-all-data uses an in-app alertdialog; cancel/ESC/backdrop never call the IPC, OK does (en) (#119)',
    hash: 'statszero',
    locale: 'en-US',
    async run(page) {
      return confirmResetScenario(page, 'en', 'info');
    },
  },
  {
    name: 'display-count reset uses an in-app alertdialog; cancel/ESC/backdrop never call the IPC, OK does (ja) (#119)',
    hash: 'statszero',
    async run(page) {
      return confirmResetScenario(page, 'ja', 'stats');
    },
  },
  {
    name: 'display-count reset uses an in-app alertdialog; cancel/ESC/backdrop never call the IPC, OK does (en) (#119)',
    hash: 'statszero',
    locale: 'en-US',
    async run(page) {
      return confirmResetScenario(page, 'en', 'stats');
    },
  },
  {
    name: 'picked-photo delete uses an in-app alertdialog; cancel/ESC/backdrop never call the IPC, OK does (ja) (#119)',
    hash: 'thumbs',
    async run(page) {
      return confirmResetScenario(page, 'ja', 'pick');
    },
  },
  {
    name: 'picked-photo delete uses an in-app alertdialog; cancel/ESC/backdrop never call the IPC, OK does (en) (#119)',
    hash: 'thumbs',
    locale: 'en-US',
    async run(page) {
      return confirmResetScenario(page, 'en', 'pick');
    },
  },
  {
    // #122: 設定の checkbox / range が appearance: none の自前描画でダークテーマに合う
    // (WebKitGTK では未チェック時にネイティブの白い箱になっていた)。全状態を computed style で検証。
    name: 'settings checkbox/range use the explicit dark styling in every state (ja) (#122)',
    hash: 'slides',
    async run(page) {
      return inputDarkScenario(page, 'ja');
    },
  },
  {
    name: 'settings checkbox/range use the explicit dark styling in every state (en) (#122)',
    hash: 'slides',
    locale: 'en-US',
    async run(page) {
      return inputDarkScenario(page, 'en');
    },
  },
  {
    // #122: 強制カラー(ハイコントラスト)でチェック済みが空の箱にならない。
    name: 'settings checkbox stays distinguishable when checked in forced-colors mode (#122)',
    hash: 'slides',
    async run(page) {
      return inputForcedColorsScenario(page);
    },
  },
  {
    // #110: 「…」メニュー→「除外」サブメニューの3項目が、どの画面サイズでも
    // viewport内に収まり、操作バーと交差しない（以前は top-0 で下へ伸びて
    // 最後の項目が viewport を超え、バーに重なっていた）。
    name: 'exclude submenu stays inside the viewport and clear of the bar (#110)',
    hash: 'slides',
    async run(page) {
      await wakeFromIdle(page);
      // 言語非依存: 「…」ボタンと除外トリガーは aria-haspopup="menu" で拾い、
      // サブメニューは除外トリガーの直後の兄弟要素、親メニューはその祖先で辿る。
      await page.locator('button[aria-haspopup="menu"]').first().click();
      await page.waitForTimeout(300);
      await page.locator('button[aria-haspopup="menu"]').nth(1).click();
      await page.waitForTimeout(400);
      const details = [];
      let pass = true;
      for (const [w, h] of [
        [1920, 1080],
        [1280, 800],
        [800, 600],
        [480, 800],
        [431, 700],
        [430, 700],
        [360, 640],
        [360, 300],
        [320, 568],
      ]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => {
          const rect = (e) => e.getBoundingClientRect();
          const triggers = [...document.querySelectorAll('button[aria-haspopup="menu"]')];
          const dots = triggers[0];
          const trigger = triggers[1];
          const sub = trigger && trigger.nextElementSibling;
          if (!sub || sub.children.length !== 3) return null;
          const rs = [...sub.children].map(rect);
          const parent = rect(trigger.parentElement.parentElement);
          let bar = dots;
          while (bar && getComputedStyle(bar).position !== 'fixed') bar = bar.parentElement;
          const b = rect(bar);
          const hits = (box) =>
            rs.some(
              (r) =>
                r.bottom > box.top &&
                r.top < box.bottom &&
                r.right > box.left &&
                r.left < box.right,
            );
          // 右上のボタン群（ピル）。表示中のものすべてと交差しないこと。
          const pills = [...document.querySelectorAll('div.fixed.top-4.right-4')]
            .map(rect)
            .filter((p) => p.width > 0 && p.height > 0);
          return {
            top: Math.min(...rs.map((r) => r.top)),
            bottom: Math.max(...rs.map((r) => r.bottom)),
            left: Math.min(...rs.map((r) => r.left)),
            right: Math.max(...rs.map((r) => r.right)),
            barTop: b.top,
            parentTop: parent.top,
            parentBottom: parent.bottom,
            parentLeft: parent.left,
            subRight: rect(sub).right,
            scrollable: sub.scrollHeight > sub.clientHeight,
            hitsBar: hits(b),
            hitsPill: pills.some(hits),
            vh: innerHeight,
            vw: innerWidth,
          };
        });
        // 側方展開（親メニューの左）では、右端が親メニュー枠に食い込まない。
        // 積み重ね展開（幅430px以下）では対象外。
        const sideBySide = !!m && m.subRight <= m.parentLeft - 2;
        const stacked = !!m && !sideBySide;
        const ok =
          !!m &&
          m.top >= 0 &&
          m.left >= 0 &&
          m.bottom <= m.vh &&
          m.right <= m.vw &&
          !m.hitsBar &&
          !m.hitsPill &&
          // 縦スクロール不要（border 分の数pxでも溢れさせない）
          !m.scrollable &&
          // 親メニューの縦範囲から大きく外れない（下へ突き抜けない／上へ離れすぎない）
          m.bottom <= m.parentBottom + 4 &&
          m.top >= m.parentTop - 60 &&
          (w <= 430 ? stacked || sideBySide : sideBySide);
        if (!ok) pass = false;
        details.push(
          `${w}x${h}:${ok ? 'ok' : 'NG'}(${m ? `left=${Math.round(m.left)} right=${Math.round(m.right)} subRight=${Math.round(m.subRight)} top=${Math.round(m.top)} bottom=${Math.round(m.bottom)} parent=${Math.round(m.parentTop)}-${Math.round(m.parentBottom)} parentLeft=${Math.round(m.parentLeft)} barTop=${Math.round(m.barTop)} pill=${m.hitsPill} scrollable=${m.scrollable}` : 'items missing'})`,
        );
      }
      return { pass, detail: details.join(' ') };
    },
  },
  {
    // #116: Ctrl+A で画面全体が選択（青ハイライト）されない。body は user-select:none で、
    // 透明な隠しツールチップ等の文言も選択されない。設定モーダル・ショートカット一覧でも同様。
    name: 'Ctrl+A selects nothing outside inputs: body is user-select none (#116)',
    hash: 'slides',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
      await wakeFromIdle(page);
      const sel = () => page.evaluate(() => window.getSelection().toString());
      const bodyStyle = await page.evaluate(() => {
        const s = getComputedStyle(document.body);
        return { us: s.userSelect, wus: s.webkitUserSelect };
      });
      const textLen = await page.evaluate(() => document.body.innerText.length);
      const detail = [`body=${JSON.stringify(bodyStyle)} innerText=${textLen}`];
      let pass = bodyStyle.us === 'none' && textLen > 0;
      const check = async (label) => {
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(100);
        const s = await sel();
        detail.push(`${label}:selection="${s.slice(0, 20)}"`);
        if (s !== '') pass = false;
      };
      await check('slideshow');
      await openSettingsModal(page);
      await check('settings');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Shift+/');
      await page.waitForTimeout(300);
      await check('shortcuts');
      return { pass, detail: detail.join(' ') };
    },
  },
  {
    // #116レビュー: オーバーレイのファイル名は #66 が意図的に選択可能にしていた。body の
    // user-select:none を継承して選択できなくなる回帰を、実ブラウザの computed style と
    // 実際のドラッグ選択で確認する（jsdom は user-select を計算しないので vitest では検出できない）。
    name: 'overlay file name stays selectable (computed user-select text, drag selects it) (#116)',
    hash: 'slides',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
      await wakeFromIdle(page);
      const info = await page.evaluate(() => {
        const bar = document.querySelector('button[aria-haspopup="menu"]').closest('.fixed');
        // #114: ファイル名は前半/後半の2要素に分かれるため、外側の data-overlay=filename を使う。
        const span = bar.querySelector('[data-overlay="filename"]');
        if (!span) return null;
        const r = span.getBoundingClientRect();
        return {
          text: span.textContent.trim(),
          us: getComputedStyle(span).userSelect,
          x0: r.left + 1,
          x1: r.right - 1,
          y: r.top + r.height / 2,
        };
      });
      if (!info) return { pass: false, detail: 'ファイル名の span が見つからない' };
      await page.mouse.move(info.x0, info.y);
      await page.mouse.down();
      await page.mouse.move(info.x1, info.y, { steps: 6 });
      await page.mouse.up();
      const selected = (await page.evaluate(() => window.getSelection().toString())).trim();
      return {
        pass: info.us === 'text' && selected === info.text,
        detail: `userSelect=${info.us} fileName="${info.text}" dragSelected="${selected}"`,
      };
    },
  },
  {
    // #116: 右クリックの既定メニュー（WebView の「再読み込み/検証」等）は入力欄以外で
    // preventDefault される。入力欄（input/textarea）では抑止しない（コピー/貼り付けのため）。
    name: 'contextmenu is default-prevented except inside text inputs (#116)',
    hash: 'slides',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
      await wakeFromIdle(page);
      await page.evaluate(() => {
        window.__ctx = [];
        window.addEventListener('contextmenu', (e) => {
          const t = e.target;
          window.__ctx.push({ tag: t.tagName, prevented: e.defaultPrevented });
        });
      });
      await page.mouse.click(640, 300, { button: 'right' });
      await openSettingsModal(page);
      // 除外ルールタブの追加用テキスト入力で右クリックする。
      const box = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        tabs[2].click();
        return null;
      });
      void box;
      await page.waitForTimeout(400);
      const inputBox = await page.evaluate(() => {
        const el = document.querySelector('[role="dialog"] input[type="text"]:not([readonly])');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (!inputBox) return { pass: false, detail: '入力欄が見つからない' };
      await page.mouse.click(inputBox.x, inputBox.y, { button: 'right' });
      // 設定モーダルのテキスト（入力欄以外）。
      const headBox = await page.evaluate(() => {
        const el = document.querySelector('[role="dialog"] h2');
        const r = el.getBoundingClientRect();
        return { x: r.left + 4, y: r.top + r.height / 2 };
      });
      await page.mouse.click(headBox.x, headBox.y, { button: 'right' });
      const log = await page.evaluate(() => window.__ctx);
      const photo = log[0];
      const input = log.find((l) => l.tag === 'INPUT');
      const heading = log[log.length - 1];
      const pass =
        log.length === 3 &&
        photo.prevented === true &&
        !!input &&
        input.prevented === false &&
        heading.prevented === true;
      return { pass, detail: JSON.stringify(log) };
    },
  },
  {
    // #116: 入力欄では Ctrl+A（全選択）/コピー/貼り付けが通常どおり使える。user-select:none を
    // 継承して入力できなくなる事故（WebKit）が無いことの確認も兼ねる。
    name: 'text inputs still select, type and paste normally despite user-select none (#116)',
    hash: 'slides',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
      await openSettingsModal(page);
      await page.evaluate(() => document.querySelectorAll('[role="tab"]')[2].click());
      await page.waitForTimeout(400);
      const input = page.locator('[role="dialog"] input[type="text"]:not([readonly])').first();
      await input.click();
      await page.keyboard.type('hello world');
      await page.keyboard.press('Control+a');
      const sel = await input.evaluate((el) => ({
        sel: el.value.slice(el.selectionStart, el.selectionEnd),
        us: getComputedStyle(el).userSelect,
      }));
      // 選択 → 上書き（貼り付け相当）。クリップボード権限に依存せず insertText で確認。
      await page.keyboard.insertText('pasted');
      const after = await input.inputValue();
      // パス表示（readonly input）も選択できる。
      await page.evaluate(() => document.querySelectorAll('[role="tab"]')[0].click());
      await page.waitForTimeout(400);
      const ro = page.locator('[role="dialog"] input[readonly]').first();
      await ro.click();
      await page.keyboard.press('Control+a');
      const roSel = await ro.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
      const pass =
        sel.sel === 'hello world' && sel.us === 'text' && after === 'pasted' && roSel.length > 0;
      return {
        pass,
        detail: `selected="${sel.sel}" us=${sel.us} afterPaste="${after}" readonlySel="${roSel}"`,
      };
    },
  },
  {
    // #116: 選択が有用な箇所（確認モーダルの本文）は user-select:text で、選択してコピーできる。
    name: 'confirm dialog body stays selectable while the page is not (#116)',
    hash: 'slides',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
      await openSettingsModal(page);
      await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        tabs[tabs.length - 1].click();
      });
      await page.waitForSelector('svg.lucide-rotate-ccw', { timeout: 8000 });
      await page.evaluate(() =>
        document.querySelector('svg.lucide-rotate-ccw').closest('button').click(),
      );
      await page.waitForSelector('[role="alertdialog"]', { timeout: 2000 });
      await page.waitForTimeout(300);
      const us = await page.evaluate(() => {
        return getComputedStyle(document.querySelector('[data-testid="confirm-dialog-final"]'))
          .userSelect;
      });
      // 本文を実際に範囲選択（トリプルクリック）して文字列が取れる。
      const pt = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="confirm-dialog-final"]');
        const r = el.getBoundingClientRect();
        return { x: r.left + 20, y: r.top + 8 };
      });
      await page.mouse.click(pt.x, pt.y, { clickCount: 3 });
      const selected = await page.evaluate(() => window.getSelection().toString());
      await page.keyboard.press('Control+a');
      const all = await page.evaluate(() => window.getSelection().toString());
      // 入力欄の外の Ctrl+A は抑止されるので、選択は三連クリックのまま変わらない。
      const pass = us === 'text' && selected.length > 0 && all === selected;
      return {
        pass,
        detail: `bodyUserSelect=${us} tripleClick="${selected.slice(0, 24)}" afterCtrlA="${all.slice(0, 24)}"`,
      };
    },
  },
  {
    // #116: WebView 既定のショートカット（再読み込み/devtools/印刷/保存/検索/ソース表示/ズーム）は
    // preventDefault される。アプリ自前・確認モーダルのキー（Tab/Enter）や Ctrl+A/C/V は触らない。
    // 実機(WebView2)での F5/右クリック/ズームの挙動は PR の「実機確認項目」。
    name: 'browser shortcuts are default-prevented, app and edit keys are not (#116)',
    hash: 'slides',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings', { timeout: 15000 });
      await page.evaluate(() => {
        window.__keys = [];
        window.addEventListener('keydown', (e) => {
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
          window.__keys.push({
            k: e.key + (e.ctrlKey ? '+Ctrl' : ''),
            prevented: e.defaultPrevented,
          });
        });
        window.__wheel = [];
        window.addEventListener('wheel', (e) => window.__wheel.push(e.defaultPrevented), {
          passive: true,
        });
      });
      const blocked = [
        'F5',
        'F12',
        'Control+r',
        'Control+Shift+i',
        'Control+p',
        'Control+s',
        'Control+u',
        'Control+f',
        'Control+g',
        'Control+Minus',
        'Control+Equal',
        'Control+0',
      ];
      const free = ['Tab', 'Enter', 'Control+c', 'Control+v'];
      for (const k of [...blocked, ...free]) {
        await page.keyboard.press(k);
      }
      // Ctrl+ホイール（ズーム/ピンチ）と通常ホイール。
      await page.evaluate(() => {
        document.body.dispatchEvent(
          new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true, cancelable: true }),
        );
        document.body.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }),
        );
      });
      const keys = await page.evaluate(() => window.__keys);
      const wheel = await page.evaluate(() => window.__wheel);
      const bad = [];
      keys.slice(0, blocked.length).forEach((e, i) => {
        if (!e.prevented) bad.push(`not-blocked:${blocked[i]}`);
      });
      keys.slice(blocked.length).forEach((e, i) => {
        if (e.prevented) bad.push(`wrongly-blocked:${free[i]}`);
      });
      if (keys.length !== blocked.length + free.length) bad.push(`keys=${keys.length}`);
      if (wheel[0] !== true || wheel[1] !== false) bad.push(`wheel=${JSON.stringify(wheel)}`);
      return {
        pass: bad.length === 0,
        detail: bad.length
          ? bad.join(' ')
          : `${blocked.length} blocked, ${free.length} free, wheel ok`,
      };
    },
  },
  // #116: 最小ウィンドウサイズ（tauri.conf.json の minWidth/minHeight）で、設定の全タブ・
  // 確認モーダル・ようこそ画面・オーバーレイ・「…」メニューが崩れない（ボタン切れ・
  // 横スクロール・画面外はみ出し無し、フォルダタブの主要操作が折り返しの下に隠れない）。値は設定ファイルから読むので、下げると本テストが検出する。
  ...['ja', 'en'].map((lang) => ({
    name: `layout holds at the minimum window size from tauri.conf.json, ${lang} (#116)`,
    hash: 'thumbs',
    locale: lang === 'ja' ? 'ja-JP' : 'en-US',
    async run(page) {
      const win = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
      ).app.windows[0];
      const { minWidth: w, minHeight: h } = win;
      if (!w || !h) return { pass: false, detail: 'minWidth/minHeight 未設定' };
      await page.setViewportSize({ width: w, height: h });
      await page.waitForSelector('svg.lucide-settings', { timeout: 30000 });
      await page.waitForTimeout(500);
      const problems = [];
      const check = async (label) => {
        const p = await page.evaluate(detectLayoutProblems);
        for (const x of p) problems.push(`${label}: ${x}`);
      };
      await openSettingsModal(page);
      const tabCount = await page.evaluate(() => document.querySelectorAll('[role="tab"]').length);
      for (let i = 0; i < tabCount; i++) {
        await page.evaluate((n) => document.querySelectorAll('[role="tab"]')[n].click(), i);
        await page.waitForTimeout(300);
        await check(`tab${i}`);
        if (i === 0) {
          // フォルダタブの主要操作（パス欄と「選択」ボタン）が、本文をスクロールしなくても
          // 本文スクロール領域の中に見えていること（高さを下げすぎるとここが折り返しの下に隠れる）。
          const vis = await page.evaluate(() => {
            const c = document.querySelector('div.flex-1.overflow-y-auto').getBoundingClientRect();
            const inView = (e) => {
              if (!e) return false;
              const r = e.getBoundingClientRect();
              return r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
            };
            const input = document.querySelector('[role="dialog"] input[readonly]');
            const select = input && input.parentElement.querySelector('button');
            return { input: inView(input), select: inView(select) };
          });
          if (!vis.input) problems.push('folder tab: path field hidden below the fold');
          if (!vis.select) problems.push('folder tab: Select button hidden below the fold');
        }
        if (i === 2) {
          // 除外ルールタブはスクロール無しで全体（追加欄と追加ボタンの下端まで）が収まること。
          const fits = await page.evaluate(() => {
            const c = document.querySelector('div.flex-1.overflow-y-auto');
            const input = document.querySelector(
              '[role="dialog"] input[type="text"]:not([readonly])',
            );
            const r = input.getBoundingClientRect();
            const cr = c.getBoundingClientRect();
            return {
              inside: r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1,
              noScroll: c.scrollHeight <= c.clientHeight + 1,
            };
          });
          if (!fits.inside) problems.push('exclude tab: add field clipped at the bottom');
          if (!fits.noScroll) problems.push('exclude tab: needs scrolling');
        }
        await page.evaluate(() => {
          const c = document.querySelector('div.flex-1.overflow-y-auto');
          if (c) c.scrollTop = c.scrollHeight;
        });
        await page.waitForTimeout(100);
        await check(`tab${i}-bottom`);
        // 最下部までスクロールしたとき、一番下の入力欄/ボタンが本文領域の中に完全に見えること。
        const lastClipped = await page.evaluate(() => {
          const c = document.querySelector('div.flex-1.overflow-y-auto');
          const cr = c.getBoundingClientRect();
          const els = [...c.querySelectorAll('input,button,select,textarea')].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (!els.length) return null;
          const last = els.reduce((a, b) =>
            a.getBoundingClientRect().bottom >= b.getBoundingClientRect().bottom ? a : b,
          );
          const r = last.getBoundingClientRect();
          return r.bottom > cr.bottom + 1 || r.top < cr.top - 1
            ? `${last.tagName}:${(last.textContent || last.placeholder || '').trim().slice(0, 12)}`
            : null;
        });
        if (lastClipped) problems.push(`tab${i}-bottom: last control clipped ${lastClipped}`);
        await page.evaluate(() => {
          const c = document.querySelector('div.flex-1.overflow-y-auto');
          if (c) c.scrollTop = 0;
        });
      }
      // 確認モーダル（情報タブの全データ初期化）。
      await page.evaluate(() => {
        const t = [...document.querySelectorAll('[role="tab"]')];
        t[t.length - 1].click();
      });
      await page.waitForSelector('svg.lucide-rotate-ccw', { timeout: 8000 });
      await page.evaluate(() =>
        document.querySelector('svg.lucide-rotate-ccw').closest('button').click(),
      );
      await page.waitForSelector('[role="alertdialog"]', { timeout: 2000 });
      await page.waitForTimeout(300);
      await check('confirm');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape'); // 設定を閉じる
      await page.waitForTimeout(300);
      // ショートカット一覧・オーバーレイ・「…」メニューと除外サブメニュー。
      await page.keyboard.press('Shift+/');
      await page.waitForTimeout(400);
      await check('shortcuts');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await wakeFromIdle(page);
      await check('overlay');
      await page.evaluate(() =>
        document.querySelectorAll('button[aria-haspopup="menu"]')[0].click(),
      );
      await page.waitForTimeout(300);
      await check('menu');
      await page.evaluate(() =>
        document.querySelectorAll('button[aria-haspopup="menu"]')[1].click(),
      );
      await page.waitForTimeout(400);
      // 除外サブメニュー（幅430px以下では積み重ね展開のため、はみ出しだけ見る）。
      await check('exclude-submenu');
      return {
        pass: problems.length === 0,
        detail: problems.length
          ? problems.slice(0, 6).join(' | ')
          : `${w}x${h}: no layout problems`,
      };
    },
  })),
  {
    // #115: 取得失敗（get_ignore_patterns/get_picked_images/get_recent_images/get_display_stats を
    // reject）は、「〜はありません」の空状態でなく「読み込みに失敗しました」のエラー状態と再試行ボタンになる。
    name: 'load failures show an error state with retry, not the empty message (#115)',
    hash: 'slides?fail=get_ignore_patterns,get_picked_images,get_recent_images,get_display_stats',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings');
      await openSettingsModal(page);
      const tabs = [
        { id: 'exclude', empty: '除外ルールはありません' },
        { id: 'pick', empty: 'ピックした写真はありません' },
        { id: 'history', empty: '表示履歴はありません' },
        { id: 'stats', empty: 'データがありません' },
      ];
      const details = [];
      let pass = true;
      for (const tab of tabs) {
        await page.click(`#tab-${tab.id}`);
        await page.waitForTimeout(300);
        const errorShown = await isVisible(page, '読み込みに失敗しました');
        const retryShown = await page.evaluate(() =>
          [...document.querySelectorAll('[role=tabpanel] [role=alert] button')].some(
            (b) => b.textContent.includes('再試行') && getComputedStyle(b).display !== 'none',
          ),
        );
        const emptyShown = await isVisible(page, tab.empty);
        const ok = errorShown && retryShown && !emptyShown;
        if (!ok) pass = false;
        details.push(`${tab.id}:error=${errorShown} retry=${retryShown} emptyShown=${emptyShown}`);
      }
      return { pass, detail: details.join(' ') };
    },
  },
  {
    // #115: 失敗していた取得は、障害が直ってから再試行ボタンを押すと回復し、本当に空なら空状態の文言になる。
    name: 'retry recovers from a load failure and then shows the genuine empty state (#115)',
    hash: 'slides?fail=get_picked_images',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings');
      await openSettingsModal(page);
      await page.click('#tab-pick');
      await page.waitForTimeout(300);
      const errorShown = await isVisible(page, '読み込みに失敗しました');
      // 再試行の前にバックエンド側の障害が直ったことにする
      await page.evaluate(() => window.__e2eHealFailures());
      // dev の StrictMode は mount 時の取得を2回呼ぶので、絶対数でなく再試行ボタンによる増分を見る
      const callsBefore = await countCalls(page, 'get_picked_images');
      await page.click('[role=tabpanel] [role=alert] button');
      await page.waitForTimeout(300);
      const errorGone = !(await isVisible(page, '読み込みに失敗しました'));
      const emptyShown = await isVisible(page, 'ピックした写真はありません');
      const calls = (await countCalls(page, 'get_picked_images')) - callsBefore;
      const pass = errorShown && errorGone && emptyShown && calls === 1;
      return {
        pass,
        detail: `errorShown=${errorShown} errorGone=${errorGone} emptyShown=${emptyShown} retry calls=${calls}`,
      };
    },
  },
  {
    // #115: 保存失敗（save_setting を reject）は、チェックボックス・select・間隔・言語を元の値へ戻し、
    // 失敗を通知する。同じ失敗を重ねても通知は1つ（積み上がらない）。
    name: 'save failures roll the control back and show one notice (#115)',
    hash: 'slides?fail=save_setting',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings');
      await openSettingsModal(page);
      await page.click('#tab-options');
      await page.waitForTimeout(400);
      const exif = page.locator('[role=tabpanel] input[type=checkbox]').first();
      const exifBefore = await exif.isChecked();
      await exif.click();
      await exif.click();
      await exif.click();
      await page.waitForTimeout(300);
      const exifAfter = await exif.isChecked();
      const exifNotices = await page.locator('[data-testid=exif-error]').count();

      const select = page.locator('select').first();
      const selectBefore = await select.inputValue();
      await select.selectOption('30');
      await page.waitForTimeout(300);
      const selectAfter = await select.inputValue();

      const number = page.locator('input[type=number]');
      const numberBefore = await number.inputValue();
      await number.fill('30');
      await number.blur();
      await page.waitForTimeout(300);
      const numberAfter = await number.inputValue();

      await page.click('button:has-text("English")');
      await page.waitForTimeout(300);
      const lang = await page.evaluate(() => document.documentElement.lang);
      const noticeText = await page.evaluate(() =>
        [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent).join(' | '),
      );
      // 通知は対象名つきで、同じ文言が並ばない（表示間隔/EXIF回転/動画/言語）
      const targets = ['表示間隔', 'EXIF回転の設定', '動画の設定', '言語の設定'];
      const seen = [];
      for (const target of targets) {
        seen.push(await isVisible(page, `${target}を保存できませんでした。元の値に戻しました`));
      }
      const noticeVisible = seen.every(Boolean);
      const pass =
        exifAfter === exifBefore &&
        exifNotices === 1 &&
        selectAfter === selectBefore &&
        numberAfter === numberBefore &&
        lang === 'ja' &&
        noticeVisible;
      return {
        pass,
        detail: `exif ${exifBefore}->${exifAfter} notices=${exifNotices} select ${selectBefore}->${selectAfter} number ${numberBefore}->${numberAfter} htmlLang=${lang} noticeVisible=${noticeVisible} alerts=${noticeText}`,
      };
    },
  },
  {
    // #115: 除外ルールの削除失敗は、ルールを一覧に残したまま失敗を通知する（成功に見せない）。
    name: 'remove failure keeps the exclude rule listed and shows a notice (#115)',
    hash: 'slides?fail=remove_ignore_pattern',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings');
      await openSettingsModal(page);
      await page.click('#tab-exclude');
      await page.waitForTimeout(300);
      await page.fill('input[type=text]', '*.keepme');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.click('button[title="解除"]');
      await page.waitForTimeout(300);
      const noticeShown = await isVisible(page, '除外ルール「*.keepme」を解除できませんでした');
      const stillListed = await isVisible(page, '*.keepme');
      const pass = noticeShown && stillListed;
      return { pass, detail: `noticeShown=${noticeShown} stillListed=${stillListed}` };
    },
  },
  {
    // #115: ピックの失敗は原因（空き容量不足）を伝える。「エラー: コピー失敗」だけではない。
    name: 'pick failure tells the cause (disk full) (#115)',
    hash: 'slides?fail=pick_image:pickDiskFull',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings');
      await wakeFromIdle(page);
      await page.click('button[title="メニュー"]');
      await page.click('button[title="ピック（コピー）"]');
      await page.waitForTimeout(300);
      const causeShown = await isVisible(page, 'ピック先の空き容量が足りないためコピーできません');
      const genericShown = await isVisible(page, 'エラー: コピー失敗');
      const pass = causeShown && !genericShown;
      return { pass, detail: `causeShown=${causeShown} genericShown=${genericShown}` };
    },
  },
  {
    // #115: 起動時に前回フォルダを取得できない(get_last_directory_path が reject)と、
    // 「ようこそ（初回）」画面でなく失敗の案内と再試行になる。障害が直ってから再試行すると、本当の状態になる。
    name: 'startup: last folder read failure shows a retryable failure card, not the welcome screen (#115)',
    hash: 'slides?fail=get_last_directory_path',
    async run(page) {
      await page.waitForSelector('text=前回のフォルダを読み込めませんでした');
      const welcomeShown = await isVisible(page, 'ようこそ SSS へ');
      const retryShown = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent.includes('再試行')),
      );
      const selectShown = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) =>
          b.textContent.includes('ほかのフォルダを選ぶ'),
        ),
      );
      await page.evaluate(() => window.__e2eHealFailures());
      await page.click('button:has-text("再試行")');
      await page.waitForTimeout(600);
      // モックは get_last_directory_path が '/p' を返す → 復旧後は通常どおり写真が出る
      const photoShown = (await page.locator('img').count()) > 0;
      const cardGone = !(await isVisible(page, '前回のフォルダを読み込めませんでした'));
      const pass = !welcomeShown && retryShown && selectShown && photoShown && cardGone;
      return {
        pass,
        detail: `welcomeShown=${welcomeShown} retryShown=${retryShown} selectShown=${selectShown} photoShownAfterRetry=${photoShown} cardGone=${cardGone}`,
      };
    },
  },
  {
    // #115: 起動時に保存済みの設定を取得できない(get_setting が reject)と、既定値で起動したことを
    // 画面上部の通知で伝える（黙って既定値に戻らない）。
    name: 'startup: settings read failure tells the user defaults are in use (#115)',
    hash: 'slides?fail=get_setting',
    async run(page) {
      await page.waitForSelector('text=保存済みの設定を読み込めませんでした');
      const shown = await isVisible(page, '保存済みの設定を読み込めませんでした');
      const photoShown = (await page.locator('img').count()) > 0;
      return { pass: shown && photoShown, detail: `toastShown=${shown} photoShown=${photoShown}` };
    },
  },
  {
    // #115: 英語ロケールでも失敗の文言が英語で出る（取得失敗・ピック失敗の原因）。
    name: 'English locale: load failure and pick failure causes render in English (#115)',
    hash: 'slides?fail=get_picked_images,pick_image:pickPermissionDenied',
    locale: 'en-US',
    async run(page) {
      await page.waitForSelector('svg.lucide-settings');
      await wakeFromIdle(page);
      await page.click('button[title="Menu"]');
      await page.click('button[title="Pick (copy)"]');
      await page.waitForTimeout(300);
      const causeShown = await isVisible(
        page,
        "Couldn't copy: no permission to write to the pick destination",
      );
      await openSettingsModal(page);
      await page.click('#tab-pick');
      await page.waitForTimeout(300);
      const loadErrorShown = await isVisible(page, "Couldn't load this");
      const retryShown = await page.evaluate(() =>
        [...document.querySelectorAll('[role=alert] button')].some((b) =>
          b.textContent.includes('Retry'),
        ),
      );
      const pass = causeShown && loadErrorShown && retryShown;
      return {
        pass,
        detail: `causeShown=${causeShown} loadErrorShown=${loadErrorShown} retryShown=${retryShown}`,
      };
    },
  },
  ...[
    { name: 'ja', locale: 'ja-JP' },
    { name: 'en', locale: 'en-US' },
  ].flatMap((c) =>
    ['white', 'mid', 'black'].map((kind) => ({
      // #113: 白・中間灰・黒の写真の上で、操作バーの文字（ファイル名・撮影日・位置表示）は
      // 実効コントラスト 4.5:1 以上、アイコン（バー・右上ピル）と進捗ヘアラインは 3:1 以上。
      // 黒は修正前でも通る網羅用（退行検出の主役は白・中間灰）。
      name: `overlay contrast on a ${kind} photo: text >= 4.5:1, icons >= 3:1 (${c.name}) (#113)`,
      hash: `bg?kind=${kind}`,
      locale: c.locale,
      async run(page) {
        const { results, withFg } = await measureOverlayContrast(page);
        if (process.env.E2E_SHOT_DIR) {
          fs.writeFileSync(`${process.env.E2E_SHOT_DIR}/contrast-${kind}-${c.name}.png`, withFg);
        }
        const text = summarizeContrast(results);
        await page.reload();
        const hair = summarizeHairline(await measureHairlineContrast(page));
        return { pass: text.pass && hair.pass, detail: `${text.detail} | ${hair.detail}` };
      },
    })),
  ),
  {
    // #113: 明灰・高彩度（赤/緑/青）・白黒1px縦縞・8px市松・高周波ノイズの写真でも同じ基準を満たす
    // （backdrop-blur 越しの背景が最悪側に振れても足りること）。
    name: 'overlay contrast on light, saturated, striped, checker and noisy photos (#113)',
    hash: 'bg?kind=white',
    async run(page) {
      const bad = [];
      const lines = [];
      for (const kind of ['light', 'red', 'green', 'blue', 'stripe', 'checker', 'noise']) {
        await page.goto('about:blank');
        await page.goto(`${BASE_URL}/#bg?kind=${kind}`);
        await page.reload();
        await page.waitForTimeout(800);
        const { results, withFg } = await measureOverlayContrast(page);
        if (process.env.E2E_SHOT_DIR) {
          fs.writeFileSync(`${process.env.E2E_SHOT_DIR}/contrast-${kind}-ja.png`, withFg);
        }
        const s = summarizeContrast(results);
        if (!s.pass) bad.push(kind);
        if (['light', 'red', 'green', 'blue'].includes(kind)) {
          // ヘアラインは単色の写真だけ測る（縞・ノイズは写真側の中央値が意味を持たない）。
          await page.reload();
          const hair = summarizeHairline(await measureHairlineContrast(page));
          if (!hair.pass) bad.push(`${kind}-hairline`);
          s.detail += ` | ${hair.detail}`;
        }
        lines.push(`[${kind}] ${s.detail}`);
      }
      return {
        pass: bad.length === 0,
        detail: `fail=${bad.join(',') || 'none'} ${lines.join(' ')}`,
      };
    },
  },
  ...[
    { name: 'ja', locale: 'ja-JP', date: '2023年8月15日 12:34' },
    { name: 'en', locale: 'en-US', date: 'Aug 15, 2023, 12:34 PM' },
  ].map((c) => ({
    // #114: 長いファイル名(60字・拡張子つき)+EXIF日付+位置+地図でも、ファイル名は 480〜3840 幅で
    // 最低限読める文字数を保ち（修正前は 480 幅で 0 文字・800〜3840 幅で 20 文字）、省略されても拡張子が
    // 見える。撮影日はロケール整形され（生 ISO の T 区切りでない）、バーは画面内に収まり高さも増えない。
    name: `overlay filename keeps a readable width with date + map, date is locale-formatted (${c.name}) (#114)`,
    hash: 'bar',
    locale: c.locale,
    async run(page) {
      const long =
        'Family_Trip_Okinawa_Churaumi_Aquarium_Whale_Shark_2023_08_15_0815.jpg'.slice(0, 56) +
        '.jpg';
      const sizes = [
        [480, 420, 28],
        [800, 600, 45],
        [1280, 800, 45],
        [1920, 1080, 60],
        [3840, 2160, 60],
      ];
      const bad = [];
      const lines = [];
      for (const [w, h, minChars] of sizes) {
        await page.setViewportSize({ width: w, height: h });
        const q = (o) => new URLSearchParams(o).toString();
        const cases = {
          short: q({ name: 'IMG_0001.jpg' }),
          // 典型的なカメラのファイル名(25字)+日付+地図。480 幅でも全文が見え、_0815.jpg で終わる。
          typical: q({
            name: 'IMG_20230815_123456_0815.jpg',
            date: '2023-08-15 12:34:56',
            gps: '1',
            pos: '5',
            total: '9',
          }),
          long: q({
            name: long,
            date: '2023-08-15T12:34:56',
            gps: '1',
            pos: '1234',
            total: '100000',
          }),
          bigcount: q({
            name: long,
            date: '2023-08-15 12:34:56',
            gps: '1',
            pos: '1234567',
            total: '99999999',
          }),
        };
        for (const [kind, query] of Object.entries(cases)) {
          await page.goto('about:blank');
          await page.goto(`${BASE_URL}/#bar?${query}`);
          await page.reload();
          await page.waitForSelector('.fixed.bottom-6 div[title]', { timeout: 15000 });
          await page.waitForTimeout(500);
          await page.mouse.move(w / 2, h / 2 - 50);
          await page.mouse.move(w / 2 + 1, h / 2 - 49);
          await page.waitForTimeout(400);
          const m = await page.evaluate(measureOverlayName);
          if (process.env.E2E_SHOT_DIR) {
            fs.writeFileSync(
              `${process.env.E2E_SHOT_DIR}/filename-${c.name}-${w}x${h}-${kind}.png`,
              await page.screenshot({
                type: 'png',
                clip: { x: 0, y: Math.max(0, h - 140), width: Math.min(w, 1700), height: 140 },
              }),
            );
          }
          const fail = [];
          if (!m) fail.push('bar missing');
          else {
            if (m.hScroll) fail.push('h-scroll');
            if (!m.barInViewport) fail.push('bar off-screen');
            if (m.barH > 60) fail.push(`bar height ${m.barH}`);
            if (kind === 'short' || kind === 'typical') {
              if (m.visible !== m.total) fail.push(`${kind} name clipped ${m.visible}/${m.total}`);
              if (kind === 'short' && m.dateText !== null) fail.push('date shown without EXIF');
              if (kind === 'typical' && !m.visibleText.endsWith('_0815.jpg'))
                fail.push('typical tail');
            } else {
              if (m.visible < minChars) fail.push(`only ${m.visible} chars visible (<${minChars})`);
              if (!m.tailVisible || !m.visibleText.endsWith('.jpg')) fail.push('extension hidden');
              if (m.userSelect !== 'text') fail.push(`user-select ${m.userSelect}`);
              if (m.dateText !== c.date) fail.push(`date "${m.dateText}"`);
              if (m.dateText && m.dateText.includes('T')) fail.push('raw ISO date');
              if (m.posClipped) fail.push('position clipped');
              if (w >= 800 && kind === 'long' && m.dateClipped) fail.push('date clipped');
              if (w >= 1920 && kind === 'long' && m.headClipped) fail.push('filename truncated');
            }
          }
          if (fail.length) bad.push(`${w}x${h}/${kind}: ${fail.join(', ')}`);
          lines.push(`${w}x${h}/${kind}=${m ? `${m.visible}/${m.total}` : 'n/a'}`);
        }
      }
      return { pass: bad.length === 0, detail: bad.length ? bad.join(' | ') : lines.join(' ') };
    },
  })),
  {
    // #114 レビュー M1 / #116: ファイル名は選択・コピーで元の文字列に完全一致する（head と tail の境に
    // 改行が入らない。結合文字・絵文字・日本語・RTL・拡張子なし・ドットだけ・60字超も）。
    // 方法: 要素の全選択 / ドラッグ選択 / トリプルクリック / ダブルクリック(単語。改行なし・部分一致) /
    // Ctrl+C(実クリップボード)。情報クラスタ全体の選択でも区切り点が独立行にならない。
    name: 'overlay file name selects and copies as the exact file name (#114, #116)',
    hash: 'bar',
    async run(page) {
      await page.setViewportSize({ width: 800, height: 600 });
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const names = [
        'Family_Trip_Okinawa_Churaumi_Aquarium_2023_08_15_0815.jpg',
        'a.b.c.jpg',
        '.hidden',
        '沖縄旅行の写真_美ら海水族館_ジンベエザメ_001.jpg',
        'photo_😀😀😀😀😀😀😀😀😀😀_end.jpg',
        'aaaaaaaaaaaaaaaaaaaaaa👨‍👩‍👧.jpg',
        'cafe\u0301_cafe\u0301_cafe\u0301_cafe\u0301_cafe\u0301.jpg',
        'שלום_עולם_תמונה_ארוכה_מאוד_ושוב_2023.jpg',
        'no_extension_file_name_that_is_very_long_indeed_yes',
        'x'.repeat(70) + '.jpg',
      ];
      const bad = [];
      const table = [];
      for (const name of names) {
        const q = new URLSearchParams({
          name,
          date: '2023-08-15 12:34:56',
          gps: '1',
          pos: '5',
          total: '9',
        }).toString();
        await page.goto('about:blank');
        await page.goto(`${BASE_URL}/#bar?${q}`);
        await page.reload();
        await page.waitForSelector('.fixed.bottom-6 [data-overlay="filename"]', { timeout: 15000 });
        await page.waitForTimeout(500);
        await page.mouse.move(400, 250);
        await page.mouse.move(401, 251);
        await page.waitForTimeout(450);
        const got = {};
        const sel = () => page.evaluate(() => window.getSelection().toString());
        // ドラッグの始点・終点は文字そのものの範囲(Range)の内側に取る。RTL 行は文字が行の端と
        // 揃わず、空白部分から始めると選択が空になるため。行の外にはみ出す部分は行幅で切る。
        const box = () =>
          page.evaluate(() => {
            const row = document.querySelector('.fixed.bottom-6 [data-overlay="filename"]');
            const rg = document.createRange();
            rg.selectNodeContents(row);
            const t = rg.getBoundingClientRect();
            const r = row.getBoundingClientRect();
            return { l: t.left, r: Math.min(t.right, r.right), y: r.top + r.height / 2 };
          });
        // 1. 要素全選択 / 情報クラスタ全体
        got.range = await page.evaluate(() => {
          const el = document.querySelector('.fixed.bottom-6 [data-overlay="filename"]');
          const g = window.getSelection();
          const rg = document.createRange();
          rg.selectNodeContents(el);
          g.removeAllRanges();
          g.addRange(rg);
          return g.toString();
        });
        got.cluster = await page.evaluate(() => {
          const el = document.querySelector('.fixed.bottom-6 div[title]');
          const g = window.getSelection();
          const rg = document.createRange();
          rg.selectNodeContents(el);
          g.removeAllRanges();
          g.addRange(rg);
          return g.toString();
        });
        // 2. ドラッグ選択（行の左端から右端まで）
        await page.evaluate(() => window.getSelection().removeAllRanges());
        const b = await box();
        await page.mouse.move(b.l + 1, b.y);
        await page.mouse.down();
        await page.mouse.move(b.r - 1, b.y, { steps: 8 });
        await page.mouse.up();
        got.drag = await sel();
        // 3. トリプルクリック
        await page.mouse.click(b.l + 20, b.y, { clickCount: 3 });
        got.triple = await sel();
        // 4. ダブルクリック（単語）
        await page.mouse.click(b.l + 20, b.y, { clickCount: 2 });
        got.double = await sel();
        // 5. Ctrl+C（ドラッグ選択のあと実クリップボードを読む）。選択済み文字の上で押すと
        // ドラッグ移動になるので、先に選択を外す。
        await page.evaluate(() => window.getSelection().removeAllRanges());
        await page.mouse.move(400, 250);
        await page.mouse.move(b.l + 1, b.y);
        await page.mouse.down();
        await page.mouse.move(b.r - 1, b.y, { steps: 8 });
        await page.mouse.up();
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(150);
        got.copy = await page.evaluate(() => navigator.clipboard.readText());
        const ok = {
          range: got.range === name,
          cluster:
            got.cluster === `${name}\n${got.cluster.split('\n')[1]}` &&
            got.cluster.split('\n').length === 2 &&
            /· 5 \/ 9$/.test(got.cluster),
          drag: got.drag === name,
          triple: got.triple.replace(/\n$/, '') === name,
          double:
            !got.double.includes('\n') &&
            got.double.trim() !== '' &&
            name.includes(got.double.trim()),
          copy: got.copy === name,
        };
        table.push(
          `${name.slice(0, 12)}…:${
            Object.entries(ok)
              .map(([k, v]) => (v ? '' : `!${k}`))
              .join('') || 'ok'
          }`,
        );
        for (const [k, v] of Object.entries(ok)) {
          if (!v) bad.push(`${name.slice(0, 20)} ${k}=${JSON.stringify(got[k])}`);
        }
      }
      return { pass: bad.length === 0, detail: bad.length ? bad.join(' | ') : table.join(' ') };
    },
  },
];

/**
 * #114: 操作バーのファイル名の「実際に見えている文字数」と日付の表示を、実描画で測る。
 * 文字ごとの矩形を取り、祖先のクリップ枠（overflow が visible 以外）の外にはみ出した文字は
 * 数えない（`…` で省略された部分は数えない）。page.evaluate に関数ごと渡すので外側の変数は
 * 参照しない。
 */
function measureOverlayName() {
  const info = document.querySelector('.fixed.bottom-6 div[title]');
  if (!info) return null;
  const bar = info.closest('.fixed');
  const name = info.querySelector('[data-overlay="filename"]');
  const date = info.querySelector('[data-overlay="date"]');
  const pos = info.querySelector('[data-overlay="position"]');
  let visible = 0;
  let total = 0;
  let visibleText = '';
  const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    for (let i = 0; i < t.data.length; i++) {
      const rg = document.createRange();
      rg.setStart(t, i);
      rg.setEnd(t, i + 1);
      const b = rg.getBoundingClientRect();
      total++;
      let ok = b.width > 0;
      for (let a = t.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === 'visible') continue;
        const A = a.getBoundingClientRect();
        if (b.right > A.right + 0.5 || b.left < A.left - 0.5) ok = false;
      }
      if (ok) {
        visible++;
        visibleText += t.data[i];
      }
    }
  }
  const parts = [...name.children];
  const tail = parts.length > 1 ? parts[parts.length - 1] : null;
  const barRect = bar.getBoundingClientRect();
  const infoRect = info.getBoundingClientRect();
  return {
    visible,
    total,
    visibleText,
    barW: Math.round(barRect.width),
    barH: Math.round(barRect.height),
    barInViewport: barRect.left >= 0 && barRect.right <= innerWidth,
    infoW: Math.round(infoRect.width),
    tailText: tail ? tail.textContent : '',
    tailVisible: tail ? tail.getBoundingClientRect().right <= infoRect.right + 0.5 : true,
    headClipped: parts[0].scrollWidth > parts[0].clientWidth + 1,
    dateText: date ? date.textContent : null,
    dateClipped: date ? date.scrollWidth > date.clientWidth + 1 : false,
    posText: pos ? pos.textContent : null,
    posClipped: pos ? pos.getBoundingClientRect().right > infoRect.right + 0.5 : false,
    userSelect: getComputedStyle(name).userSelect,
    hScroll: document.documentElement.scrollWidth > innerWidth,
  };
}

/**
 * #116: 現在の画面で「ボタン切れ・横スクロール・画面外はみ出し・ボタン同士の重なり」を探す。
 * page.evaluate に関数ごと渡すので、ブラウザ側で完結させる（外側の変数は参照しない）。
 * 空配列なら問題無し。設定のタブ行（role=tablist）は横スクロールが仕様なので対象外。
 */
function detectLayoutProblems() {
  const out = [];
  const vw = innerWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    out.push(`document h-scroll ${document.documentElement.scrollWidth}>${vw}`);
  }
  const root = document.querySelector('[role="alertdialog"],[role="dialog"]') || document.body;
  const label = (e) =>
    `${e.tagName}:${(e.textContent || e.value || e.title || '').trim().slice(0, 14)}`;
  const vis = [
    ...root.querySelectorAll('button,input,select,textarea,label,h1,h2,h3,p,span,a'),
  ].filter((e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none' &&
      Number(s.opacity) > 0.05 &&
      !e.closest('[role="tablist"]')
    );
  });
  for (const e of vis) {
    // 実際の文字の範囲（ボタン枠でなく文字そのもの）が、祖先のクリップ枠や画面からはみ出していないこと。
    const range = document.createRange();
    range.selectNodeContents(e);
    const rr = range.getBoundingClientRect();
    const r = rr.width > 0 ? rr : e.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) out.push(`off-screen ${label(e)}`);
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const A = a.getBoundingClientRect();
      if (r.right > A.right + 1 || r.left < A.left - 1) out.push(`clipped ${label(e)}`);
      break;
    }
    if (['BUTTON', 'LABEL', 'SELECT'].includes(e.tagName) && e.scrollWidth > e.clientWidth + 1) {
      out.push(`text overflow ${label(e)} ${e.scrollWidth}>${e.clientWidth}`);
    }
  }
  for (const e of root.querySelectorAll('*')) {
    const s = getComputedStyle(e);
    if (
      (s.overflowX === 'auto' || s.overflowX === 'scroll') &&
      e.scrollWidth > e.clientWidth + 1 &&
      !e.matches('[role="tablist"]')
    ) {
      out.push(
        `h-scroll ${e.tagName}.${String(e.className).slice(0, 24)} ${e.scrollWidth}>${e.clientWidth}`,
      );
    }
  }
  const btns = vis.filter((e) => ['BUTTON', 'INPUT', 'SELECT'].includes(e.tagName));
  for (let i = 0; i < btns.length; i++) {
    for (let j = i + 1; j < btns.length; j++) {
      const a = btns[i];
      const b = btns[j];
      if (a.contains(b) || b.contains(a)) continue;
      const A = a.getBoundingClientRect();
      const B = b.getBoundingClientRect();
      const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left);
      const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
      if (ox > 2 && oy > 2) out.push(`overlap ${label(a)} | ${label(b)}`);
    }
  }
  return out;
}

/**
 * #109: 設定モーダルのタブ行(role=tablist)の高さが、全タブ × 複数ウィンドウ
 * サイズで一定であることを実描画の getBoundingClientRect で測る。
 * 1920x1080 で測った基準高と、1280x800・800x600 の全タブが一致すること。
 */
async function measureSettingsTablistHeights(page) {
  // 高負荷環境でも初回描画（設定ボタン）を待てるよう、固定待機ではなくセレクタで待つ。
  await page.waitForSelector('svg.lucide-settings', { timeout: 30000 });
  await page.waitForTimeout(400);
  await openSettingsModal(page);
  const tabIds = ['scan', 'options', 'exclude', 'pick', 'history', 'stats', 'info'];
  const rows = {};
  const notVisible = [];
  let baseline = null;
  let pass = true;
  for (const [w, h] of [
    [1920, 1080],
    [1280, 800],
    [800, 600],
    [480, 800],
    [360, 640],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const heights = [];
    for (const id of tabIds) {
      // 実マウスクリック。狭幅で完全に隠れているタブは、まず行を横スクロールして
      // 端に少し見える状態にし（ユーザーが行をスワイプ/ホイールした状態）、見えている
      // 部分の中心を page.mouse.click する。追従の effect が無いと、クリック後も
      // タブが一部しか見えないままになり下の可視判定で FAIL する。
      const target = await page.evaluate((i) => {
        const rowEl = document.querySelector('[role="tablist"]');
        const tabEl = document.getElementById(`tab-${i}`);
        let row = rowEl.getBoundingClientRect();
        let tab = tabEl.getBoundingClientRect();
        if (tab.left >= row.right - 4) rowEl.scrollLeft += tab.left - (row.right - 20);
        else if (tab.right <= row.left + 4) rowEl.scrollLeft -= row.left + 20 - tab.right;
        row = rowEl.getBoundingClientRect();
        tab = tabEl.getBoundingClientRect();
        const l = Math.max(tab.left, row.left);
        const r = Math.min(tab.right, row.right);
        return { x: (l + r) / 2, y: tab.top + tab.height / 2 };
      }, id);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(200);
      const height = await page.evaluate(
        () => document.querySelector('[role="tablist"]').getBoundingClientRect().height,
      );
      heights.push(height);
      // 選択タブがタブ行の可視範囲に入っていること（狭幅の横スクロール追従）。
      const visible = await page.evaluate((i) => {
        const row = document.querySelector('[role="tablist"]').getBoundingClientRect();
        const tab = document.getElementById(`tab-${i}`).getBoundingClientRect();
        return tab.left >= row.left - 1 && tab.right <= row.right + 1;
      }, id);
      if (!visible) {
        pass = false;
        notVisible.push(`${w}x${h}:${id}`);
      }
      if (baseline === null) baseline = height;
      if (Math.abs(height - baseline) >= 0.5) pass = false;
    }
    rows[`${w}x${h}`] = heights.map((x) => Math.round(x * 10) / 10);
  }
  return {
    pass,
    detail: `baseline=${baseline} ${JSON.stringify(rows)} notVisible=${JSON.stringify(notVisible)}`,
  };
}

/**
 * #82レビュー2巡目 should1（回帰）/ 3巡目 should・nit: 設定タブ行の折返し・横
 * スクロール挙動を検証する。設定モーダルを一度だけ開き、閉じずにビューポート幅を
 * 1280→720→320へ変えながら、各段階で:
 * - 各タブボタンの**テキストが1行で描画されている**か
 *   （`Range.getClientRects()`で実際の行数を見る。ボタン自体の`top`座標が
 *   揃っているかだけでは、flexの既定`align-items:stretch`で全ボタンが同じ
 *   高さに揃うため、全ボタン同時の折返し＝今回の回帰そのものを見逃す）
 * - 1280/720では行全体が横スクロール無しで収まっているか（3巡目nit: px-4→
 *   px-3でjaの720を横スクロール無しに収める修正）
 * - 320のような極端に狭い幅では横スクロールが可能なまま（overflow-x-auto自体は
 *   機能し続けている）か
 * を確認する。
 */
async function measureSettingsTabRowAtWidths(page) {
  await page.waitForTimeout(300);
  // #124: 固定 400ms 待ちだと負荷でモーダルが開く前に測って count=0 になるため、条件待ちの共通ヘルパを使う。
  await openSettingsModal(page);

  // #82レビュー3巡目nit: タブ行はoverflow-x-autoでクリップされるため、既定の
  // フォーカスリング（要素の外側にはみ出す）だと上下端が欠けて見える。
  // outline-offset:-2pxでリングを内側に描画するようにしたことをcomputed style
  // で確認する（実ブラウザのgetComputedStyleで判定するプロジェクト規約）。
  const outlineOffset = await page.evaluate(() => {
    const btn = document.querySelector('.overflow-x-auto > button');
    return btn ? getComputedStyle(btn).outlineOffset : null;
  });

  const measure = () =>
    page.evaluate(() => {
      const row = document.querySelector('.overflow-x-auto');
      const tabButtons = row ? [...row.querySelectorAll(':scope > button')] : [];
      // ボタン内テキストのRangeを取り、getClientRects()が返す矩形の「異なる
      // top座標の数」を実際の行数とみなす（同一行内でも稀に矩形が分割される
      // ことがあるため、topの重複排除で1行と2行以上を頑健に区別する）。
      const lineCounts = tabButtons.map((b) => {
        const range = document.createRange();
        range.selectNodeContents(b);
        const rects = [...range.getClientRects()];
        const distinctTops = new Set(rects.map((r) => Math.round(r.top)));
        return distinctTops.size;
      });
      const allSingleLine = tabButtons.length > 0 && lineCounts.every((n) => n === 1);
      const scrollWidth = row ? row.scrollWidth : 0;
      const clientWidth = row ? row.clientWidth : 0;
      // 1pxの丸め誤差は許容する。
      const hasHorizontalScroll = scrollWidth > clientWidth + 1;
      return {
        count: tabButtons.length,
        lineCounts,
        allSingleLine,
        scrollWidth,
        clientWidth,
        hasHorizontalScroll,
      };
    });

  const at1280 = await measure();
  await page.setViewportSize({ width: 720, height: 800 });
  await settleLayout(page);
  const at720 = await measure();
  // 3巡目nit: 720/1280が「たまたま横スクロール無しでも全部1行に収まっている」
  // ことの確認に加え、overflow-x-auto自体が壊れて常時スクロール不可になって
  // いないかも極端に狭い幅（320）で確認する。
  await page.setViewportSize({ width: 320, height: 800 });
  await settleLayout(page);
  const atNarrow = await measure();

  const pass =
    outlineOffset === '-2px' &&
    at1280.count === 7 &&
    at1280.allSingleLine &&
    !at1280.hasHorizontalScroll &&
    at720.count === 7 &&
    at720.allSingleLine &&
    !at720.hasHorizontalScroll &&
    atNarrow.count === 7 &&
    atNarrow.allSingleLine &&
    atNarrow.hasHorizontalScroll;

  return {
    pass,
    detail: `outlineOffset=${outlineOffset} at1280=${JSON.stringify(at1280)} at720=${JSON.stringify(at720)} atNarrow=${JSON.stringify(atNarrow)}`,
  };
}

async function main() {
  if (await isPortInUse(PORT)) {
    throw new Error(
      `ポート ${PORT} は既に使用中（別の dev サーバーが動いている可能性）。先に閉じてから実行してください。`,
    );
  }

  console.log(`[e2e] vite dev サーバーを起動中 (port ${PORT})...`);
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: projectRoot,
    // #120: 見張り(media watchdog)の待ち時間の下限(既定10秒)を短縮する。待ち時間は
    // max(表示間隔, 下限) で、e2e の表示間隔は5秒（ただし起動直後の最初の画像は設定の読み込み前で
    // 既定の10秒）なので、下限を下げても実効は5〜10秒。
    env: {
      ...process.env,
      VITE_MEDIA_WATCHDOG_MIN_MS: '1000',
      // #116: dev サーバーでも本番と同じ右クリック/ブラウザ系ショートカット抑止を有効にする。
      VITE_FORCE_WEBVIEW_GUARDS: 'true',
    },
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

    let browser = await launchSystemBrowser();
    const results = [];
    let browserRestarts = 0;
    let consecutiveOpenFailures = 0;
    try {
      // E2E_ONLY='(#68)' のようにカンマ区切りの部分文字列を指定すると、名前が一致するシナリオだけ実行する
      // （デバッグ用。未指定なら全件）。
      const only = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',') : null;
      for (const scenario of scenarios) {
        if (only && !only.some((o) => scenario.name.includes(o))) continue;
        console.log(`[e2e] 実行中: ${scenario.name}`);
        // #80: navigator.language はホストOS/ブラウザの設定に依存するため、
        // 明示指定が無い既存シナリオは 'ja-JP' に固定してロケール解決を決定的にする
        // （app_settings.language 未設定→'auto'→navigator.languageの経路）。
        // 英語ロケールを検証するシナリオは `locale: 'en-US'` を個別に指定する。
        // #124: 高負荷・メモリ逼迫でブラウザプロセス自体が落ちる（`Target page, context or
        // browser has been closed`）ことがあり、1つの browser を使い回していると以後の全シナリオが
        // 巻き添えになる。「ブラウザの切断・終了」が原因と判断できる失敗（isConnected() が false、
        // またはエラーが closed/disconnected/crashed）に限り、起動し直して1回だけ再試行する
        // （goto のタイムアウト等、ブラウザが生きている失敗では再起動しない。シナリオ自体の FAIL も再試行しない）。
        const consoleErrors = [];
        const openPage = async () => {
          const pg = await browser.newPage({
            viewport: scenario.viewport || { width: 1280, height: 800 },
            locale: scenario.locale || 'ja-JP',
          });
          await pg.addInitScript({ path: INIT_SCRIPT });
          pg.on('console', (m) => {
            if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
          });
          // #120: goto 前に仕込みが要るシナリオ（応答しないリクエスト等）用。
          if (scenario.setup) await scenario.setup(pg);
          await pg.goto(`${BASE_URL}/#${scenario.hash}`);
          return pg;
        };
        const isBrowserGone = (err) =>
          !browser.isConnected() || /closed|disconnected|crashed/i.test(String(err && err.message));
        let page;
        let retried = null;
        try {
          if (!browser.isConnected()) throw new Error('browser disconnected');
          page = await openPage();
        } catch (err) {
          if (!isBrowserGone(err)) {
            results.push({
              name: scenario.name,
              pass: false,
              detail: `ページを開けなかった（ブラウザは生存）: ${err.message}`,
              consoleErrors: [],
            });
            continue;
          }
          retried = err.message.split('\n')[0].slice(0, 80);
          browserRestarts++;
          console.warn(`[e2e] ブラウザを再起動して再試行: ${retried}`);
          await browser.close().catch(() => {});
          consoleErrors.length = 0;
          try {
            browser = await launchSystemBrowser();
            page = await openPage();
            consecutiveOpenFailures = 0;
          } catch (err2) {
            // 再起動後も開けない: このシナリオを FAIL として記録して続行する。
            // 連続で失敗する場合だけ打ち切る（それまでの結果は必ず出力する）。
            results.push({
              name: scenario.name,
              pass: false,
              detail: `ブラウザ再起動後もページを開けなかった: ${err2.message}`,
              retried,
              consoleErrors: [],
            });
            if (++consecutiveOpenFailures >= 2) {
              console.warn('[e2e] ブラウザ再起動が連続で失敗したため打ち切ります');
              break;
            }
            continue;
          }
        }
        // #66: 複数ページを同じbrowserで使い回す中、直前のシナリオがフォーカス
        // トラップ（モーダルを開いてフォーカスを奪う）を使うと、後続シナリオの
        // page.keyboard.press()がOSレベルでは非アクティブな古いページに実際の
        // キー入力ルーティングを奪われることがあった（document.activeElementは
        // 期待通りbodyのままなのに、Spaceキー等が効かない）。明示的にこのページを
        // 前面に出してからキーボード操作を伴うシナリオを実行する。
        await page.bringToFront();
        let outcome;
        try {
          outcome = await scenario.run(page);
        } catch (err) {
          outcome = { pass: false, detail: `例外: ${err.message}` };
        }
        results.push({
          name: scenario.name,
          ...outcome,
          ...(retried ? { retried } : {}),
          consoleErrors: consoleErrors.slice(0, 3),
        });
        await page.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }

    console.log('\n[e2e] 結果:');
    let allPass = true;
    for (const r of results) {
      const mark = r.pass ? 'PASS' : 'FAIL';
      if (!r.pass) allPass = false;
      console.log(
        `  [${mark}] ${r.name}${r.retried ? ` (retried: browser restarted: ${r.retried})` : ''}\n        ${r.detail}`,
      );
      if (r.consoleErrors.length > 0) {
        console.log(`        console errors: ${r.consoleErrors.join(' | ')}`);
      }
    }
    if (browserRestarts > 0) console.log(`[e2e] ブラウザを再起動した回数: ${browserRestarts}`);
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
