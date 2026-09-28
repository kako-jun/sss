// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { getLanguageSetting } from '../../lib/i18n';

const saveSetting = vi.fn();
vi.mock('../../lib/tauri', () => ({
  saveSetting: (...args: unknown[]) => saveSetting(...args),
}));

import { LanguageSection } from './LanguageSection';

/**
 * #80: 言語切替UI。これまでテストが無く、「切替の即時反映」（ストア更新→
 * この場での即時表示切替）と「永続化」（`saveSetting('language', ...)`呼び出し、
 * 失敗時の扱い）が未検証だった。ストアレベルの反映は store.test.ts でピン留め
 * 済みだが、実際のUIコンポーネントが正しい引数で呼ぶこと自体は別物として
 * ここで固定する。
 */
describe('LanguageSection (#80)', () => {
  beforeEach(() => {
    saveSetting.mockReset();
    saveSetting.mockResolvedValue(undefined);
  });

  it('shows all three options and highlights "auto" as selected by default', () => {
    render(<LanguageSection />);
    expect(screen.getByText('自動（システム）')).toBeTruthy();
    expect(screen.getByText('日本語')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();

    const autoButton = screen.getByText('自動（システム）').closest('button')!;
    expect(autoButton.className).toContain('bg-white/15');
  });

  it('clicking "ja" immediately reflects in the selected state and persists via saveSetting', async () => {
    render(<LanguageSection />);

    fireEvent.click(screen.getByText('日本語'));

    // 即時反映: クリック直後にボタンの選択状態が切り替わる
    const jaButton = screen.getByText('日本語').closest('button')!;
    expect(jaButton.className).toContain('bg-white/15');

    // 永続化: app_settings への保存が正しい引数で呼ばれる
    await waitFor(() => {
      expect(saveSetting).toHaveBeenCalledWith('language', 'ja');
    });
    expect(getLanguageSetting()).toBe('ja');
  });

  it('clicking "en" updates the store and re-renders this component\'s own labels in English immediately', async () => {
    render(<LanguageSection />);

    fireEvent.click(screen.getByText('English'));

    // このボタン群自身もuseLocale()で購読しているため、切替後は自分の表示言語も
    // 追従する（languageLabel見出し・ラベルが英語になる）。
    await waitFor(() => {
      expect(screen.getByText('Language')).toBeTruthy();
      expect(screen.getByText('Auto (system)')).toBeTruthy();
      expect(screen.getByText('English').closest('button')!.className).toContain('bg-white/15');
    });
    expect(saveSetting).toHaveBeenCalledWith('language', 'en');
  });

  it('does not roll back the UI selection when saveSetting rejects, and logs the error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    saveSetting.mockRejectedValue('dbWriteFailed');

    render(<LanguageSection />);
    fireEvent.click(screen.getByText('English'));

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to save language setting:',
        'dbWriteFailed',
      );
    });

    // 永続化に失敗しても、切替の即時反映（ストア/選択状態）は戻さない
    // （LanguageSection.tsx: handleChangeはtry/catchでconsole.errorのみ）。
    expect(screen.getByText('English').closest('button')!.className).toContain('bg-white/15');
    expect(getLanguageSetting()).toBe('en');

    consoleError.mockRestore();
  });
});
