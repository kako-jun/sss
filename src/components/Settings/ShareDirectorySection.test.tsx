// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const selectDirectory = vi.fn();
const saveSetting = vi.fn();
const getDefaultShareDirectory = vi.fn();
const getShareDirectory = vi.fn();

vi.mock('../../lib/tauri', () => ({
  selectDirectory: (...args: unknown[]) => selectDirectory(...args),
  saveSetting: (...args: unknown[]) => saveSetting(...args),
  getDefaultShareDirectory: (...args: unknown[]) => getDefaultShareDirectory(...args),
  getShareDirectory: (...args: unknown[]) => getShareDirectory(...args),
}));

import { ShareDirectorySection } from './ShareDirectorySection';

function pathInput(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

beforeEach(() => {
  selectDirectory.mockReset();
  saveSetting.mockReset();
  getDefaultShareDirectory.mockReset();
  getShareDirectory.mockReset();
  getDefaultShareDirectory.mockResolvedValue('/home/me/Pictures/sss-picked');
  getShareDirectory.mockResolvedValue('/home/me/Pictures/sss-picked');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ShareDirectorySection (#87)', () => {
  it('shows the resolved share directory on load (not the raw saved value)', async () => {
    getShareDirectory.mockResolvedValue('/resolved/picked');
    render(<ShareDirectorySection />);
    await waitFor(() => expect(pathInput().value).toBe('/resolved/picked'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error instead of staying silently empty when the initial load fails', async () => {
    getShareDirectory.mockRejectedValue('boom');
    render(<ShareDirectorySection />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('ピック先を読み込めませんでした');
    expect(pathInput().value).toBe('');
  });

  it('saves the chosen directory and re-fetches the resolved path', async () => {
    render(<ShareDirectorySection />);
    await waitFor(() => expect(pathInput().value).toBe('/home/me/Pictures/sss-picked'));
    selectDirectory.mockResolvedValue('/mnt/ssd/picked');
    saveSetting.mockResolvedValue(undefined);
    getShareDirectory.mockResolvedValue('/mnt/ssd/picked');

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(pathInput().value).toBe('/mnt/ssd/picked'));
    expect(saveSetting).toHaveBeenCalledWith('share_directory_path', '/mnt/ssd/picked');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the localized rejection and keeps the old display when saving is rejected', async () => {
    render(<ShareDirectorySection />);
    await waitFor(() => expect(pathInput().value).toBe('/home/me/Pictures/sss-picked'));
    selectDirectory.mockResolvedValue('/');
    saveSetting.mockRejectedValue('shareDirectoryInvalid');

    fireEvent.click(screen.getByRole('button'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ピック先に指定できません');
    expect(pathInput().value).toBe('/home/me/Pictures/sss-picked');
  });

  it('treats a failed refresh after a successful save separately from a save failure', async () => {
    render(<ShareDirectorySection />);
    await waitFor(() => expect(pathInput().value).toBe('/home/me/Pictures/sss-picked'));
    selectDirectory.mockResolvedValue('/mnt/ssd/picked');
    saveSetting.mockResolvedValue(undefined);
    getShareDirectory.mockRejectedValue('boom');

    fireEvent.click(screen.getByRole('button'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('ピック先は保存しましたが、表示の更新に失敗しました');
    expect(pathInput().value).toBe('/home/me/Pictures/sss-picked');
  });

  it('does nothing when the dialog is cancelled', async () => {
    render(<ShareDirectorySection />);
    await waitFor(() => expect(pathInput().value).not.toBe(''));
    selectDirectory.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
    expect(saveSetting).not.toHaveBeenCalled();
  });
});
