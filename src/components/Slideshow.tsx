import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { ImageInfo } from '../types';
import logoBg from '../assets/logo-bg.webp';

interface SlideshowProps {
  image: ImageInfo | null;
  /**
   * `found` を受け取るたびに1ずつ増える世代番号（#65レビューM2）。1件だけの
   * プレイリスト等で同じ `path` が連続で返ると、`key`/`src` が変わらず
   * `<img onLoad>`/`<video onEnded>` が再発火しない（＝タイマーが張られない・
   * 動画が永久に止まる）。`key={path + displayToken}` にして必ず新しい
   * DOM要素として作り直させることで、ブラウザに毎回フレッシュに読み込ませる。
   */
  displayToken?: number;
  /** 再生中かどうか（#65: `App.tsx` が導出する派生値）。動画の再生/一時停止に連動させる。 */
  isPlaying?: boolean;
  /**
   * 動画の音声を再生するか（#68）。false（既定）なら従来どおり無音（`muted`）。
   * trueでもWebViewの自動再生ポリシーで`play()`が拒否された場合は、その動画だけ
   * ミュートへ落として再生を続ける（止まったままにしない）。
   */
  videoAudioEnabled?: boolean;
  /**
   * 動画の最大再生時間（秒、#68）。0以下=無制限（動画の長さ分そのまま再生）。
   * 再生位置（`currentTime`）がこの値に達したら次へ進む。動画の方が短ければ
   * 従来どおり`onEnded`で進む。
   */
  videoMaxDurationSec?: number;
  /**
   * 画像の実表示開始（`<img onLoad>`）を通知する。タイマー起点に使う（#65 問題6）。
   * 動画では読込成功（`loadeddata`）で呼ぶ（#120: 連続読込失敗の数え直し用。動画側は何も張らない）。
   */
  onMediaReady?: () => void;
  /** 動画の再生終了、または画像/動画の読込エラー時に「次へ」進む。 */
  onAdvance?: () => void;
  /** 画像/動画の描画に失敗した（`onError`）。加算済みの表示回数を取り消してから次へ進む用途（#65 問題8）。 */
  onMediaError?: (path: string) => void;
}

export function Slideshow({
  image,
  displayToken = 0,
  isPlaying = false,
  videoAudioEnabled = false,
  videoMaxDurationSec = 0,
  onMediaReady,
  onAdvance,
  onMediaError,
}: SlideshowProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 一時停止中に動画が最後まで再生し終わった（＝pause()が間に合わずendedが飛んだ）場合、
  // その場ではonAdvanceを呼ばず「再開されたら次へ」を予約する。#65問題2:
  // 一時停止中に動画が終わると、pause中は無視され、再開してもタイマーが無く
  // 永久に同じ最終フレームで止まっていた不具合の修正。
  const pendingEndedRef = useRef(false);

  // #65レビューM2: 同じpathが連続で返っても(1件プレイリスト等)、displayTokenは
  // 必ず新しい値になるのでkeyが変わり、DOM要素ごと作り直される。
  const mediaKey = `${image?.path ?? ''}::${displayToken}`;

  // #65レビュー2巡目S8: 現在の(最新レンダーの)mediaKeyを常に指すref。
  // AnimatePresence(mode="wait")の退場中要素は「自分が作られた時点のmediaKey」を
  // クロージャに握ったままなので、onEnded/onError発火時にこれと比較すれば
  // 「自分は既に古い(退場中)要素か」を判定できる。
  // #65レビュー3巡目: レンダー中に直接refへ書き込むとeslint(react-hooks/refs)に
  // 抵触するため、mediaKeyが変わるたびにeffectで更新する（onEnded等のイベントは
  // 常にcommit後にしか発火しないため、このタイミングでも実用上の問題は無い）。
  const currentMediaKeyRef = useRef(mediaKey);

  // メディアが切り替わったら、直前のメディアの「一時停止中に終了した」予約を
  // 持ち越さない（一時停止中に手動でnext/prevして別のメディアに切り替えた場合、
  // 古い予約が新しいメディアの再開時に誤発火するのを防ぐ）。同じpathの連続表示
  // （displayTokenだけが変わる）でも同様にリセットする。
  // #68: この動画（mediaKey）について「終了（ended/上限到達）」を既に処理済みかの印。
  // ended と上限到達(timeupdate)の両方から同じ`finish`を通し、どちらが先に来ても
  // 1本の動画につき「次へ」が1回しか発火しない（#65の二重進行を再導入しない）。
  const finishedKeyRef = useRef<string | null>(null);
  // 非同期のplay()拒否ハンドラから「今も再生中の指示か」を参照するための最新値。
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    currentMediaKeyRef.current = mediaKey;
    pendingEndedRef.current = false;
    finishedKeyRef.current = null;

    // #68: mediaKeyが変わった時点で、退場アニメーション(500ms)中の「古い動画」が
    // まだDOMに残っている（videoRefが指している）。音声ONだとフェード中に前の
    // 動画の音が次のメディアと重なるため、ここで必ずミュート+一時停止する。
    // 新しい要素は`data-media-key`が最新と一致するので対象外。
    const exiting = videoRef.current;
    if (exiting && exiting.dataset.mediaKey !== mediaKey) {
      exiting.muted = true;
      exiting.pause();
    }
  }, [mediaKey]);

  // #68: 再生開始。音声ON(muted=false)で自動再生ポリシーに拒否された(NotAllowedError)
  // 場合だけ、その要素をミュートにして再生し直す。AbortError（読込中のsrc差し替え等）
  // のような別の理由の拒否でミュートへ落とすと、音声ONなのに無音になるだけなので
  // 対象を限定する。play()はブラウザによってPromiseを返す/返さない（jsdomはundefined）
  // ため、Promiseの時だけcatchする。
  const startPlayback = (video: HTMLVideoElement) => {
    const playResult = video.play();
    if (!playResult || typeof playResult.catch !== 'function') return;
    playResult.catch((err: unknown) => {
      const isBlocked = (err as { name?: string } | null)?.name === 'NotAllowedError';
      if (!isBlocked || video.muted) return;
      // 拒否が返るまでに次のメディアへ移った/一時停止された場合は再生し直さない。
      if (video.dataset.mediaKey !== currentMediaKeyRef.current || !isPlayingRef.current) return;
      video.muted = true;
      const retry = video.play();
      if (retry && typeof retry.catch === 'function') retry.catch(() => {});
    });
  };

  // #65レビュー2巡目S8(must): 以前はmediaKeyの変化でもこのeffectが発火し、
  // AnimatePresence(mode="wait")の退場アニメーション中でまだDOM上に残っている
  // 「古い(前の)動画」に対してplay()を呼び直していた。短い動画だと再生位置が
  // 0に巻き戻って再度最後まで到達し、古い要素のonEndedがもう一度発火して
  // 1枚飛ばしてしまう不具合があった。isPlaying「が実際に変化した時」だけ
  // play()/pause()する（前回値をrefで比較）。mediaKeyの変化そのものでは何もせず、
  // 新要素の再生開始は`autoPlay={isPlaying}`（実マウント時に評価される）に任せる。
  const prevIsPlayingRef = useRef(isPlaying);
  useEffect(() => {
    const changed = prevIsPlayingRef.current !== isPlaying;
    prevIsPlayingRef.current = isPlaying;
    if (!changed) return;

    const video = videoRef.current;
    if (!video) return;
    // #65レビュー3巡目nit: 退場アニメーション(500ms)の途中でisPlayingが
    // 切り替わると、videoRefはまだ古い(退場中の)要素を指したままなので、
    // そちらへplay()/pause()が飛んでしまう余地があった。要素自身に
    // data-media-keyを持たせ、今の最新mediaKey(currentMediaKeyRef)と
    // 一致する時だけ、この効果の対象にする。
    if (video.dataset.mediaKey !== currentMediaKeyRef.current) return;

    if (isPlaying) {
      if (pendingEndedRef.current) {
        pendingEndedRef.current = false;
        onAdvance?.();
      } else if (finishedKeyRef.current === video.dataset.mediaKey) {
        // #68: 上限到達で一時停止した動画（またはendedで止まった動画）を再開しようと
        // した場合。ここで素のplay()を呼ぶと上限を超えて再生が続く（finish済みなので
        // 二度と次へ進まない）ため、再開の意図＝「次へ」として進める。
        // useSlideshowの同時実行ガードがあるため、進行中の重複呼び出しは無視される。
        onAdvance?.();
      } else {
        startPlayback(video);
      }
    } else {
      video.pause();
    }
  }, [isPlaying, onAdvance]);

  // #68: 動画の終了処理（ended・上限到達の共通経路）。自分（この要素）のmediaKeyが
  // 最新でなければ（退場中の古い要素）何もしない。処理済みなら二重に進めない。
  // 上限到達時は一時停止して、フェード中に最終フレームで止め音声も残さない。
  const finishVideo = (video: HTMLVideoElement) => {
    if (mediaKey !== currentMediaKeyRef.current) return;
    if (finishedKeyRef.current === mediaKey) return;
    finishedKeyRef.current = mediaKey;
    video.pause();
    if (isPlaying) {
      onAdvance?.();
    } else {
      // 一時停止中に終了/上限到達: 再開時にonAdvanceへ回す（上のeffect）。
      pendingEndedRef.current = true;
    }
  };

  if (!image) {
    return <div className="w-screen h-screen bg-black" />;
  }

  // 表示するファイルのパス（最適化版があればそれを使用）
  const displayPath = image.optimizedPath || image.path;
  const srcUrl = convertFileSrc(displayPath);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* 背景ロゴ */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <img src={logoBg} alt="SSS Logo" className="w-1/3 h-auto opacity-2" />
      </div>

      <AnimatePresence mode="wait">
        {image.isVideo ? (
          // 動画の場合。再生/一時停止は isPlaying prop に完全連動させる（上のeffect）。
          <motion.video
            key={mediaKey}
            ref={videoRef}
            // #65レビュー3巡目nit: play()/pause()の対象を「今の要素かどうか」で
            // 判定するための目印（上のeffect参照）。
            data-media-key={mediaKey}
            src={srcUrl}
            // #65レビュー3巡目M4(must): 「同じpathの連続表示はフェード省略」という
            // nitは、AnimatePresence(mode="wait")の退場500ms中に発生する再レンダー
            // （previousPathRefがこの時点で既に「新しい方のpath」に更新済みのため）
            // で誤ってtrueになり、全ての切り替えでフェードインが消えてしまう
            // 不具合があった（実機でA/B交互・動画→動画とも瞬時切替を確認）。
            // 常に通常のフェードイン（1件プレイリストで同じ写真がフェードし直す
            // ことは許容する）に戻した。
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="w-full h-full object-contain"
            style={{
              willChange: 'opacity',
            }}
            // #68: 音声はsetting次第（既定はOFF=無音）。ONでも自動再生を拒否された
            // 場合は startPlayback が要素単位でミュートへ落とす。
            muted={!videoAudioEnabled}
            // #65レビューM1: AnimatePresence mode="wait" は前の要素の退場アニメーション
            // (500ms)が終わるまで新しい<video>を実際にはマウントしない。isPlayingの
            // 変化を見る上のeffectは「pathが変わった瞬間」にも発火するが、その時点では
            // videoRefがまだ古い（退場中の）要素を指しているか空で、新要素へのplay()が
            // 一度も呼ばれないまま止まってしまっていた（画像→動画、動画→動画の2本目）。
            // autoPlayはブラウザ/WebViewが実際に要素をDOMへ挿入した瞬間に評価される
            // ため、このタイミング問題を回避できる。
            autoPlay={isPlaying}
            onEnded={(e) => {
              // #65レビュー2巡目S8(must): 自分(このクロージャが作られた時点)の
              // mediaKeyが、今の最新mediaKeyと一致する時だけ進める（finishVideo内で判定）。
              // AnimatePresenceの退場中要素（古いvideo）が最後まで再生し終わっても、
              // 既に次へ進んだ後なら二重に進めない。
              finishVideo(e.currentTarget);
            }}
            onTimeUpdate={(e) => {
              // #68: 最大再生時間。壁時計タイマーでなく再生位置(currentTime)で判定する
              // ため、一時停止・バッファリング中は進まず、タイマーの張り忘れ/取り消し
              // 漏れ（#65の永久停止・二重進行）が構造的に起きない。timeupdateは
              // 約4Hzなので上限には最大250ms程度の誤差が出る（許容）。
              if (videoMaxDurationSec <= 0) return;
              if (e.currentTarget.currentTime >= videoMaxDurationSec) {
                finishVideo(e.currentTarget);
              }
            }}
            onLoadedData={(e) => {
              // #68: 音声ON時、autoPlay属性は拒否されても結果（Promise）を返さない
              // ため、フォールバック判定用に明示的にplay()して拒否を観測する。
              // 既に再生中/終了処理済み/退場中の要素には何もしない。
              const video = e.currentTarget;
              if (mediaKey !== currentMediaKeyRef.current) return;
              // #120: 動画が実際に読めた印。連続読込失敗の数え直しに使う
              // （動画のタイマーは onEnded で自走するため、これ自体は何も張らない）。
              onMediaReady?.();
              if (!isPlaying || !video.paused || finishedKeyRef.current === mediaKey) return;
              startPlayback(video);
            }}
            onError={() => {
              if (mediaKey !== currentMediaKeyRef.current) return;
              console.error('Failed to load video:', image.path);
              // #65問題8と同様の理由: バックエンドは既に表示回数を加算済みだが、
              // WebViewでの実際のデコード/再生に失敗したので取り消してから次へ。
              onMediaError?.(image.path);
            }}
          />
        ) : (
          // 画像の場合
          // #60 レビュー2巡目 must B: crossOrigin/image-orientationの明示切替は撤去した。
          // wry の WebKitGTK 実装が asset スキームを CORS 有効登録しておらず、
          // crossOrigin="anonymous"を付けるとLinux本番で画像が一切表示されなくなる
          // リスクがあるため。回転はWebView既定の動作（image-orientation: from-image、
          // EXIF Orientationに従って自動回転）に任せる。apply_exif_rotation=falseで
          // EXIFが回転を要求している画像は、バックエンドが「格納画素のまま・EXIF無し」の
          // キャッシュを返す（image_processor::plan_cache_file/requires_synchronous_cache）
          // ため、原本を返さない限りfrom-imageが誤って回転させることはない。
          <motion.img
            key={mediaKey}
            src={srcUrl}
            // #65問題8: フルパスのalt文字列が読込失敗時に1間隔ぶんそのまま表示されて
            // いた（altテキストはブロードキャストされる代替表示のため）。写真が主役の
            // 鑑賞アプリでファイルパスを見せる意味は無いので空にする。
            alt=""
            // #65レビュー3巡目M4(must): 常に通常のフェードインに戻した
            // （上のvideo要素のコメント参照）。
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="w-full h-full object-contain"
            style={{
              willChange: 'opacity',
            }}
            draggable={false}
            onLoad={() => {
              // #65レビュー2巡目S8と同じ理由で念のため: 退場中の古いimgの
              // onLoadは通常ここまでに発火済みのはずだが、防御的に自分のmediaKeyが
              // 最新と一致する時だけ通知する。
              if (mediaKey !== currentMediaKeyRef.current) return;
              onMediaReady?.();
            }}
            onError={() => {
              if (mediaKey !== currentMediaKeyRef.current) return;
              console.error('Failed to load image:', image.path);
              onMediaError?.(image.path);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
