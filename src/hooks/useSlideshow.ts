import { useState, useEffect, useCallback, useRef } from 'react';
import { getNextImage, getPreviousImage } from '../lib/tauri';
import type { ImageInfo, ImageNavigationResult } from '../types';
import { clampDisplayInterval } from '../constants';

/**
 * 読込失敗（`ImageNavigationResult.kind === 'loadFailed'`）を自動で読み飛ばす際の
 * 連続失敗上限（#65）。バックエンド側の `MAX_MISSING_FILE_SKIPS`（消失ファイルの
 * 読み飛ばし）とは別レイヤーの話で、こちらは「1回の `get_next_image` 呼び出し
 * それ自体」がキャッシュ変換失敗/タイムアウトを返し続けるケースに対する保険。
 * 際限なく自動再試行してAPIを叩き続けないよう、ここで打ち切って通知に切り替える。
 */
const MAX_CONSECUTIVE_LOAD_FAILURES = 5;

/**
 * フロントに露出する「今アプリが伝えるべき状態」（#65）。
 * `ImageNavigationResult` をそのまま返さないのは、`found` はそのまま
 * `currentImage` に格納してしまい、それ以外の「案内が要る状態」だけをここに
 * 残したいため。
 */
export type SlideshowNotice =
  | { kind: 'emptyPlaylist' }
  | { kind: 'rootUnavailable' }
  | { kind: 'loadFailedGaveUp' }
  | { kind: 'error'; message: string };

/**
 * スライドショー管理フック（#65で全面改修）。
 *
 * 旧実装との主な違い:
 * - `isPlaying` はこのフックの内部状態ではなく、呼び出し側（`App.tsx`）が
 *   「ホバー中でも設定画面でもユーザー一時停止でもない」から導出した値を
 *   毎レンダー渡す（問題4: 再スキャン後に勝手に再生開始する不具合の根絶。
 *   `initialize` が何を呼ぼうと、導出元のフラグが変わらない限り再生は始まらない）。
 * - `get_next_image`/`get_previous_image` の結果はタグ付き `ImageNavigationResult`
 *   で区別し、`'No more images'` 等の文字列比較をしない（問題1・9）。
 * - 同時実行ガード（`inFlightRef`）とリクエストID（`requestIdRef`）で、
 *   キーリピートやタイマーと手動操作の重なりによる二重カウント・古い応答の
 *   後着を防ぐ（問題3）。
 * - タイマーは画像の実表示開始（`<img onLoad>`、`handleMediaReady`）を起点にし、
 *   `setTimeout` + 残り時間の保持で一時停止/再開をまたぐ（問題6）。プログレスは
 *   60fpsのポーリングではなくCSS transitionで表現するため、ここでは
 *   「アンカー%」と「アンカーからのtransition時間(ms)」の2値だけを返す。
 *
 * @param interval 表示間隔（ミリ秒）。不正値は `clampDisplayInterval` で丸める。
 * @param isPlaying 再生中かどうか（呼び出し側で導出した派生値）。
 */
export function useSlideshow(interval: number = 10000, isPlaying: boolean = false) {
  const safeInterval = clampDisplayInterval(interval);

  const [currentImage, setCurrentImage] = useState<ImageInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<SlideshowNotice | null>(null);
  // #65レビューM2: `found`を受け取るたびに1増える世代番号。1件だけのプレイリスト
  // 等で同じpathが連続で返ると、Slideshow側のkey/srcが変わらず<img onLoad>/
  // <video onEnded>が再発火しない（タイマーが張られない・動画が永久に止まる）
  // 不具合の修正に使う（`Slideshow`が`key={path + displayToken}`にする）。
  const [displayToken, setDisplayToken] = useState(0);

  // プログレスバー用の2値。バーの見た目は呼び出し側がCSS transitionで表現する:
  //   transition: progressDurationMs > 0 ? `transform ${progressDurationMs}ms linear` : 'none'
  //   transform: `scaleX(${progressPercent / 100})`
  // 新しいメディアの読み込み/一時停止時は duration=0 でその場に固定（0%または
  // 一時停止時点の%にジャンプ）、再生開始/再開時は duration=残り時間、percent=100
  // にして「今の位置→100%」をブラウザに補間させる（60fpsのsetStateを行わない）。
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressDurationMs, setProgressDurationMs] = useState(0);

  const inFlightRef = useRef(false);
  // 同時実行ガード（inFlightRef）が既に「1度に1回しか呼ばせない」を保証しているため、
  // 通常運用ではrequestIdによる「古い応答の破棄」が実際に発火することはほぼ無い
  // （#65レビューnit: 二重の仕組みであることを明記）。それでも残しているのは、
  // 万一inFlightRefのガードをすり抜けるコード変更が将来入っても後着の古い応答を
  // 確実に無視できるようにするための保険。
  const requestIdRef = useRef(0);
  // 直近に呼んだ方向（#65レビュー質問決定: 「前へ」の途中でonErrorになった場合は
  // loadPreviousImageでさらに戻る、前進中は次へ進む）。`continueInLastDirection`が
  // 自動再試行(error/rootUnavailable)とonError時の続行の両方から使う。
  const lastDirectionRef = useRef<'next' | 'previous'>('next');

  const isCurrentVideo = currentImage?.isVideo ?? false;
  const isCurrentVideoRef = useRef(isCurrentVideo);
  isCurrentVideoRef.current = isCurrentVideo;

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const intervalRef = useRef(safeInterval);
  intervalRef.current = safeInterval;

  const remainingMsRef = useRef(safeInterval);
  // 「今表示中のメディアのタイマーが実際に基準にしている間隔」のスナップショット
  // （#65レビューnit）。`intervalRef`は設定変更で即座に書き換わるが、表示間隔の
  // 変更は次のメディアから反映する方針（このファイル末尾のコメント参照）のため、
  // 一時停止%の計算はこのスナップショット基準で行う必要がある。`intervalRef`を
  // そのまま使うと、再生中に間隔を変えてから一時停止した時、
  // `remainingMsRef`（旧intervalで計算済み）と`intervalRef.current`（新interval）が
  // 食い違い、100%を超えたり負になったりするおかしな%になっていた。
  const activeIntervalRef = useRef(safeInterval);
  const timerStartRef = useRef(0);
  const timeoutRef = useRef<number | undefined>(undefined);

  const clearAdvanceTimer = useCallback(() => {
    if (timeoutRef.current !== undefined) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  // 進行中のタイマーを止め、経過分を差し引いた残り時間を保持する
  // （一時停止。問題6: 「再開時に残り時間を捨てて0から」を修正）。
  const pauseAdvanceTimer = useCallback(() => {
    if (timeoutRef.current === undefined) return;
    const elapsed = Date.now() - timerStartRef.current;
    clearAdvanceTimer();
    remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed);
    // #65レビューnit: intervalRef.current（再生中に変更されうる「次に使う値」）
    // ではなく、今のタイマーが実際に基準にしていたactiveIntervalRefを使う。
    const total = activeIntervalRef.current;
    const frozenPercent =
      total > 0 ? Math.min(100, ((total - remainingMsRef.current) / total) * 100) : 100;
    setProgressDurationMs(0);
    setProgressPercent(frozenPercent);
  }, [clearAdvanceTimer]);

  // 残り時間ぶんの setTimeout を張り、プログレスは「今の%→100%」への
  // transitionをブラウザに任せる。
  const startAdvanceTimer = useCallback(
    (onFire: () => void) => {
      clearAdvanceTimer();
      const duration = remainingMsRef.current;
      timerStartRef.current = Date.now();
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = undefined;
        onFire();
      }, duration);
      setProgressDurationMs(duration);
      setProgressPercent(100);
    },
    [clearAdvanceTimer],
  );

  // 新しいメディアの表示が確定した瞬間に呼ぶ: タイマー/プログレスを初期化する。
  const resetTimerForNewMedia = useCallback(() => {
    clearAdvanceTimer();
    remainingMsRef.current = intervalRef.current;
    activeIntervalRef.current = intervalRef.current;
    setProgressDurationMs(0);
    setProgressPercent(0);
  }, [clearAdvanceTimer]);

  /**
   * `<img onLoad>` から呼ぶ（問題6: タイマー起点をIPC応答時点でなく実表示開始に）。
   * 動画は `onEnded` で自走するため、ここでは何もしない。
   */
  const handleMediaReady = useCallback(() => {
    if (isCurrentVideoRef.current) return;
    remainingMsRef.current = intervalRef.current;
    activeIntervalRef.current = intervalRef.current;
    setProgressDurationMs(0);
    setProgressPercent(0);
    if (isPlayingRef.current) {
      startAdvanceTimer(() => {
        void loadNextImageRef.current();
      });
    }
  }, [startAdvanceTimer]);

  // loadNextImage/loadPreviousImage は下で定義するが、handleMediaReady/effect
  // からも参照したいため ref経由で先に穴を用意しておく（TDZを避ける）。
  const loadNextImageRef = useRef<() => Promise<void>>(async () => {});
  const loadPreviousImageRef = useRef<() => Promise<void>>(async () => {});

  const applyNextResult = useCallback(
    (result: ImageNavigationResult): 'stop' | 'retry' => {
      switch (result.kind) {
        case 'found':
          setCurrentImage(result.data);
          setDisplayToken((t) => t + 1);
          setNotice(null);
          resetTimerForNewMedia();
          return 'stop';
        case 'emptyPlaylist':
          setCurrentImage(null);
          setNotice({ kind: 'emptyPlaylist' });
          return 'stop';
        case 'rootUnavailable':
          // 前の画像を維持する（問題: フォルダ接続不可時に鑑賞中の画像を消さない）。
          setNotice({ kind: 'rootUnavailable' });
          return 'stop';
        case 'loadFailed':
          return 'retry';
        case 'noHistory':
          // get_next_image では通常発生しない防御的分岐。
          return 'stop';
      }
    },
    [resetTimerForNewMedia],
  );

  const loadNextImage = useCallback(async () => {
    if (inFlightRef.current) return; // 同時実行ガード（問題3）
    lastDirectionRef.current = 'next';
    inFlightRef.current = true;
    const myId = ++requestIdRef.current; // 古い応答破棄用
    setIsLoading(true);
    try {
      let failures = 0;
      for (;;) {
        let result: ImageNavigationResult;
        try {
          result = await getNextImage();
        } catch (err) {
          if (myId !== requestIdRef.current) return; // 破棄された呼び出し
          setNotice({ kind: 'error', message: String(err) });
          return;
        }
        if (myId !== requestIdRef.current) return; // 破棄された呼び出し

        const outcome = applyNextResult(result);
        if (outcome === 'stop') return;

        // 'retry': 読込失敗は自動で次へ（連続失敗上限つき、問題1・#62/#63コメント由来）
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_LOAD_FAILURES) {
          setNotice({ kind: 'loadFailedGaveUp' });
          return;
        }
      }
    } finally {
      inFlightRef.current = false;
      if (myId === requestIdRef.current) setIsLoading(false);
    }
  }, [applyNextResult]);

  loadNextImageRef.current = loadNextImage;

  const loadPreviousImage = useCallback(async () => {
    if (inFlightRef.current) return;
    lastDirectionRef.current = 'previous';
    inFlightRef.current = true;
    const myId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      let failures = 0;
      for (;;) {
        let result: ImageNavigationResult;
        try {
          result = await getPreviousImage();
        } catch (err) {
          if (myId !== requestIdRef.current) return;
          setNotice({ kind: 'error', message: String(err) });
          return;
        }
        if (myId !== requestIdRef.current) return;

        switch (result.kind) {
          case 'found':
            setCurrentImage(result.data);
            setDisplayToken((t) => t + 1);
            setNotice(null);
            resetTimerForNewMedia();
            return;
          case 'noHistory':
            // 履歴の先頭（境界）。エラーではないので何もしない。
            return;
          case 'rootUnavailable':
            setNotice({ kind: 'rootUnavailable' });
            return;
          case 'emptyPlaylist':
            setCurrentImage(null);
            setNotice({ kind: 'emptyPlaylist' });
            return;
          case 'loadFailed':
            failures += 1;
            if (failures >= MAX_CONSECUTIVE_LOAD_FAILURES) {
              setNotice({ kind: 'loadFailedGaveUp' });
              return;
            }
            continue;
        }
      }
    } finally {
      inFlightRef.current = false;
      if (myId === requestIdRef.current) setIsLoading(false);
    }
  }, [resetTimerForNewMedia]);

  loadPreviousImageRef.current = loadPreviousImage;

  /**
   * `<img>`/`<video>` の `onError` や、`error`/`rootUnavailable` 通知後の自動
   * 再試行から呼ぶ（#65レビュー質問決定）。直近に呼んだ方向（`lastDirectionRef`）を
   * 引き継いで続行する: 「前へ」で戻っている途中に `onError` になった場合は
   * `loadPreviousImage` でさらに戻り、通常の前進中（初期値含む）は `loadNextImage`
   * で次へ進む。
   */
  const continueInLastDirection = useCallback(async () => {
    if (lastDirectionRef.current === 'previous') {
      await loadPreviousImageRef.current();
    } else {
      await loadNextImageRef.current();
    }
  }, []);

  /**
   * 初回画像読み込み。#65: 以前は `autoPlay` 引数で内部の `isPlaying` を
   * 直接trueにしていたが、`isPlaying` は呼び出し側の派生値になったため、
   * ここでは単に最初の画像を読み込むだけでよい（再生が始まるかどうかは
   * 呼び出し側のフラグ次第。問題4の根本修正）。
   */
  const initialize = useCallback(async () => {
    await loadNextImage();
  }, [loadNextImage]);

  // isPlaying の変化（外部からの一時停止/再開）に応じてタイマーを止める/
  // 残り時間から再開する。動画は自走するのでここでは何もしない。
  useEffect(() => {
    if (isCurrentVideo || !currentImage) return;
    if (isPlaying) {
      if (remainingMsRef.current > 0) {
        startAdvanceTimer(() => {
          void loadNextImageRef.current();
        });
      }
    } else {
      pauseAdvanceTimer();
    }
    // currentImage/isCurrentVideo は「メディアが変わった」検知用ではなく、
    // 「動画中は何もしない」ガード用なのでdepsに含めない
    // （メディア変更時のタイマー初期化はresetTimerForNewMedia/handleMediaReadyが担当）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // アンマウント時にタイマーを確実に破棄する。
  useEffect(() => {
    return () => clearAdvanceTimer();
  }, [clearAdvanceTimer]);

  // #65レビューS3/S4: 一時的な通信断（`error`）やフォルダ接続不可
  // （`rootUnavailable`）は、ユーザー操作を待たず表示間隔ごとに自動で
  // 再試行する（`rootUnavailable`の文言「再接続をお待ちください…」を実挙動に
  // 一致させる）。直近の方向（`continueInLastDirection`）で続行し、まだ同じ
  // 状態が続いていれば次のnoticeが新しいタイマーをまた張る形で繰り返す。
  useEffect(() => {
    if (notice?.kind !== 'error' && notice?.kind !== 'rootUnavailable') return;
    const timer = window.setTimeout(() => {
      void continueInLastDirection();
    }, intervalRef.current);
    return () => window.clearTimeout(timer);
  }, [notice, continueInLastDirection]);

  return {
    currentImage,
    displayToken,
    isLoading,
    notice,
    progressPercent,
    progressDurationMs,
    loadNextImage,
    loadPreviousImage,
    continueInLastDirection,
    initialize,
    handleMediaReady,
  };
}
