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
  /** 画像の実表示開始（`<img onLoad>`）を通知する。タイマー起点に使う（#65 問題6）。 */
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
  useEffect(() => {
    currentMediaKeyRef.current = mediaKey;
    pendingEndedRef.current = false;
  }, [mediaKey]);

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
      } else {
        // play() はブラウザによって Promise を返す/返さないが分かれる
        // （jsdomのテスト環境ではundefinedを返す）ため、Promiseの時だけcatchする。
        const playResult = video.play();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(() => {
            // ユーザー操作外のplay()がブラウザ/WebViewにブロックされても無視してよい
            // （muted指定済みなので通常は許可される）。
          });
        }
      }
    } else {
      video.pause();
    }
  }, [isPlaying, onAdvance]);

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
            muted
            // #65レビューM1: AnimatePresence mode="wait" は前の要素の退場アニメーション
            // (500ms)が終わるまで新しい<video>を実際にはマウントしない。isPlayingの
            // 変化を見る上のeffectは「pathが変わった瞬間」にも発火するが、その時点では
            // videoRefがまだ古い（退場中の）要素を指しているか空で、新要素へのplay()が
            // 一度も呼ばれないまま止まってしまっていた（画像→動画、動画→動画の2本目）。
            // autoPlayはブラウザ/WebViewが実際に要素をDOMへ挿入した瞬間に評価される
            // ため、このタイミング問題を回避できる。
            autoPlay={isPlaying}
            onEnded={() => {
              // #65レビュー2巡目S8(must): 自分(このクロージャが作られた時点)の
              // mediaKeyが、今の最新mediaKeyと一致する時だけ進める。AnimatePresence
              // の退場中要素（古いvideo）がこのonEndedを持ったまま残っている間に
              // 実際に最後まで再生し終わってしまっても、既に次へ進んだ後なら
              // 二重に進めない。
              if (mediaKey !== currentMediaKeyRef.current) return;
              if (isPlaying) {
                onAdvance?.();
              } else {
                // 一時停止中に終了: 再開時にonAdvanceへ回す（上のeffect）。
                pendingEndedRef.current = true;
              }
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
