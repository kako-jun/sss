// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// #65 問題7: 表示間隔の検証・保存タイミングをピン留めする。
// - 数値入力欄はonBlurで確定する（入力中にclampを押し付けない）
// - NaN/空はデフォルトへフォールバックする
// - スライダーのドラッグはDB書込をdebounceし、毎ステップでは書き込まない
const getSetting = vi.fn();
const saveSetting = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  saveSetting: (...args: unknown[]) => saveSetting(...args),
}));

import { IntervalSection } from './IntervalSection';
import { DEFAULT_DISPLAY_INTERVAL } from '../../constants';

beforeEach(() => {
  getSetting.mockReset();
  saveSetting.mockReset();
  getSetting.mockResolvedValue(null);
  saveSetting.mockResolvedValue(undefined);
});

function numberInput(): HTMLInputElement {
  return screen.getByRole('spinbutton') as HTMLInputElement;
}

function slider(): HTMLInputElement {
  return screen.getByRole('slider') as HTMLInputElement;
}

describe('IntervalSection number input (#65 問題7)', () => {
  it('does not clamp/save while typing, only commits on blur', async () => {
    render(<IntervalSection />);
    const input = numberInput();

    fireEvent.change(input, { target: { value: '' } });
    // 入力中は空のまま保持される（即5に置換されない）
    expect(input.value).toBe('');
    expect(saveSetting).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '3' } });
    expect(input.value).toBe('3');
    expect(saveSetting).not.toHaveBeenCalled();

    fireEvent.blur(input);
    // 3秒は最小値5未満なのでclampされる
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('display_interval', '5000'));
    expect(input.value).toBe('5');
  });

  it('falls back to the default when the field is blurred empty (NaN)', async () => {
    render(<IntervalSection />);
    const input = numberInput();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(
        'display_interval',
        String(DEFAULT_DISPLAY_INTERVAL),
      ),
    );
    expect(input.value).toBe(String(DEFAULT_DISPLAY_INTERVAL / 1000));
  });

  it('commits on Enter the same way as blur', async () => {
    render(<IntervalSection />);
    const input = numberInput();

    // 本番コードはEnterで input.blur() を呼ぶ。jsdomはフォーカスされていない要素の
    // blur()ではblurイベントを発火しないため、先に実際にフォーカスしておく。
    input.focus();
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('display_interval', '30000'));
  });

  it('notifies onIntervalChange with the clamped value on commit', async () => {
    const onIntervalChange = vi.fn();
    render(<IntervalSection onIntervalChange={onIntervalChange} />);
    const input = numberInput();

    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);

    await waitFor(() => expect(onIntervalChange).toHaveBeenCalledWith(60000));
  });
});

describe('IntervalSection slider (#65 問題7: 毎ステップDB書込しない)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('debounces the DB write across rapid slider changes instead of saving every step', async () => {
    render(<IntervalSection />);
    const range = slider();

    fireEvent.change(range, { target: { value: '10' } });
    fireEvent.change(range, { target: { value: '20' } });
    fireEvent.change(range, { target: { value: '30' } });

    // 連続変更の直後はまだ保存されていない
    expect(saveSetting).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // debounce後、最後の値だけが1回保存される
    expect(saveSetting).toHaveBeenCalledTimes(1);
    expect(saveSetting).toHaveBeenCalledWith('display_interval', '30000');
  });

  it('still updates the visible value and calls onIntervalChange immediately per step', () => {
    const onIntervalChange = vi.fn();
    render(<IntervalSection onIntervalChange={onIntervalChange} />);
    const range = slider();

    fireEvent.change(range, { target: { value: '15' } });

    expect(onIntervalChange).toHaveBeenCalledWith(15000);
    expect(range.value).toBe('15');
  });
});
