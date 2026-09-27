// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

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

// #65: 問題2(一時停止中に動画が終わると永久停止)・問題8(onErrorが即次へ進まず、
// altにフルパスが出る) の修正をピン留めする。
describe('Slideshow media lifecycle (#65)', () => {
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom は play()/pause() を実装しておらず、呼ぶと「Not implemented」を
    // コンソールへ吐くだけの undefined 返却になる。ノイズを消しつつ呼び出しを
    // アサートできるようスパイに差し替える。
    playSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());
    pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

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
    expect(playSpy).toHaveBeenCalled();

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

  it('does not carry over a stale pending-ended flag to a different video switched to while still paused', () => {
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
