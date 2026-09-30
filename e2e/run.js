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

/** 設定ボタン（lucideのgearアイコン、ロケール非依存）をクリックして開く。#66用。 */
async function openSettingsModal(page) {
  await page.evaluate(() => {
    const icon = document.querySelector('svg.lucide-settings');
    const btn = icon && icon.closest('button');
    if (!btn) throw new Error('設定ボタンが見つからない');
    btn.click();
  });
  await page.waitForTimeout(350);
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
      await page.waitForTimeout(1000); // 最初の画像表示を待つ（idleは初期状態でtrueのまま）
      await page.waitForTimeout(2500); // 合計3.5秒超、マウスは一度も動かさない
      const idleState = await page.evaluate(() => {
        const root = document.querySelector('.w-screen.h-screen.bg-black');
        const btnRow = [...document.querySelectorAll('div')].find(
          (el) => el.querySelector('svg.lucide-settings') && el.className.includes('fixed'),
        );
        return {
          cursor: root ? getComputedStyle(root).cursor : null,
          buttonRowOpacity: btnRow ? Number(getComputedStyle(btnRow).opacity) : null,
        };
      });
      await page.mouse.move(300, 300);
      await page.mouse.move(320, 320);
      await page.waitForTimeout(300);
      const activeState = await page.evaluate(() => {
        const root = document.querySelector('.w-screen.h-screen.bg-black');
        const btnRow = [...document.querySelectorAll('div')].find(
          (el) => el.querySelector('svg.lucide-settings') && el.className.includes('fixed'),
        );
        return {
          cursor: root ? getComputedStyle(root).cursor : null,
          buttonRowOpacity: btnRow ? Number(getComputedStyle(btnRow).opacity) : null,
        };
      });
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
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(50);
      await page.mouse.wheel(0, 100);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(300);
      const nextAfter = await countCalls(page, 'get_next_image');

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
        nextAfter - nextBefore === 1 &&
        prevAfter - prevBefore === 1;
      return {
        pass,
        detail: `pausedAfterClick=${pausedAfterClick} playingAfterSecond=${playingAfterSecond} pausedAfterDouble=${pausedAfterDouble} overlayStillPlaying=${overlayStillPlaying} overlayNext=${nextAfterOverlay - beforeOverlayClick} wheelNext=${nextAfter - nextBefore} wheelPrev=${prevAfter - prevBefore}`,
      };
    },
  },
];

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
  await page.evaluate(() => {
    // 設定ボタンはlucide-reactの<Settings>アイコン（App.tsx: `Settings as
    // SettingsIcon`）を持つ唯一のボタン。titleはロケール依存な上、window
    // モード切替ボタンのtitle（switchToWindowMode等）はja訳だと「ウィンドウ」が
    // 全角カタカナでASCII "window" を含まないため、title文字列での除外法は
    // ja/enで挙動が変わり得た（実際にja側で誤ってwindowモード切替ボタンを
    // クリックしていた）。lucide-reactは`createLucideIcon`でアイコン名から
    // 機械的に`lucide-settings`等のクラス名を付与するため、ロケールに左右
    // されないこちらで直接選ぶ。
    const icon = document.querySelector('svg.lucide-settings');
    const settingsBtn = icon && icon.closest('button');
    settingsBtn && settingsBtn.click();
  });
  await page.waitForTimeout(400);

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
  await page.waitForTimeout(100);
  const at720 = await measure();
  // 3巡目nit: 720/1280が「たまたま横スクロール無しでも全部1行に収まっている」
  // ことの確認に加え、overflow-x-auto自体が壊れて常時スクロール不可になって
  // いないかも極端に狭い幅（320）で確認する。
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(100);
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
        const page = await browser.newPage({
          viewport: scenario.viewport || { width: 1280, height: 800 },
          locale: scenario.locale || 'ja-JP',
        });
        await page.addInitScript({ path: INIT_SCRIPT });
        const consoleErrors = [];
        page.on('console', (m) => {
          if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
        });
        await page.goto(`${BASE_URL}/#${scenario.hash}`);
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
