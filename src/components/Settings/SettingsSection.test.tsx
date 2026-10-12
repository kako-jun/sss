// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const getSetting = vi.fn();
const saveSetting = vi.fn();
vi.mock('../../lib/tauri', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  saveSetting: (...args: unknown[]) => saveSetting(...args),
}));

import { SettingsSection } from './SettingsSection';
import { SETTING_APPLY_EXIF_ROTATION } from '../../constants';

// #148: apply_exif_rotation は Rust 側と同じ規則（true/false 以外は既定=ON）で解釈する。
describe('SettingsSection apply_exif_rotation (#148)', () => {
  beforeEach(() => {
    getSetting.mockReset();
    saveSetting.mockReset().mockResolvedValue(undefined);
  });

  const checkbox = () => screen.getByRole('checkbox') as HTMLInputElement;

  it.each([null, 'garbage', ''])('falls back to ON for %j', async (stored) => {
    getSetting.mockResolvedValue(stored);
    render(<SettingsSection />);
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith(SETTING_APPLY_EXIF_ROTATION));
    await waitFor(() => expect(checkbox().checked).toBe(true));
  });

  it('restores a saved false as OFF', async () => {
    getSetting.mockResolvedValue('false');
    render(<SettingsSection />);
    await waitFor(() => expect(checkbox().checked).toBe(false));
  });
});
