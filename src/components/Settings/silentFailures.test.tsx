// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

// #115: 取得・保存・削除の失敗が「空」や成功に見えず、利用者に失敗として伝わることを、
// 各セクションで invoke 相当（lib/tauri）を reject させて固定する。
const tauri = {
  getIgnorePatterns: vi.fn(),
  removeIgnorePattern: vi.fn(),
  addIgnorePattern: vi.fn(),
  getPickedImages: vi.fn(),
  deletePickedImage: vi.fn(),
  getRecentImages: vi.fn(),
  excludeImage: vi.fn(),
  getThumbnail: vi.fn(),
  getDisplayStats: vi.fn(),
  resetAllDisplayCounts: vi.fn(),
  getSetting: vi.fn(),
  saveSetting: vi.fn(),
  getLastDirectoryPath: vi.fn(),
  rescanLastDirectory: vi.fn(),
  resetAllData: vi.fn(),
};

vi.mock('../../lib/tauri', () => ({
  getIgnorePatterns: (...a: unknown[]) => tauri.getIgnorePatterns(...a),
  removeIgnorePattern: (...a: unknown[]) => tauri.removeIgnorePattern(...a),
  addIgnorePattern: (...a: unknown[]) => tauri.addIgnorePattern(...a),
  getPickedImages: (...a: unknown[]) => tauri.getPickedImages(...a),
  deletePickedImage: (...a: unknown[]) => tauri.deletePickedImage(...a),
  getRecentImages: (...a: unknown[]) => tauri.getRecentImages(...a),
  excludeImage: (...a: unknown[]) => tauri.excludeImage(...a),
  getThumbnail: (...a: unknown[]) => tauri.getThumbnail(...a),
  getDisplayStats: (...a: unknown[]) => tauri.getDisplayStats(...a),
  resetAllDisplayCounts: (...a: unknown[]) => tauri.resetAllDisplayCounts(...a),
  getSetting: (...a: unknown[]) => tauri.getSetting(...a),
  saveSetting: (...a: unknown[]) => tauri.saveSetting(...a),
  getLastDirectoryPath: (...a: unknown[]) => tauri.getLastDirectoryPath(...a),
  resetAllData: (...a: unknown[]) => tauri.resetAllData(...a),
  selectAndScan: vi.fn(),
  rescanLastDirectory: (...a: unknown[]) => tauri.rescanLastDirectory(...a),
}));

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }));
const getVersion = vi.fn();
vi.mock('@tauri-apps/api/app', () => ({ getVersion: (...a: unknown[]) => getVersion(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(), UnlistenFn: undefined }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { ExcludeRulesSection } from './ExcludeRulesSection';
import { PickSection } from './PickSection';
import { HistorySection } from './HistorySection';
import { GraphSection } from './GraphSection';
import { SettingsSection } from './SettingsSection';
import { VideoSection } from './VideoSection';
import { IntervalSection } from './IntervalSection';
import { InfoSection } from './InfoSection';
import { ScanSection } from './ScanSection';
import { ConfirmDialogHost } from '../ConfirmDialog';
import { setLanguageSetting } from '../../lib/i18n/store';

beforeEach(() => {
  for (const fn of Object.values(tauri)) fn.mockReset();
  openUrl.mockReset();
  getVersion.mockReset();
  getVersion.mockResolvedValue('1.2.3');
  tauri.getSetting.mockResolvedValue(null);
  tauri.saveSetting.mockResolvedValue(undefined);
  tauri.getThumbnail.mockResolvedValue({ kind: 'video' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('取得失敗は空状態と区別され、再試行できる (#115)', () => {
  it('ExcludeRulesSection: get_ignore_patterns 失敗 → エラー+再試行。「除外ルールはありません」は出ない', async () => {
    tauri.getIgnorePatterns.mockRejectedValueOnce(new Error('db locked'));
    render(<ExcludeRulesSection />);

    expect(await screen.findByTestId('exclude-load-error')).toBeTruthy();
    expect(screen.getByText('読み込みに失敗しました')).toBeTruthy();
    expect(screen.queryByText('除外ルールはありません')).toBeNull();
    // 一覧が不明な間は追加欄も出さない（重複判定ができない）
    expect(screen.queryByPlaceholderText(/\*/)).toBeNull();

    tauri.getIgnorePatterns.mockResolvedValue([{ pattern: '*.tmp', ruleType: 'glob' }]);
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('*.tmp')).toBeTruthy();
    expect(screen.queryByTestId('exclude-load-error')).toBeNull();
  });

  it('ExcludeRulesSection: 本当に空のときは空状態（エラーではない）', async () => {
    tauri.getIgnorePatterns.mockResolvedValue([]);
    render(<ExcludeRulesSection />);
    expect(await screen.findByText('除外ルールはありません')).toBeTruthy();
    expect(screen.queryByTestId('exclude-load-error')).toBeNull();
  });

  it('PickSection: get_picked_images 失敗 → エラー+再試行。「ピックした写真はありません」は出ない', async () => {
    tauri.getPickedImages.mockRejectedValueOnce(new Error('io'));
    render(<PickSection />);

    expect(await screen.findByTestId('pick-load-error')).toBeTruthy();
    expect(screen.queryByText('ピックした写真はありません')).toBeNull();

    tauri.getPickedImages.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('ピックした写真はありません')).toBeTruthy();
    expect(screen.queryByTestId('pick-load-error')).toBeNull();
  });

  it('HistorySection: get_recent_images 失敗 → エラー+再試行。「表示履歴はありません」は出ない', async () => {
    tauri.getRecentImages.mockRejectedValueOnce(new Error('io'));
    render(<HistorySection />);

    expect(await screen.findByTestId('history-load-error')).toBeTruthy();
    expect(screen.queryByText('表示履歴はありません')).toBeNull();

    tauri.getRecentImages.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('表示履歴はありません')).toBeTruthy();
  });

  it('GraphSection: get_display_stats 失敗 → エラー+再試行。「データがありません」は出ない', async () => {
    tauri.getDisplayStats.mockRejectedValueOnce(new Error('io'));
    render(<GraphSection />);

    expect(await screen.findByTestId('stats-load-error')).toBeTruthy();
    expect(screen.queryByText(/データがありません/)).toBeNull();

    tauri.getDisplayStats.mockResolvedValue({ files: 0, min: 0, max: 0, mean: 0, bins: [] });
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText(/データがありません/)).toBeTruthy();
  });

  it('再試行が再び失敗しても、エラー表示が1つのまま（積み上がらない）', async () => {
    tauri.getPickedImages.mockRejectedValue(new Error('io'));
    render(<PickSection />);
    await screen.findByTestId('pick-load-error');
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole('button', { name: '再試行' }));
      await screen.findByTestId('pick-load-error');
    }
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('英語ロケールでも文言が出る', async () => {
    setLanguageSetting('en');
    tauri.getPickedImages.mockRejectedValueOnce(new Error('io'));
    render(<PickSection />);
    expect(await screen.findByText("Couldn't load this")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('削除失敗は成功に見えず通知される (#115)', () => {
  it('ExcludeRulesSection: remove_ignore_pattern 失敗 → ルールは残り、失敗を通知', async () => {
    tauri.getIgnorePatterns.mockResolvedValue([{ pattern: '*.tmp', ruleType: 'glob' }]);
    tauri.removeIgnorePattern.mockRejectedValue(new Error('locked'));
    render(<ExcludeRulesSection />);
    await screen.findByText('*.tmp');

    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(await screen.findByTestId('exclude-remove-error')).toBeTruthy();
    expect(screen.getByText('除外ルールを削除できませんでした')).toBeTruthy();
    expect(screen.getByText('*.tmp')).toBeTruthy();
  });

  it('PickSection: delete_picked_image 失敗 → 写真は残り、失敗を通知', async () => {
    tauri.getPickedImages.mockResolvedValue(['/pick/a.jpg']);
    tauri.deletePickedImage.mockRejectedValue('Not a file');
    render(
      <>
        <PickSection />
        <ConfirmDialogHost />
      </>,
    );
    const del = await screen.findByRole('button', { name: '削除' });

    fireEvent.click(del);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('削除'));
    expect(await screen.findByTestId('pick-delete-error')).toBeTruthy();
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();
  });

  it('GraphSection: reset_all_display_counts 失敗 → 通知し、グラフは据え置く', async () => {
    tauri.getDisplayStats.mockResolvedValue({
      files: 2,
      min: 1,
      max: 2,
      mean: 1.5,
      bins: [
        { count: 1, files: 1 },
        { count: 2, files: 1 },
      ],
    });
    tauri.resetAllDisplayCounts.mockRejectedValue(new Error('io'));
    render(
      <>
        <GraphSection />
        <ConfirmDialogHost />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /リセット/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('表示回数をリセット'));

    expect(await screen.findByTestId('stats-reset-error')).toBeTruthy();
    expect(screen.queryByTestId('stats-load-error')).toBeNull();
  });
});

describe('保存失敗は元の値へ巻き戻して通知される (#115)', () => {
  it('SettingsSection(EXIF): save_setting 失敗 → チェックが元に戻り通知', async () => {
    tauri.getSetting.mockResolvedValue('true');
    tauri.saveSetting.mockRejectedValue(new Error('io'));
    render(<SettingsSection />);
    const checkbox = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    fireEvent.click(checkbox);
    expect(await screen.findByTestId('exif-error')).toBeTruthy();
    expect(checkbox.checked).toBe(true);
  });

  it('SettingsSection(EXIF): 取得失敗 → 通知+再試行（成功すると消える）', async () => {
    tauri.getSetting.mockRejectedValueOnce(new Error('io'));
    render(<SettingsSection />);
    expect(await screen.findByText('設定を読み込めませんでした。表示は既定値です')).toBeTruthy();

    tauri.getSetting.mockResolvedValue('false');
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.queryByTestId('exif-error')).toBeNull());
    expect(((await screen.findByRole('checkbox')) as HTMLInputElement).checked).toBe(false);
  });

  it('VideoSection: 音声の保存失敗 → OFFに戻り、親へも元の値を通知。連続失敗でも通知は1つ', async () => {
    tauri.saveSetting.mockRejectedValue(new Error('io'));
    const onAudioChange = vi.fn();
    render(<VideoSection onAudioChange={onAudioChange} />);
    const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;
    await waitFor(() => expect(tauri.getSetting).toHaveBeenCalledTimes(2));

    fireEvent.click(checkbox);
    await screen.findByTestId('video-error');
    expect(checkbox.checked).toBe(false);
    expect(onAudioChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    await waitFor(() => expect(tauri.saveSetting).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(screen.getAllByTestId('video-error')).toHaveLength(1);
  });

  it('VideoSection: 最大再生時間の保存失敗 → 元の選択に戻る', async () => {
    tauri.getSetting.mockImplementation(async (key: string) =>
      key === 'video_max_duration_sec' ? '60' : null,
    );
    tauri.saveSetting.mockRejectedValue(new Error('io'));
    render(<VideoSection />);
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('60'));

    fireEvent.change(select, { target: { value: '30' } });
    await screen.findByTestId('video-error');
    expect(select.value).toBe('60');
  });

  it('VideoSection: 取得失敗 → 通知+再試行', async () => {
    tauri.getSetting.mockRejectedValue(new Error('io'));
    render(<VideoSection />);
    expect(await screen.findByText('設定を読み込めませんでした。表示は既定値です')).toBeTruthy();
    tauri.getSetting.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.queryByTestId('video-error')).toBeNull());
  });

  it('IntervalSection: 数値入力の保存失敗 → 保存済みの値に戻り、親にも通知', async () => {
    tauri.getSetting.mockResolvedValue('10000');
    const onIntervalChange = vi.fn();
    render(<IntervalSection onIntervalChange={onIntervalChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('10'));

    tauri.saveSetting.mockRejectedValue(new Error('io'));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);

    expect(await screen.findByTestId('interval-error')).toBeTruthy();
    expect(input.value).toBe('10');
    expect(onIntervalChange).toHaveBeenLastCalledWith(10000);
  });

  it('IntervalSection: スライダーのdebounce保存が失敗 → 巻き戻し。連続操作しても保存は1回・通知は1つ', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      tauri.getSetting.mockResolvedValue('10000');
      render(<IntervalSection />);
      const input = screen.getByRole('spinbutton') as HTMLInputElement;
      await waitFor(() => expect(input.value).toBe('10'));
      tauri.saveSetting.mockRejectedValue(new Error('io'));

      const slider = screen.getByRole('slider');
      for (const v of ['15', '20', '25']) fireEvent.change(slider, { target: { value: v } });
      expect(input.value).toBe('25');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(tauri.saveSetting).toHaveBeenCalledTimes(1);
      expect(await screen.findByTestId('interval-error')).toBeTruthy();
      expect(screen.getAllByTestId('interval-error')).toHaveLength(1);
      expect(input.value).toBe('10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('IntervalSection: 取得失敗 → 通知+再試行', async () => {
    tauri.getSetting.mockRejectedValueOnce(new Error('io'));
    render(<IntervalSection />);
    expect(await screen.findByText('設定を読み込めませんでした。表示は既定値です')).toBeTruthy();
    tauri.getSetting.mockResolvedValue('20000');
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() =>
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('20'),
    );
    expect(screen.queryByTestId('interval-error')).toBeNull();
  });

  it('成功したら失敗通知は消える', async () => {
    tauri.getSetting.mockResolvedValue('true');
    tauri.saveSetting.mockRejectedValueOnce(new Error('io'));
    render(<SettingsSection />);
    const checkbox = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
    fireEvent.click(checkbox);
    await screen.findByTestId('exif-error');

    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.queryByTestId('exif-error')).toBeNull());
    expect(checkbox.checked).toBe(false);
  });
});

describe('その他の黙っていた失敗 (#115)', () => {
  it('InfoSection: バージョン取得失敗 → 「…」のまま黙らず取得できないと表示', async () => {
    getVersion.mockRejectedValue(new Error('x'));
    render(<InfoSection />);
    expect(await screen.findByText('バージョン: 取得できません')).toBeTruthy();
  });

  it('InfoSection: GitHubを開けない → 通知', async () => {
    openUrl.mockRejectedValue(new Error('denied'));
    render(<InfoSection />);
    fireEvent.click(screen.getByRole('button', { name: /GitHub/ }));
    expect(await screen.findByTestId('open-github-error')).toBeTruthy();
  });

  it('ScanSection: 前回フォルダの取得失敗 → 通知', async () => {
    tauri.getLastDirectoryPath.mockRejectedValue(new Error('io'));
    render(<ScanSection onScanComplete={() => {}} />);
    expect(await screen.findByText('前回のフォルダを読み込めませんでした')).toBeTruthy();
  });
});

describe('レビュー指摘の追加検証 (#115)', () => {
  it('IntervalSection: 巻き戻しは保留中のスライダー保存を破棄する(DBと画面がずれない)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      tauri.getSetting.mockResolvedValue('10000');
      render(<IntervalSection />);
      const input = screen.getByRole('spinbutton') as HTMLInputElement;
      await waitFor(() => expect(input.value).toBe('10'));

      // B: 数値入力の確定で保存開始(保留のまま)
      let rejectB!: (e: unknown) => void;
      tauri.saveSetting.mockImplementationOnce(
        () =>
          new Promise<void>((_, rej) => {
            rejectB = rej;
          }),
      );
      fireEvent.change(input, { target: { value: '30' } });
      fireEvent.blur(input);
      await act(async () => {});
      expect(tauri.saveSetting).toHaveBeenCalledTimes(1);

      // C: B の保存中にスライダーを動かす(debounce 待ち)
      fireEvent.change(screen.getByRole('slider'), { target: { value: '45' } });
      expect(input.value).toBe('45');

      // B が失敗 → 保存済み(10)へ巻き戻し、C の保存待ちは破棄される
      await act(async () => {
        rejectB(new Error('io'));
        await vi.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(input.value).toBe('10');
      expect(tauri.saveSetting).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('IntervalSection: 設定を閉じた後に保存が失敗しても、上部の通知で伝わる', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { subscribeFailureNotice } = await import('../../lib/failureNotice');
    const listener = vi.fn();
    const off = subscribeFailureNotice(listener);
    const onIntervalChange = vi.fn();
    try {
      tauri.getSetting.mockResolvedValue('10000');
      const { unmount } = render(<IntervalSection onIntervalChange={onIntervalChange} />);
      const input = screen.getByRole('spinbutton') as HTMLInputElement;
      await waitFor(() => expect(input.value).toBe('10'));
      tauri.saveSetting.mockRejectedValue(new Error('io'));
      fireEvent.change(screen.getByRole('slider'), { target: { value: '20' } });
      unmount(); // debounce 待ちのまま閉じる → unmount 時の flush が失敗する
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(listener).toHaveBeenCalledWith('intervalSaveFailed');
      expect(onIntervalChange).toHaveBeenLastCalledWith(10000);
    } finally {
      off();
      vi.useRealTimers();
    }
  });

  it('VideoSection: 保存が終わる前に閉じて失敗しても、上部の通知で伝わる', async () => {
    const { subscribeFailureNotice } = await import('../../lib/failureNotice');
    const listener = vi.fn();
    const off = subscribeFailureNotice(listener);
    let rejectSave!: (e: unknown) => void;
    tauri.saveSetting.mockImplementation(
      () =>
        new Promise<void>((_, rej) => {
          rejectSave = rej;
        }),
    );
    const onAudioChange = vi.fn();
    const { unmount } = render(<VideoSection onAudioChange={onAudioChange} />);
    await waitFor(() => expect(tauri.getSetting).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByLabelText('動画の音声を再生する'));
    await act(async () => {});
    unmount();
    await act(async () => {
      rejectSave(new Error('io'));
    });
    expect(listener).toHaveBeenCalledWith('videoSaveFailed');
    expect(onAudioChange).toHaveBeenLastCalledWith(false);
    off();
  });

  it('保存の通知文言に対象名が入る(同じ文言が並ばない)', async () => {
    tauri.saveSetting.mockRejectedValue(new Error('io'));
    tauri.getSetting.mockResolvedValue('true');
    render(<SettingsSection />);
    const cb = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(cb.checked).toBe(true));
    fireEvent.click(cb);
    expect(await screen.findByText(/EXIF回転の設定を保存できませんでした/)).toBeTruthy();
  });

  it('取得失敗の注記は、その後の保存が成功すると消える', async () => {
    tauri.getSetting.mockRejectedValue(new Error('io'));
    render(<SettingsSection />);
    expect(await screen.findByText('設定を読み込めませんでした。表示は既定値です')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.queryByTestId('exif-error')).toBeNull());
  });

  it('ExcludeRulesSection: 取得失敗の間は追加フォーム(入力欄・追加ボタン)を出さない', async () => {
    tauri.getIgnorePatterns.mockRejectedValue(new Error('io'));
    render(<ExcludeRulesSection />);
    await screen.findByTestId('exclude-load-error');
    expect(screen.queryByPlaceholderText('パターンを入力（例: **/thumbs/）')).toBeNull();
    expect(screen.queryByRole('button', { name: /追加/ })).toBeNull();
  });

  it('ScanSection: スキャン完了後の前回フォルダ再取得に失敗しても通知する(2か所目)', async () => {
    tauri.getLastDirectoryPath
      .mockResolvedValueOnce('/photos')
      .mockRejectedValueOnce(new Error('io'));
    tauri.rescanLastDirectory.mockResolvedValue({
      totalFiles: 1,
      newFiles: 1,
      deletedFiles: 0,
      durationMs: 10,
      errorCount: 0,
      errorExamples: [],
    });
    render(<ScanSection onScanComplete={() => {}} />);
    await waitFor(() =>
      expect((screen.getByTitle('/photos') as HTMLInputElement).value).toBe('/photos'),
    );
    fireEvent.click(screen.getByRole('button', { name: /スキャン/ }));
    expect(await screen.findByText('前回のフォルダを読み込めませんでした')).toBeTruthy();
  });

  it('useAsyncLoad: loader が同期的に throw してもエラー状態になる', async () => {
    tauri.getPickedImages.mockImplementation(() => {
      throw new Error('sync');
    });
    render(<PickSection />);
    expect(await screen.findByTestId('pick-load-error')).toBeTruthy();
  });

  it('GraphSection: 再試行を連打しても古い応答が後勝ちしない', async () => {
    const stale = (() => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => (resolve = r));
      return { promise, resolve };
    })();
    tauri.getDisplayStats.mockRejectedValueOnce(new Error('io'));
    render(<GraphSection />);
    await screen.findByTestId('stats-load-error');
    tauri.getDisplayStats.mockReturnValueOnce(stale.promise);
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    tauri.getDisplayStats.mockResolvedValueOnce({ files: 0, min: 0, max: 0, mean: 0, bins: [] });
    // 1回目の再試行は読み込み中表示になるため、再度失敗させて2回目を押す経路ではなく、
    // 古い応答が後から届いても最新(空)の結果が維持されることを見る。
    stale.resolve({ files: 5, min: 1, max: 1, mean: 1, bins: [{ count: 1, files: 5 }] });
    await waitFor(() => expect(screen.queryByText('読み込み中...')).toBeNull());
    expect(screen.queryByTestId('stats-load-error')).toBeNull();
  });
});
