// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getSetting = vi.fn();
const saveSetting = vi.fn();
vi.mock('../../lib/tauri', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  saveSetting: (...args: unknown[]) => saveSetting(...args),
}));

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

import { MapSection } from './MapSection';
import { SETTING_MAP_THUMBNAIL_ENABLED } from '../../constants';

const LABEL = '位置情報のある写真に地図サムネイルを表示する';

// #145: 地図サムネイルのON/OFF。既定ON、保存・復元・破損値の丸め、外部通信の説明を固定する。
describe('MapSection (#145)', () => {
  beforeEach(() => {
    getSetting.mockReset();
    saveSetting.mockReset();
    getSetting.mockResolvedValue(null);
    saveSetting.mockResolvedValue(undefined);
    openUrl.mockReset().mockResolvedValue(undefined);
  });

  it('defaults to ON when nothing is saved', async () => {
    render(<MapSection />);
    const checkbox = screen.getByLabelText(LABEL) as HTMLInputElement;
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith(SETTING_MAP_THUMBNAIL_ENABLED));
    expect(checkbox.checked).toBe(true);
  });

  it('restores a saved OFF', async () => {
    getSetting.mockResolvedValue('false');
    render(<MapSection />);
    const checkbox = screen.getByLabelText(LABEL) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it('rounds a corrupt saved value to ON', async () => {
    getSetting.mockResolvedValue('maybe');
    render(<MapSection />);
    const checkbox = screen.getByLabelText(LABEL) as HTMLInputElement;
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    expect(checkbox.checked).toBe(true);
  });

  it('saves and notifies on toggle', async () => {
    const onChange = vi.fn();
    render(<MapSection onChange={onChange} />);
    const checkbox = screen.getByLabelText(LABEL) as HTMLInputElement;
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(SETTING_MAP_THUMBNAIL_ENABLED, 'false'),
    );
    expect(onChange).toHaveBeenCalledWith(false);
    expect(checkbox.checked).toBe(false);
  });

  it('describes the external connection and what is sent', async () => {
    render(<MapSection />);
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    expect(screen.getByText(/tile\.openstreetmap\.org/)).toBeTruthy();
  });

  it('mentions standard HTTP headers in the description', async () => {
    render(<MapSection />);
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    expect(screen.getByText(/User-Agent/)).toBeTruthy();
  });

  it('has a "© OpenStreetMap contributors" link that opens the OSM copyright page', async () => {
    render(<MapSection />);
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    fireEvent.click(screen.getByText('© OpenStreetMap contributors'));
    expect(openUrl).toHaveBeenCalledWith('https://www.openstreetmap.org/copyright');
  });
});
