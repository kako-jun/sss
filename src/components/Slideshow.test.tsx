// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

/**
 * AnimatePresence(mode="wait") は前の要素の退場アニメーション(500ms)が終わるまで
 * 新しい要素を実際にはDOMへマウントしない。これはjsdom+RTLの同期rerenderでも
 * 再現する（`container.querySelector` はexit完了までは古いノードを返し続ける）ため、
 * このタイミングの向こう側を検証するテストは実時間で待つ必要がある
 * （#65レビューM1/M2がまさにこの遅延タイミングに起因するバグだったため、
 * フェイクタイマーで飛ばさず実際に待って検証する）。
 */
async function waitForExitAnimation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
}

// convertFileSrc は window.__TAURI_INTERNALS__ を要求するため jsdom では
// 呼ぶと例外になる。パスをそのまま素通しするだけの薄いモックに差し替える。
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { Slideshow } from './Slideshow';
import type { ImageInfo } from '../types';

function makeImage(overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    path: '/photos/a.jpg',
    optimizedPath: null,
    isVideo: false,
    width: 100,
    height: 100,
    fileSize: 1234,
    exif: null,
    displayCount: 0,
    lastDisplayed: null,
    ...overrides,
  };
}

// #60レビュー2巡目 must B: crossOrigin/image-orientationの明示切替は撤去し、
// WebView既定の動作（from-image）に任せる方針に転換した。wryのWebKitGTK実装が
// assetスキームをCORS有効登録しておらず、crossOrigin="anonymous"を付けると
// Linux本番で画像が一切表示されなくなるリスクがあったため。
// img要素がcrossOrigin/image-orientationを明示指定しない（ブラウザ既定に委ねる）
// ことをピン留めする（過去にこれらを明示していた実装への回帰検知）。
describe('Slideshow img attributes (#60)', () => {
  it('does not set crossOrigin or an explicit imageOrientation style on the <img>', () => {
    const { container } = render(<Slideshow image={makeImage()} />);

    // #65問題8: alt はフルパスでなく空にする（写真が主役のアプリでファイルパスを
    // 代替表示する意味は無く、読込失敗時に1間隔ぶんパス文字列が見えてしまっていた）。
    // 背景ロゴ(alt="SSS Logo")と区別して本体の写真<img>を取る。
    const photoImg = Array.from(container.querySelectorAll('img')).find(
      (el) => el.getAttribute('alt') !== 'SSS Logo',
    ) as HTMLImageElement | undefined;
    expect(photoImg).not.toBeUndefined();
    expect(photoImg!.alt).toBe('');
    expect(photoImg!.crossOrigin).toBeNull();
    expect(photoImg!.style.imageOrientation).toBe('');
  });

  it('does not set crossOrigin or imageOrientation on the <video> element either', () => {
    const { container } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.crossOrigin).toBeNull();
    expect(video.style.imageOrientation).toBe('');
  });

  it('renders nothing image-related when image is null (loading placeholder only)', () => {
    const { container } = render(<Slideshow image={null} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});

// jsdom は play()/pause() を実装しておらず、呼ぶと「Not implemented」をコンソールへ
// 吐くだけの undefined 返却になる。ファイル全体でノイズを消しつつ呼び出しを
// アサートできるようスパイに差し替える（各testはvi.restoreAllMocksで自動リセットされる
// のでmockClear不要、spy変数はit内で都度 vi.mocked(...) 相当として参照し直す）。
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  playSpy = vi
    .spyOn(window.HTMLMediaElement.prototype, 'play')
    .mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

// #65: 問題2(一時停止中に動画が終わると永久停止)・問題8(onErrorが即次へ進まず、
// altにフルパスが出る) の修正をピン留めする。
describe('Slideshow media lifecycle (#65)', () => {
  it('calls onMediaReady when the <img> finishes loading (timer start basis, 問題6)', () => {
    const onMediaReady = vi.fn();
    const { container } = render(<Slideshow image={makeImage()} onMediaReady={onMediaReady} />);
    const img = Array.from(container.querySelectorAll('img')).find(
      (el) => el.getAttribute('alt') !== 'SSS Logo',
    )!;
    fireEvent.load(img);
    expect(onMediaReady).toHaveBeenCalledTimes(1);
  });

  it('calls onMediaError with the image path (not onAdvance directly) when the <img> errors', () => {
    const onMediaError = vi.fn();
    const onAdvance = vi.fn();
    const { container } = render(
      <Slideshow image={makeImage()} onMediaError={onMediaError} onAdvance={onAdvance} />,
    );
    const img = Array.from(container.querySelectorAll('img')).find(
      (el) => el.getAttribute('alt') !== 'SSS Logo',
    )!;
    fireEvent.error(img);
    expect(onMediaError).toHaveBeenCalledWith('/photos/a.jpg');
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('calls onMediaError with the video path when the <video> errors', () => {
    const onMediaError = vi.fn();
    const { container } = render(
      <Slideshow
        image={makeImage({ isVideo: true, path: '/videos/a.mp4' })}
        onMediaError={onMediaError}
      />,
    );
    const video = container.querySelector('video')!;
    fireEvent.error(video);
    expect(onMediaError).toHaveBeenCalledWith('/videos/a.mp4');
  });

  it('pauses the <video> element when isPlaying becomes false (問題2: pauseがvideoを止めない)', () => {
    const { rerender } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} isPlaying={true} />,
    );
    // #65レビュー2巡目S8: 初回マウント時の再生開始はautoPlay属性に任せる
    // （mediaKeyの変化そのものではeffectがplay()を呼ばない設計にしたため、
    // マウント直後はplaySpyが呼ばれていなくて正しい）。

    rerender(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} isPlaying={false} />,
    );
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('advances only once resumed when the video ends while paused (問題2)', () => {
    const onAdvance = vi.fn();
    const image = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const { container, rerender } = render(
      <Slideshow image={image} isPlaying={false} onAdvance={onAdvance} />,
    );
    const video = container.querySelector('video')!;

    // 一時停止中に(何らかの理由で)再生が終了した
    fireEvent.ended(video);
    expect(onAdvance).not.toHaveBeenCalled();

    // 再開されたら、そこで初めて次へ進む
    rerender(<Slideshow image={image} isPlaying={true} onAdvance={onAdvance} />);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    // 次へ進んだので、素のplay()は呼ばれない
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('does not carry over a stale pending-ended flag to a different video switched to while still paused', async () => {
    // 一時停止中に動画Aが終了(pending=true)→ユーザーが手動で別の動画Bへ切り替えた
    // →Bを再開、という順序でBが即座に(誤って)次へ進んでしまわないことを確認する。
    const onAdvance = vi.fn();
    const videoA = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow image={videoA} isPlaying={false} onAdvance={onAdvance} />,
    );
    fireEvent.ended(container.querySelector('video')!);
    expect(onAdvance).not.toHaveBeenCalled();

    // まだ一時停止中のまま、別の動画へ切り替わった(next操作の結果を模す)
    rerender(<Slideshow image={videoB} isPlaying={false} onAdvance={onAdvance} />);
    // #65レビュー3巡目nit: play()/pause()は「今のmediaKeyの要素」だけが対象なので、
    // AnimatePresenceの退場アニメーションが終わりvideoBが実マウントされるまで待つ。
    await waitForExitAnimation();

    // ここでBを再開しても、Aの終了予約を引き継いで即次へ進んだりしない
    rerender(<Slideshow image={videoB} isPlaying={true} onAdvance={onAdvance} />);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalled();
  });

  it('advances immediately when the video ends while playing', () => {
    const onAdvance = vi.fn();
    const image = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const { container } = render(
      <Slideshow image={image} isPlaying={true} onAdvance={onAdvance} />,
    );
    const video = container.querySelector('video')!;

    fireEvent.ended(video);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

// #65レビューM1(must): AnimatePresence mode="wait" は前の要素の退場アニメーションが
// 終わるまで新しい<video>を実際にはマウントしない。isPlayingの変化を見るeffectは
// pathが変わった瞬間にも発火するが、その時点ではまだ古い/空のvideoRefを見ており、
// 新要素へのplay()が一度も呼ばれず永久停止していた（画像→動画・動画→動画の2本目）。
// autoPlay属性は要素が実際にDOMへ挿入された瞬間にブラウザ/WebViewが評価するため、
// このタイミング問題を回避できる。
describe('Slideshow <video autoPlay> matches isPlaying at mount time (#65レビューM1)', () => {
  it('sets the autoplay DOM property to true when isPlaying is true at mount', () => {
    const { container } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} isPlaying={true} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.autoplay).toBe(true);
  });

  it('sets the autoplay DOM property to false when isPlaying is false at mount (paused navigation)', () => {
    const { container } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} isPlaying={false} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.autoplay).toBe(false);
  });

  it('the video mounted after an image→video transition (delayed by the exit animation) still autoplays', async () => {
    const image = makeImage({ path: '/photos/a.jpg' });
    const video1 = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const { container, rerender } = render(
      <Slideshow image={image} displayToken={0} isPlaying={true} />,
    );
    expect(container.querySelector('video')).toBeNull();

    rerender(<Slideshow image={video1} displayToken={1} isPlaying={true} />);
    await waitForExitAnimation();

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.autoplay).toBe(true);
  });

  it('the second video in a video→video transition (delayed by the exit animation) still autoplays', async () => {
    const video1 = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const video2 = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow image={video1} displayToken={0} isPlaying={true} />,
    );
    const firstVideo = container.querySelector('video');
    expect(firstVideo).not.toBeNull();

    rerender(<Slideshow image={video2} displayToken={1} isPlaying={true} />);
    await waitForExitAnimation();

    const secondVideo = container.querySelector('video') as HTMLVideoElement;
    expect(secondVideo).not.toBeNull();
    expect(secondVideo).not.toBe(firstVideo);
    expect(secondVideo.autoplay).toBe(true);
  });
});

// #65レビューM2(must): 1件だけのプレイリスト等で同じpathが連続で返ると、key/srcが
// 変わらずDOM要素が使い回され、<img onLoad>/<video onEnded>が再発火しない
// （タイマーが張られない・動画が永久に止まる）。displayTokenをkeyに含めることで、
// 同じpathでも必ず新しいDOM要素として作り直させる。
describe('Slideshow remounts on displayToken even when the path is unchanged (#65レビューM2)', () => {
  it('reuses the same <img> node when neither path nor displayToken change', () => {
    const image = makeImage();
    const { container, rerender } = render(<Slideshow image={image} displayToken={0} />);
    const first = container.querySelector('img:not([alt="SSS Logo"])');

    rerender(<Slideshow image={image} displayToken={0} />);
    const second = container.querySelector('img:not([alt="SSS Logo"])');

    expect(second).toBe(first);
  });

  it('creates a brand-new <img> node when displayToken increments even though the path is identical (single-image playlist)', async () => {
    const image = makeImage();
    const { container, rerender } = render(<Slideshow image={image} displayToken={0} />);
    const first = container.querySelector('img:not([alt="SSS Logo"])');

    // バックエンドから同じpathが再度foundとして返ってきた想定(1件プレイリスト)。
    // useSlideshowはこの度にdisplayTokenを+1する。
    rerender(<Slideshow image={image} displayToken={1} />);
    // AnimatePresence(mode="wait")の退場アニメーションが終わるまで実際には
    // 新要素がマウントされないため、実時間で待つ（ファイル冒頭のコメント参照）。
    await waitForExitAnimation();
    const second = container.querySelector('img:not([alt="SSS Logo"])');

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('creates a brand-new <video> node when displayToken increments even though the path is identical (single-video playlist)', async () => {
    const image = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const { container, rerender } = render(
      <Slideshow image={image} displayToken={0} isPlaying={true} />,
    );
    const first = container.querySelector('video');

    rerender(<Slideshow image={image} displayToken={1} isPlaying={true} />);
    await waitForExitAnimation();
    const second = container.querySelector('video');

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

// #65レビュー2巡目S8(must): 動画→動画の遷移でmediaKeyだけが変わった（isPlayingは
// 変化していない）場合、退場中の古い(まだDOM上に残っている)動画要素に対して
// play()を呼び直してはいけない。呼ぶと再生位置が0に巻き戻り、短い動画では
// 再度onEndedが発火して1枚飛ばしてしまっていた。
describe('Slideshow does not replay the exiting video on mediaKey change alone (#65レビュー2巡目S8)', () => {
  it('does not call play() again when mediaKey changes but isPlaying stays true throughout', () => {
    const videoA = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { rerender } = render(<Slideshow image={videoA} displayToken={0} isPlaying={true} />);
    // 初回マウントの挙動（autoPlay属性任せ、jsdomではplay()は呼ばれない）を
    // このテストの対象外にするためリセットしておく。
    playSpy.mockClear();

    rerender(<Slideshow image={videoB} displayToken={1} isPlaying={true} />);

    // isPlayingはtrue→trueで変化していないので、退場中のvideoAに対して
    // play()を呼び直してはいけない（S8の不具合そのもの）。
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('does not call onAdvance when a stale (exiting) video fires onEnded after a newer mediaKey already exists (self-key guard)', () => {
    const onAdvance = vi.fn();
    const videoA = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow image={videoA} displayToken={0} isPlaying={true} onAdvance={onAdvance} />,
    );

    rerender(<Slideshow image={videoB} displayToken={1} isPlaying={true} onAdvance={onAdvance} />);
    // AnimatePresence(mode="wait")はまだvideoBを実マウントしていないため、
    // ここで拾えるのは退場中のvideoA（古いクロージャを持ったまま）。
    const stillExitingVideo = container.querySelector('video')!;
    fireEvent.ended(stillExitingVideo);

    // 古いクロージャのmediaKeyは既に最新ではないため、二重にonAdvanceが
    // 呼ばれてはいけない（呼ばれると1枚飛ばしてしまう）。
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('does not call play()/pause() on the exiting (stale) video when isPlaying toggles during the exit window (#65レビュー3巡目nit: data-media-key guard)', () => {
    const videoA = makeImage({ isVideo: true, path: '/videos/a.mp4' });
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { rerender } = render(<Slideshow image={videoA} displayToken={0} isPlaying={true} />);

    // videoBへ切り替える(退場アニメーション中はまだ古いvideoAがDOM上に残る)。
    rerender(<Slideshow image={videoB} displayToken={1} isPlaying={true} />);
    playSpy.mockClear();
    pauseSpy.mockClear();

    // 退場中に一時停止→再開を素早く切り替える。
    rerender(<Slideshow image={videoB} displayToken={1} isPlaying={false} />);
    rerender(<Slideshow image={videoB} displayToken={1} isPlaying={true} />);

    // videoRefはまだ古い(videoA)要素を指したままのはずで、その要素の
    // data-media-keyは最新のmediaKey(videoB)と一致しないため、
    // play()/pause()どちらも古い要素に対して呼ばれてはいけない。
    expect(playSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
  });
});

// #68: 動画の音声ON/OFF・最大再生時間・自動再生拒否のフォールバック。
// jsdomのHTMLMediaElement.currentTimeは実際には進まないので、要素ごとに値を差し込む。
function setCurrentTime(video: HTMLVideoElement, seconds: number) {
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    value: seconds,
    writable: true,
  });
}

function tick(video: HTMLVideoElement, seconds: number) {
  setCurrentTime(video, seconds);
  fireEvent.timeUpdate(video);
}

const videoA = () => makeImage({ isVideo: true, path: '/videos/a.mp4' });

describe('Slideshow video audio setting (#68)', () => {
  it('mutes the video by default (audio OFF)', () => {
    const { container } = render(<Slideshow image={videoA()} isPlaying={true} />);
    expect((container.querySelector('video') as HTMLVideoElement).muted).toBe(true);
  });

  it('unmutes the video when videoAudioEnabled is true', () => {
    const { container } = render(
      <Slideshow image={videoA()} isPlaying={true} videoAudioEnabled={true} />,
    );
    expect((container.querySelector('video') as HTMLVideoElement).muted).toBe(false);
  });

  it('reflects a live toggle of the setting on the current video', () => {
    const { container, rerender } = render(
      <Slideshow image={videoA()} isPlaying={true} videoAudioEnabled={false} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    rerender(<Slideshow image={videoA()} isPlaying={true} videoAudioEnabled={true} />);
    expect(video.muted).toBe(false);
    rerender(<Slideshow image={videoA()} isPlaying={true} videoAudioEnabled={false} />);
    expect(video.muted).toBe(true);
  });

  it('mutes and pauses the exiting (old) video so its audio does not overlap the next media', () => {
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow image={videoA()} displayToken={0} isPlaying={true} videoAudioEnabled={true} />,
    );
    const oldVideo = container.querySelector('video') as HTMLVideoElement;
    expect(oldVideo.muted).toBe(false);
    pauseSpy.mockClear();

    rerender(
      <Slideshow image={videoB} displayToken={1} isPlaying={true} videoAudioEnabled={true} />,
    );

    // 退場アニメーション中の古い要素がまだDOMにある間にミュート+一時停止される
    expect(container.querySelector('video')).toBe(oldVideo);
    expect(oldVideo.muted).toBe(true);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('a newly mounted video after the exit animation is unmuted again when audio is ON', async () => {
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow image={videoA()} displayToken={0} isPlaying={true} videoAudioEnabled={true} />,
    );
    rerender(
      <Slideshow image={videoB} displayToken={1} isPlaying={true} videoAudioEnabled={true} />,
    );
    await waitForExitAnimation();
    const newVideo = container.querySelector('video') as HTMLVideoElement;
    expect(newVideo.dataset.mediaKey).toBe('/videos/b.mp4::1');
    expect(newVideo.muted).toBe(false);
  });
});

describe('Slideshow video autoplay fallback (#68)', () => {
  function rejectWith(name: string) {
    return vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.reject(new DOMException('blocked', name)));
  }

  it('falls back to muted and keeps playing when play() is rejected with NotAllowedError', async () => {
    const spy = rejectWith('NotAllowedError');
    const { container } = render(
      <Slideshow image={videoA()} isPlaying={true} videoAudioEnabled={true} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.muted).toBe(false);

    await act(async () => {
      fireEvent.loadedData(video);
    });

    expect(video.muted).toBe(true);
    // 最初の試行 + ミュートでの再試行
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not mute for other rejections such as AbortError', async () => {
    const spy = rejectWith('AbortError');
    const { container } = render(
      <Slideshow image={videoA()} isPlaying={true} videoAudioEnabled={true} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    await act(async () => {
      fireEvent.loadedData(video);
    });

    expect(video.muted).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not retry (or replay) when the media already moved on before the rejection arrived', async () => {
    let rejectPlay!: (err: unknown) => void;
    const spy = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => new Promise<void>((_, reject) => (rejectPlay = reject)));
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow image={videoA()} displayToken={0} isPlaying={true} videoAudioEnabled={true} />,
    );
    const oldVideo = container.querySelector('video') as HTMLVideoElement;
    fireEvent.loadedData(oldVideo);
    rerender(
      <Slideshow image={videoB} displayToken={1} isPlaying={true} videoAudioEnabled={true} />,
    );

    await act(async () => {
      rejectPlay(new DOMException('blocked', 'NotAllowedError'));
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls back to muted when resuming from pause is rejected', async () => {
    const image = videoA();
    const { container, rerender } = render(
      <Slideshow image={image} isPlaying={false} videoAudioEnabled={true} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    const spy = rejectWith('NotAllowedError');

    await act(async () => {
      rerender(<Slideshow image={image} isPlaying={true} videoAudioEnabled={true} />);
    });

    expect(video.muted).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never touches play() on loadeddata while paused or when audio is OFF and already playing', () => {
    const { container } = render(<Slideshow image={videoA()} isPlaying={false} />);
    playSpy.mockClear();
    fireEvent.loadedData(container.querySelector('video')!);
    expect(playSpy).not.toHaveBeenCalled();
  });
});

describe('Slideshow video max duration (#68)', () => {
  it('advances once when playback reaches the cap, pausing the video', () => {
    const onAdvance = vi.fn();
    const { container } = render(
      <Slideshow
        image={videoA()}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    pauseSpy.mockClear();

    tick(video, 29.7);
    expect(onAdvance).not.toHaveBeenCalled();

    tick(video, 30.1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('does not double-advance on repeated timeupdate / a late ended after the cap', () => {
    const onAdvance = vi.fn();
    const { container } = render(
      <Slideshow
        image={videoA()}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    tick(video, 30.1);
    tick(video, 30.4);
    tick(video, 30.7);
    fireEvent.ended(video);

    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('a shorter video still advances exactly once via onEnded (cap never reached)', () => {
    const onAdvance = vi.fn();
    const { container } = render(
      <Slideshow
        image={videoA()}
        isPlaying={true}
        videoMaxDurationSec={60}
        onAdvance={onAdvance}
      />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    tick(video, 9.9);
    expect(onAdvance).not.toHaveBeenCalled();
    fireEvent.ended(video);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    // ended後に(念のため)上限判定が走っても二重に進まない
    tick(video, 61);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('never advances by the cap when unlimited (0), only via onEnded', () => {
    const onAdvance = vi.fn();
    const { container } = render(
      <Slideshow image={videoA()} isPlaying={true} videoMaxDurationSec={0} onAdvance={onAdvance} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    tick(video, 99999);
    expect(onAdvance).not.toHaveBeenCalled();
    fireEvent.ended(video);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('does not advance at the cap while paused; advances once on resume without replaying', () => {
    const onAdvance = vi.fn();
    const image = videoA();
    const { container, rerender } = render(
      <Slideshow image={image} isPlaying={false} videoMaxDurationSec={30} onAdvance={onAdvance} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    tick(video, 31);
    expect(onAdvance).not.toHaveBeenCalled();

    playSpy.mockClear();
    rerender(
      <Slideshow image={image} isPlaying={true} videoMaxDurationSec={30} onAdvance={onAdvance} />,
    );
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('pause/resume after the cap was hit (advance still in flight) never resumes playback past the cap', () => {
    const onAdvance = vi.fn();
    const image = videoA();
    const { container, rerender } = render(
      <Slideshow image={image} isPlaying={true} videoMaxDurationSec={30} onAdvance={onAdvance} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    tick(video, 30.2);
    expect(onAdvance).toHaveBeenCalledTimes(1);

    playSpy.mockClear();
    rerender(
      <Slideshow image={image} isPlaying={false} videoMaxDurationSec={30} onAdvance={onAdvance} />,
    );
    rerender(
      <Slideshow image={image} isPlaying={true} videoMaxDurationSec={30} onAdvance={onAdvance} />,
    );
    // 上限を超えて再生し直さない（再開の意図は「次へ」として扱う）
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('ignores the cap on a stale (exiting) video after the media already changed', () => {
    const onAdvance = vi.fn();
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow
        image={videoA()}
        displayToken={0}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    rerender(
      <Slideshow
        image={videoB}
        displayToken={1}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    const exiting = container.querySelector('video') as HTMLVideoElement;
    tick(exiting, 45);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('a fresh video after the cap advance starts with a clean state and can hit the cap again', async () => {
    const onAdvance = vi.fn();
    const videoB = makeImage({ isVideo: true, path: '/videos/b.mp4' });
    const { container, rerender } = render(
      <Slideshow
        image={videoA()}
        displayToken={0}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    tick(container.querySelector('video')!, 31);
    expect(onAdvance).toHaveBeenCalledTimes(1);

    rerender(
      <Slideshow
        image={videoB}
        displayToken={1}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    await waitForExitAnimation();
    tick(container.querySelector('video')!, 30.5);
    expect(onAdvance).toHaveBeenCalledTimes(2);
  });

  it('does not apply the cap to images', () => {
    const onAdvance = vi.fn();
    const { container } = render(
      <Slideshow
        image={makeImage()}
        isPlaying={true}
        videoMaxDurationSec={30}
        onAdvance={onAdvance}
      />,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(onAdvance).not.toHaveBeenCalled();
  });
});
