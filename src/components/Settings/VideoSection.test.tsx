// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const getSetting = vi.fn();
const saveSetting = vi.fn();
vi.mock('../../lib/tauri', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  saveSetting: (...args: unknown[]) => saveSetting(...args),
}));

import { VideoSection } from './VideoSection';

/**
 * #68: 動画の音声ON/OFFと最大再生時間の設定UI。保存・復元・破損値の丸め・
 * ラベル関連付け(a11y)・キーボード操作(ネイティブ要素)を固定する。
 */
describe('VideoSection (#68)', () => {
  beforeEach(() => {
    getSetting.mockReset();
    saveSetting.mockReset();
    getSetting.mockResolvedValue(null);
    saveSetting.mockResolvedValue(undefined);
  });

  it('shows the defaults (audio OFF, unlimited) when nothing is saved', async () => {
    render(<VideoSection />);
    const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;
    await waitFor(() => expect(getSetting).toHaveBeenCalledTimes(2));
    expect(checkbox.checked).toBe(false);
    expect(select.value).toBe('0');
  });

  it('restores saved values', async () => {
    getSetting.mockImplementation(async (key: string) =>
      key === 'video_audio_enabled' ? 'true' : key === 'video_max_duration_sec' ? '60' : null,
    );
    render(<VideoSection />);
    const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(select.value).toBe('60');
  });

  it('rounds corrupt saved values to the defaults', async () => {
    getSetting.mockImplementation(async (key: string) =>
      key === 'video_audio_enabled' ? 'maybe' : '45',
    );
    render(<VideoSection />);
    const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;
    await waitFor(() => expect(getSetting).toHaveBeenCalledTimes(2));
    expect(checkbox.checked).toBe(false);
    expect(select.value).toBe('0');
  });

  it('toggling audio saves "true"/"false" and notifies the parent immediately', async () => {
    const onAudioChange = vi.fn();
    render(<VideoSection onAudioChange={onAudioChange} />);
    const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(onAudioChange).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('video_audio_enabled', 'true'));

    fireEvent.click(checkbox);
    expect(onAudioChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('video_audio_enabled', 'false'));
  });

  it('changing the max duration saves seconds and notifies the parent', async () => {
    const onMaxDurationChange = vi.fn();
    render(<VideoSection onMaxDurationChange={onMaxDurationChange} />);
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: '120' } });
    expect(select.value).toBe('120');
    expect(onMaxDurationChange).toHaveBeenLastCalledWith(120);
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('video_max_duration_sec', '120'));

    fireEvent.change(select, { target: { value: '0' } });
    expect(onMaxDurationChange).toHaveBeenLastCalledWith(0);
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('video_max_duration_sec', '0'));
  });

  it('offers unlimited plus 30s/1min/2min/5min options', () => {
    render(<VideoSection />);
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['無制限', '30秒', '1分', '2分', '5分']);
  });

  it('associates descriptions with the controls (a11y) and uses native focusable controls', () => {
    render(<VideoSection />);
    const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;
    const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;
    expect(checkbox.type).toBe('checkbox');
    expect(select.tagName).toBe('SELECT');
    // tabIndex未指定のネイティブ要素なのでTab/Space/矢印で操作できる
    expect(checkbox.tabIndex).toBe(0);
    expect(select.tabIndex).toBe(0);
    const describedBy = (el: HTMLElement) =>
      document.getElementById(el.getAttribute('aria-describedby')!)?.textContent;
    expect(describedBy(checkbox)).toBe('オフのときは無音で再生します');
    expect(describedBy(select)).toBe('長い動画は、この時間で次の写真・動画へ進みます');
  });

  it('keeps working (no throw) when saving fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    saveSetting.mockRejectedValue(new Error('db down'));
    render(<VideoSection />);
    fireEvent.click(screen.getByLabelText('動画の音声を再生する'));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    errorSpy.mockRestore();
  });

  // 読込完了前に操作した値を、遅れて届いた保存値で上書きしない（touched ref）。
  describe('operating before the saved values finish loading', () => {
    function deferredLoads() {
      const resolvers: Record<string, (v: string | null) => void> = {};
      getSetting.mockImplementation(
        (key: string) => new Promise<string | null>((resolve) => (resolvers[key] = resolve)),
      );
      return resolvers;
    }

    it('keeps the audio value the user toggled when a late saved "false" arrives', async () => {
      const resolvers = deferredLoads();
      render(<VideoSection />);
      const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;

      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);

      await act(async () => {
        resolvers['video_audio_enabled']('false');
        resolvers['video_max_duration_sec'](null);
      });
      expect(checkbox.checked).toBe(true);
    });

    it('keeps the max duration the user picked when a late saved "0" arrives', async () => {
      const resolvers = deferredLoads();
      render(<VideoSection />);
      const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;

      fireEvent.change(select, { target: { value: '120' } });
      expect(select.value).toBe('120');

      await act(async () => {
        resolvers['video_audio_enabled'](null);
        resolvers['video_max_duration_sec']('0');
      });
      expect(select.value).toBe('120');
    });

    it('still applies a saved value for the control the user did not touch', async () => {
      const resolvers = deferredLoads();
      render(<VideoSection />);
      const checkbox = screen.getByLabelText('動画の音声を再生する') as HTMLInputElement;
      const select = screen.getByLabelText('動画の最大再生時間') as HTMLSelectElement;

      fireEvent.click(checkbox);

      await act(async () => {
        resolvers['video_audio_enabled']('false');
        resolvers['video_max_duration_sec']('60');
      });
      expect(checkbox.checked).toBe(true);
      expect(select.value).toBe('60');
    });
  });
});
