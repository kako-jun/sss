// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const setTitle = vi.fn();
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: (...a: unknown[]) => setTitle(...a) }),
}));

import { useLocaleSync } from './useLocaleSync';

beforeEach(() => {
  setTitle.mockReset().mockResolvedValue(undefined);
});

describe('useLocaleSync (#80)', () => {
  it('sets html lang and the native window title, and follows locale changes', () => {
    const { rerender } = renderHook(({ locale, title }) => useLocaleSync(locale, () => title), {
      initialProps: { locale: 'ja', title: 'スライドショー' },
    });
    expect(document.documentElement.lang).toBe('ja');
    expect(setTitle).toHaveBeenLastCalledWith('スライドショー');

    // t は locale ごとに別の関数になる（useT）。同じ参照のままなら再実行しない。
    rerender({ locale: 'en', title: 'Slideshow' });
    expect(document.documentElement.lang).toBe('en');
    expect(setTitle).toHaveBeenLastCalledWith('Slideshow');
  });

  it('logs and does not throw when setTitle rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTitle.mockRejectedValue(new Error('denied'));
    renderHook(() => useLocaleSync('ja', () => 'x'));
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('Failed to set window title:', expect.any(Error)),
    );
    errorSpy.mockRestore();
  });
});
