// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import type { OverlayUIHandle } from './OverlayUI';

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
const undoExclude = vi.fn();
const deletePickedImage = vi.fn();

vi.mock('../lib/tauri', () => ({
  undoExclude: (...args: unknown[]) => undoExclude(...args),
  deletePickedImage: (...args: unknown[]) => deletePickedImage(...args),
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
  isIdle: false,
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
  undoExclude.mockReset();
  deletePickedImage.mockReset();
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

describe('OverlayUI pick rejection message (#87)', () => {
  it('shows the localized message for a backend rejection code instead of a generic failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pickImage.mockRejectedValue('pathNotManaged');
    render(<OverlayUI image={makeImage()} {...requiredProps} />);
    fireEvent.click(screen.getByTitle('ピック（コピー）'));
    expect(
      await screen.findByText('このファイルはスライドショーの管理外のためコピーできません'),
    ).toBeTruthy();
  });
});

describe('OverlayUI open-in-file-manager rejection message (#92)', () => {
  it('shows a localized message when the backend rejects an unmanaged path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    openInExplorer.mockRejectedValue('pathNotManaged');
    render(<OverlayUI image={makeImage()} {...requiredProps} />);
    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('ファイルマネージャーで開く'));
    expect(
      await screen.findByText('このファイルはスライドショーの管理外のためファイラで開けません'),
    ).toBeTruthy();
  });
});

describe('OverlayUI exclude rejection message (#92)', () => {
  it('shows the localized message when the backend rejects an unmanaged path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    excludeImage.mockRejectedValue('pathNotManaged');
    render(<OverlayUI image={makeImage()} {...requiredProps} />);
    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('ファイルを除外'));
    expect(
      await screen.findByText('このファイルはスライドショーの管理外のため除外できません'),
    ).toBeTruthy();
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

    // 2回目のメッセージ自身の表示時間が経過すれば消える。ピック/除外は #78 で
    // 「取り消す」ボタン付きのトースト（6秒）になったため、残り5.8秒ぶん進める。
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(screen.queryByText('コピー完了: /picks/a.tmp')).toBeNull();

    vi.useRealTimers();
  });
});

// #66レビューmust4: `image.path.split('\\').pop() || image.path.split('/').pop()`は
// バックスラッシュが無いPOSIXパスだと「区切りが無いので元の文字列全体」を返して
// しまい、それが空でないため`||`の右辺（'/'区切り）に一切フォールバックしなかった
// （フルパスがそのままファイル名として表示される不具合）。
describe('OverlayUI fileName extraction handles POSIX paths (#66レビューmust4)', () => {
  it('shows only the basename, not the full path, for a POSIX-style path', () => {
    const image = makeImage({ path: '/photos/2024/summer/beach.jpg' });
    render(<OverlayUI image={image} {...requiredProps} />);

    expect(screen.getByText('beach.jpg')).toBeTruthy();
    expect(screen.queryByText('/photos/2024/summer/beach.jpg')).toBeNull();
  });

  it('still shows only the basename for a Windows-style backslash path', () => {
    const image = makeImage({ path: 'C:\\Users\\kako\\Pictures\\beach.jpg' });
    render(<OverlayUI image={image} {...requiredProps} />);

    expect(screen.getByText('beach.jpg')).toBeTruthy();
  });
});

// #66レビューshould: 「…」メニュー・除外サブメニューにaria-haspopup/aria-expanded
// を付け、App.tsxのグローバルESCハンドラがrefのisMenuOpen/closeMenuでメニューを
// 閉じられるようにする命令的API。
describe('OverlayUI "…" menu accessibility + imperative handle (#66レビューshould)', () => {
  it('exposes aria-haspopup/aria-expanded on the menu button, toggling with open state', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    const menuButton = screen.getByTitle('メニュー');
    expect(menuButton.getAttribute('aria-haspopup')).toBe('menu');
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(menuButton);
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('ref.isMenuOpen()/closeMenu() reflect and control the "…" menu and exclude submenu', () => {
    const ref = createRef<OverlayUIHandle>();
    const image = makeImage();
    render(<OverlayUI ref={ref} image={image} {...requiredProps} />);

    expect(ref.current?.isMenuOpen()).toBe(false);

    fireEvent.click(screen.getByTitle('メニュー'));
    expect(ref.current?.isMenuOpen()).toBe(true);

    act(() => {
      ref.current?.closeMenu();
    });
    expect(ref.current?.isMenuOpen()).toBe(false);
    expect(screen.queryByText('ファイルマネージャーで開く')).toBeNull();
  });

  it('isMenuOpen() is also true while just the exclude submenu is open', () => {
    const ref = createRef<OverlayUIHandle>();
    const image = makeImage();
    render(<OverlayUI ref={ref} image={image} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    expect(ref.current?.isMenuOpen()).toBe(true);
  });
});

// #66レビュー3巡目must: 背景幕(`fixed inset-0`)が操作バー（transformを持つ
// 祖先）の子孫だと、CSSの含有ブロックがバー自身に限定され、`inset-0`が画面
// 全体でなくバーの矩形にしかならない（写真をクリックしても閉じない回帰）。
// `createPortal`で`document.body`直下に出すことで解消した。jsdomはレイアウト
// の含有ブロック計算自体は行わないため、この単体テストでは「実際に
// document.bodyの直接の子として存在するか」という構造面だけを確認する
// （実際に画面全体をクリックして閉じることの確認は実ブラウザe2eが担当）。
describe('OverlayUI "…" menu backdrop is portaled to document.body (#66レビュー3巡目must)', () => {
  it('renders the click-to-close backdrop as a direct child of document.body, not nested inside the floating bar', () => {
    const image = makeImage();
    const { container } = render(<OverlayUI image={image} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));

    const backdrops = Array.from(document.body.children).filter(
      (el) => el.className === 'fixed inset-0 z-40',
    );
    expect(backdrops.length).toBe(1);
    // RTLがrenderしたコンテナ（コンポーネント自身のツリー）の外にある
    // ことも確認する（＝操作バーの祖先の内側ではない）。
    expect(container.contains(backdrops[0])).toBe(false);
  });

  it('closes the menu when the portaled backdrop is clicked', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    expect(screen.getByText('ファイルマネージャーで開く')).toBeTruthy();

    const backdrop = Array.from(document.body.children).find(
      (el) => el.className === 'fixed inset-0 z-40',
    )!;
    fireEvent.click(backdrop);

    expect(screen.queryByText('ファイルマネージャーで開く')).toBeNull();
  });
});

// #66レビューshould: idle中に一時停止していても手がかりを残すため、プログレス
// ラインはバー/ステータスメッセージとは独立して常時表示する（isIdleの影響を
// 受けない）。
describe('OverlayUI progress line fade rule (#66レビューshould→2巡目should1)', () => {
  // #66レビュー2巡目should1: 当初は「プログレスラインは常時表示（idleでも
  // フェードしない）」だったが、再生中にidleへ入ってもバーだけ消えて進捗線が
  // 動き続けているのは中途半端という指摘を受け、「再生中のidleはバーと同様に
  // フェードし、一時停止中のidleだけ手がかりとして残す」に変更した。
  it('fades the progress line on idle while playing (isPausedByUser=false)', () => {
    const image = makeImage();
    const { container } = render(
      <OverlayUI image={image} {...requiredProps} isIdle={true} isPausedByUser={false} />,
    );

    const progressLine = container.querySelector('.bottom-0');
    expect(progressLine).toBeTruthy();
    expect(progressLine?.className).toContain('opacity-0');
  });

  it('keeps the progress line visible on idle while paused (isPausedByUser=true)', () => {
    const image = makeImage();
    const { container } = render(
      <OverlayUI image={image} {...requiredProps} isIdle={true} isPausedByUser={true} />,
    );

    const progressLine = container.querySelector('.bottom-0');
    expect(progressLine).toBeTruthy();
    expect(progressLine?.className).not.toContain('opacity-0');
  });

  it('never fades the progress line while not idle, regardless of pause state', () => {
    const image = makeImage();
    const { container } = render(
      <OverlayUI image={image} {...requiredProps} isIdle={false} isPausedByUser={false} />,
    );

    const progressLine = container.querySelector('.bottom-0');
    expect(progressLine?.className).not.toContain('opacity-0');
  });

  it('puts opacity-0 on the bar/status wrapper when isIdle is true regardless of pause state', () => {
    const image = makeImage();
    const { container } = render(
      <OverlayUI image={image} {...requiredProps} isIdle={true} isPausedByUser={true} />,
    );

    const barPositionDiv = container.querySelector('.bottom-6');
    const fadeWrapper = barPositionDiv?.parentElement;
    expect(fadeWrapper?.className).toContain('opacity-0');
  });
});

describe('OverlayUI floating bar suppresses focus-stealing on mouse click (#66レビュー2巡目must1案a)', () => {
  // jsdomはmousedown/clickだけでは要素にフォーカスを与えないため（実ブラウザ
  // と異なり.focus()を明示しない限りactiveElementは変化しない）、「フォーカス
  // が移らないこと」自体はここでは検証できない（実ブラウザe2eが担当）。ここでは
  // `onMouseDown`のpreventDefault()が実際に呼ばれているかを、イベントの
  // defaultPrevented（dispatchEventの戻り値がfalseになること）で直接確認する。
  it('calls preventDefault() on mousedown for a button inside the floating bar', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    const nextButton = screen.getByTitle('次へ (→)');
    const notCancelled = fireEvent.mouseDown(nextButton);
    expect(notCancelled).toBe(false);
  });
});

// #66レビュー3巡目nit: 2巡目はこのpreventDefaultをバーのコンテナ1箇所に
// 付けていたため、ファイル名テキストの上でのmousedown（ドラッグ選択の起点）
// まで巻き込んで無効化してしまっていた。各`<button>`要素にのみ付ける方式に
// 変更したことで、ボタン以外の要素（ファイル名テキスト等）へのmousedownは
// 通常通り（preventDefaultされない）であることを確認する。
describe('OverlayUI mousedown guard is scoped to buttons only, not the whole bar (#66レビュー3巡目nit)', () => {
  it('does not call preventDefault() on mousedown over the filename text (text stays selectable)', () => {
    const image = makeImage({ path: '/photos/selectable-name.jpg' });
    render(<OverlayUI image={image} {...requiredProps} />);

    const fileNameSpan = screen.getByText('selectable-name.jpg');
    const notCancelled = fireEvent.mouseDown(fileNameSpan);
    expect(notCancelled).toBe(true);
  });

  // #66レビュー3巡目nit: mousedownでのpreventDefaultにより新しいボタンへは
  // フォーカスが移らない。そのままだと、Tabで別のボタンへ既に乗っていた
  // フォーカスが誰にもblurされず残り続け、idleでバーが消えなくなってしまう
  // （has-[:focus-visible]が真のまま）。同じバー内の別ボタンをマウスで
  // 押した時点で、その残留フォーカスをblurすることを固定する。
  it('blurs a different button that currently holds keyboard focus when another button is pressed with the mouse', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    const previousButton = screen.getByTitle('前へ (←)');
    const nextButton = screen.getByTitle('次へ (→)');
    previousButton.focus();
    expect(document.activeElement).toBe(previousButton);
    const blurSpy = vi.spyOn(previousButton, 'blur');

    fireEvent.mouseDown(nextButton);

    expect(blurSpy).toHaveBeenCalled();
  });

  it('does not blur the same button that is being pressed', () => {
    const image = makeImage();
    render(<OverlayUI image={image} {...requiredProps} />);

    const nextButton = screen.getByTitle('次へ (→)');
    nextButton.focus();
    const blurSpy = vi.spyOn(nextButton, 'blur');

    fireEvent.mouseDown(nextButton);

    expect(blurSpy).not.toHaveBeenCalled();
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

// #78: 除外/ピック直後の取り消しトースト。確認ダイアログは増やさず、直後の数秒だけ
// 「取り消す」を出す。
describe('OverlayUI undo toast (#78)', () => {
  const outcome = {
    pattern: '/photos/a.jpg',
    needsRescan: false,
    ruleType: 'glob',
    ruleAdded: true,
    removedPaths: ['/photos/a.jpg'],
  };

  async function excludeFile() {
    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('ファイルを除外'));
    await screen.findByText('取り消す');
  }

  it('tells the user to rescan when undoing a folder/date exclusion (#111)', async () => {
    excludeImage.mockResolvedValue({ ...outcome, pattern: '/photos/{**,*}', needsRescan: true });
    undoExclude.mockResolvedValue(undefined);
    render(<OverlayUI image={makeImage()} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('フォルダを除外'));
    await screen.findByText('取り消す');
    fireEvent.click(screen.getByText('取り消す'));

    await screen.findByText(/除外を取り消しました。再スキャンで外れた写真を戻すには/);
  });

  it('undoes an exclusion with the backend result and notifies the caller', async () => {
    excludeImage.mockResolvedValue(outcome);
    undoExclude.mockResolvedValue(undefined);
    const onExcludeUndone = vi.fn();
    render(<OverlayUI image={makeImage()} {...requiredProps} onExcludeUndone={onExcludeUndone} />);

    await excludeFile();
    fireEvent.click(screen.getByText('取り消す'));

    await screen.findByText('除外を取り消しました');
    expect(undoExclude).toHaveBeenCalledWith(outcome);
    expect(onExcludeUndone).toHaveBeenCalledTimes(1);
    // 取り消し後はボタンは消える（二重に押せない）
    expect(screen.queryByText('取り消す')).toBeNull();
  });

  it('undoes a pick by deleting only the copied file', async () => {
    pickImage.mockResolvedValue('/picks/a.jpg');
    deletePickedImage.mockResolvedValue(undefined);
    render(<OverlayUI image={makeImage()} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('ピック（コピー）'));
    await screen.findByText('コピー完了: /picks/a.jpg');
    fireEvent.click(screen.getByText('取り消す'));

    await screen.findByText('ピックを取り消しました');
    expect(deletePickedImage).toHaveBeenCalledWith('/picks/a.jpg');
  });

  it('shows an error message when the undo fails', async () => {
    excludeImage.mockResolvedValue(outcome);
    undoExclude.mockRejectedValue(new Error('boom'));
    const onExcludeUndone = vi.fn();
    render(<OverlayUI image={makeImage()} {...requiredProps} onExcludeUndone={onExcludeUndone} />);

    await excludeFile();
    fireEvent.click(screen.getByText('取り消す'));

    await screen.findByText('エラー: 取り消せませんでした');
    expect(onExcludeUndone).not.toHaveBeenCalled();
  });

  it('is not offered when the exclusion itself failed', async () => {
    excludeImage.mockRejectedValue(new Error('boom'));
    render(<OverlayUI image={makeImage()} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    fireEvent.click(screen.getByText('ファイルを除外'));
    await screen.findByText('エラー: 除外失敗');
    expect(screen.queryByText('取り消す')).toBeNull();
  });

  it('disappears by itself after a few seconds', async () => {
    vi.useFakeTimers();
    excludeImage.mockResolvedValue(outcome);
    render(<OverlayUI image={makeImage()} {...requiredProps} />);

    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    await act(async () => {
      fireEvent.click(screen.getByText('ファイルを除外'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('取り消す')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(screen.getByText('取り消す')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('取り消す')).toBeNull();
    vi.useRealTimers();
  });

  it('says nothing was undone when the exclusion added no rule and removed nothing', async () => {
    excludeImage.mockResolvedValue({ ...outcome, ruleAdded: false, removedPaths: [] });
    const onExcludeUndone = vi.fn();
    render(<OverlayUI image={makeImage()} {...requiredProps} onExcludeUndone={onExcludeUndone} />);

    await excludeFile();
    fireEvent.click(screen.getByText('取り消す'));

    await screen.findByText('戻すものはありませんでした');
    expect(screen.queryByText('除外を取り消しました')).toBeNull();
    expect(undoExclude).not.toHaveBeenCalled();
    expect(onExcludeUndone).not.toHaveBeenCalled();
  });

  async function showToastWithFakeTimers() {
    vi.useFakeTimers();
    excludeImage.mockResolvedValue(outcome);
    render(<OverlayUI image={makeImage()} {...requiredProps} />);
    fireEvent.click(screen.getByTitle('メニュー'));
    fireEvent.click(screen.getByText('除外'));
    await act(async () => {
      fireEvent.click(screen.getByText('ファイルを除外'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('取り消す')).toBeTruthy();
  }

  it('pauses the timer while hovered and resumes with the remaining time afterwards', async () => {
    await showToastWithFakeTimers();
    const toast = screen.getByRole('status');

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(screen.getByText('取り消す')).toBeTruthy();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.getByText('取り消す')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('取り消す')).toBeNull();
    vi.useRealTimers();
  });

  it('pauses the timer while the undo button has keyboard focus', async () => {
    await showToastWithFakeTimers();
    const button = screen.getByText('取り消す');

    act(() => {
      button.focus();
      vi.advanceTimersByTime(60000);
    });
    expect(screen.getByText('取り消す')).toBeTruthy();

    act(() => {
      button.blur();
      vi.advanceTimersByTime(6100);
    });
    expect(screen.queryByText('取り消す')).toBeNull();
    vi.useRealTimers();
  });

  it('stays clickable even when the overlay has faded out (idle), and survives the photo becoming null', async () => {
    excludeImage.mockResolvedValue(outcome);
    const { rerender } = render(
      <OverlayUI image={makeImage()} {...requiredProps} isIdle={false} />,
    );
    await excludeFile();

    // マウスを動かさず idle になっても、最後の1枚を除外して画像が無くなっても消えない。
    rerender(<OverlayUI image={null} {...requiredProps} isIdle={true} />);
    const button = screen.getByText('取り消す');
    let el: HTMLElement | null = button;
    while (el) {
      const style = window.getComputedStyle(el);
      expect(style.pointerEvents).not.toBe('none');
      expect(el.className).not.toMatch(/opacity-0/);
      el = el.parentElement;
    }
  });
});
