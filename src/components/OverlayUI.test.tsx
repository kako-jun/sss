// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// #59: tauri-plugin-shell の open() から tauri-plugin-opener の openUrl() への移行。
// 地図セルのクリックが正しい引数で openUrl を呼ぶことをピン留めする（GPS座標→URL整形の
// ロジック自体は OverlayUI 内にあるため、モックは openUrl の呼び出しだけを検証する）。
const openUrl = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

const openInExplorer = vi.fn();
const pickImage = vi.fn();
const excludeImage = vi.fn();

vi.mock('../lib/tauri', () => ({
  openInExplorer: (...args: unknown[]) => openInExplorer(...args),
  pickImage: (...args: unknown[]) => pickImage(...args),
  excludeImage: (...args: unknown[]) => excludeImage(...args),
}));

import { OverlayUI } from './OverlayUI';
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

const noop = () => {};
const requiredProps = {
  canGoBack: true,
  currentPosition: 1,
  totalImages: 10,
  progress: 0,
  progressDurationMs: 0,
  isPausedByUser: false,
  onPrevious: noop,
  onNext: noop,
  onOpenPickTab: noop,
  onMouseEnter: noop,
  onMouseLeave: noop,
  onTogglePause: noop,
};

function clickMapButton() {
  // 地図セルのボタン自体にはラベルが無いため、内側の img
  // （alt=t('locationMapAlt')、既定ロケールはja→'位置情報の地図'）から辿る。
  fireEvent.click(screen.getByAltText('位置情報の地図').closest('button')!);
}

beforeEach(() => {
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
  openInExplorer.mockReset();
  pickImage.mockReset();
  excludeImage.mockReset();
});

describe('OverlayUI exclude status message (#61レビューnit, #80)', () => {
  it('builds the "needs rescan" message from the structured backend result (pattern + needsRescan)', async () => {
    // #80: バックエンドは完成済み文言でなく構造化データ({pattern, needsRescan})を
    // 返す。フロント辞書側が文言を組み立てる（二重表示の再発防止も兼ねる）。
    excludeImage.mockResolvedValue({ pattern: '*.tmp', needsRescan: true });
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('ファイルを除外'));

    await screen.findByText('除外パターン追加: *.tmp (変更を反映するには再スキャンしてください)');
  });
});

describe('OverlayUI exclude advances immediately (#65 問題5)', () => {
  it('calls onExcluded after a successful exclude so the caller can advance + refresh playlist info', async () => {
    excludeImage.mockResolvedValue({ pattern: '*.tmp', needsRescan: false });
    const onExcluded = vi.fn();
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} onExcluded={onExcluded} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('ファイルを除外'));

    await screen.findByText('除外パターン追加: *.tmp');
    expect(onExcluded).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onExcluded when the exclude request fails', async () => {
    excludeImage.mockRejectedValue(new Error('boom'));
    const onExcluded = vi.fn();
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} onExcluded={onExcluded} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('ファイルを除外'));

    await screen.findByText('エラー: 除外失敗');
    expect(onExcluded).not.toHaveBeenCalled();
  });
});

// #66 問題2: 旧実装は「実際に再生中か(isPlaying)」を渡していたが、オーバーレイの
// ⏸/▶ボタンはオーバーレイにマウスオーバーしないと見えず、ホバー中はApp.tsx側で
// 常にisPlaying=falseへ自動一時停止するため、ボタンが見えている間は常に
// アイコンが▶(再生)のまま固定されて見える不具合があった。ユーザーが選んだ
// 一時停止状態(isPausedByUser)を独立して渡すことで、ホバーの影響を受けずに
// 正しいアイコン/ツールチップになることを固定する。
describe('OverlayUI pause/play icon reflects isPausedByUser, not the hover-derived isPlaying (#66 問題2)', () => {
  it('shows the Pause icon and "一時停止" tooltip when not paused by the user', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} isPausedByUser={false} />);

    expect(screen.getByTitle('一時停止')).toBeTruthy();
    expect(screen.queryByTitle('再生')).toBeNull();
  });

  it('shows the Play icon and "再生" tooltip when paused by the user', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} isPausedByUser={true} />);

    expect(screen.getByTitle('再生')).toBeTruthy();
    expect(screen.queryByTitle('一時停止')).toBeNull();
  });
});

describe('OverlayUI status message timers do not interfere with each other (#66 問題6)', () => {
  it('keeps a newly shown message visible for its own full duration even if triggered right after a previous one', async () => {
    // 完全に決定的な擬似タイマー（自動進行なし）で制御し、mockの解決に必要な
    // マイクロタスクのフラッシュだけ明示的に行う（実時間との結合による揺れを避ける）。
    vi.useFakeTimers();
    excludeImage.mockResolvedValue({ pattern: 'a.tmp', needsRescan: false });
    pickImage.mockResolvedValue('/picks/a.tmp');
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    // 1回目: 除外してステータスメッセージを表示する。
    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    await act(async () => {
      fireEvent.click(screen.getByText('ファイルを除外'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('除外パターン追加: a.tmp')).toBeTruthy();

    // 2.9秒後（1回目のタイマーが発火する直前）に2回目のピック操作で新しい
    // メッセージを表示する。旧実装は1回目のタイマー(あと0.1秒)がそのまま発火し、
    // 2回目のメッセージを即座に消してしまっていた。
    act(() => {
      vi.advanceTimersByTime(2900);
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('ピック（コピー）'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('コピー完了: /picks/a.tmp')).toBeTruthy();

    // 1回目のタイマーが本来発火していたはずの時刻(+0.2秒)を過ぎても、
    // 2回目のメッセージはまだ消えない（干渉していない証拠）。
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText('コピー完了: /picks/a.tmp')).toBeTruthy();

    // 2回目のメッセージ自身の3秒が経過すれば消える。
    act(() => {
      vi.advanceTimersByTime(2900);
    });
    expect(screen.queryByText('コピー完了: /picks/a.tmp')).toBeNull();

    vi.useRealTimers();
  });
});

describe('OverlayUI map button (openUrl)', () => {
  it('calls openUrl with a Google Maps URL built from positive GPS coordinates', async () => {
    const image = makeImage({
      exif: {
        dateTime: null,
        gpsLatitude: 35.6812,
        gpsLongitude: 139.7671,
        width: null,
        height: null,
      },
    });
    render(<OverlayUI image={image} {...requiredProps} />);

    clickMapButton();

    expect(openUrl).toHaveBeenCalledWith('https://www.google.com/maps?q=35.6812,139.7671');
  });

  it('calls openUrl with negative (southern/western hemisphere) coordinates verbatim', async () => {
    // 境界/文字種: 符号付き数値が URL 文字列にそのまま(エンコードなしで)埋め込まれる現在の
    // 仕様を固定する。
    const image = makeImage({
      exif: {
        dateTime: null,
        gpsLatitude: -33.8688,
        gpsLongitude: -151.2093,
        width: null,
        height: null,
      },
    });
    render(<OverlayUI image={image} {...requiredProps} />);

    clickMapButton();

    expect(openUrl).toHaveBeenCalledWith('https://www.google.com/maps?q=-33.8688,-151.2093');
  });

  it('does not render the map button (and never calls openUrl) when GPS is absent', () => {
    // 同値分割: exif はあるが GPS が無い（未設定機種・位置情報オフ）
    const image = makeImage({
      exif: {
        dateTime: '2024:01:01 12:00:00',
        gpsLatitude: null,
        gpsLongitude: null,
        width: null,
        height: null,
      },
    });
    render(<OverlayUI image={image} {...requiredProps} />);

    expect(screen.queryByAltText('位置情報の地図')).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
