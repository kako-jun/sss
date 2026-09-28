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
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const PORT = 1420;
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
    // #65レビュー3巡目M4(must): 「同じpathの連続表示はフェード省略」nitが、
    // AnimatePresence(mode="wait")の退場500ms中の再レンダーで誤って発火し、
    // 画像→動画・動画→画像を含む全ての切り替えでフェードインが消えていた
    // （新要素がopacity 0→1ではなく瞬時に1で現れる）。新しくマウントされた
    // 要素が必ず低いopacityから始まり、約0.5秒かけて1に達することを
    // 40ms間隔のサンプリングで確認する。
    name: 'newly mounted media always fades in over ~0.5s, never appears instantly at opacity 1 (M4)',
    hash: 'fade',
    async run(page) {
      async function sampleOpacityFor(ms) {
        const samples = [];
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const opacity = await page.evaluate(() => {
            const el =
              document.querySelector('video') ||
              [...document.querySelectorAll('img')].find((i) => i.alt !== 'SSS Logo');
            return el ? Number(getComputedStyle(el).opacity) : null;
          });
          samples.push(opacity);
          await page.waitForTimeout(40);
        }
        return samples;
      }

      const fadesIn = (samples) => {
        const sawLow = samples.some((o) => o !== null && o < 0.9);
        const sawHigh = samples.some((o) => o !== null && o >= 0.95);
        return sawLow && sawHigh;
      };

      // 初回マウント(画像a)のフェードインを見る。
      const initialSamples = await sampleOpacityFor(700);

      // 手動で次へ進み、2件目(動画)への切り替わりのフェードインも見る
      // （退場500ms + 自身のフェード500msぶん、余裕を持って観測する）。
      await page.keyboard.press('ArrowRight');
      const toVideoSamples = await sampleOpacityFor(1300);

      // さらに次へ進み、動画→画像の切り替わりも確認する。
      await page.keyboard.press('ArrowRight');
      const toImageSamples = await sampleOpacityFor(1300);

      const pass = fadesIn(initialSamples) && fadesIn(toVideoSamples) && fadesIn(toImageSamples);
      return {
        pass,
        detail: `initial=${JSON.stringify(initialSamples)} toVideo=${JSON.stringify(toVideoSamples)} toImage=${JSON.stringify(toImageSamples)}`,
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
];

async function main() {
  if (await isPortInUse(PORT)) {
    throw new Error(
      `ポート ${PORT} は既に使用中（別の dev サーバーが動いている可能性）。先に閉じてから実行してください。`,
    );
  }

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
      await waitForServer(BASE_URL, 15000, vite);
    } catch (err) {
      console.error(viteOutput);
      throw err;
    }

    const browser = await launchSystemBrowser();
    const results = [];
    try {
      for (const scenario of scenarios) {
        // #80: navigator.language はホストOS/ブラウザの設定に依存するため、
        // 明示指定が無い既存シナリオは 'ja-JP' に固定してロケール解決を決定的にする
        // （app_settings.language 未設定→'auto'→navigator.languageの経路）。
        // 英語ロケールを検証するシナリオは `locale: 'en-US'` を個別に指定する。
        const page = await browser.newPage({
          viewport: { width: 1280, height: 800 },
          locale: scenario.locale || 'ja-JP',
        });
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
