import { describe, it, expect } from 'vitest';
import { deriveEmptyStateContent, deriveBottomNotice, type EmptyStateInput } from './emptyState';
import type { Translate } from './i18n';

// 翻訳キーをそのまま返す（パラメータは JSON で添える）スタブ。文言の中身ではなく
// 「どの状態でどのキーが選ばれるか」の優先順位だけを固定する。
const t: Translate = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

const base: EmptyStateInput = {
  startupFailure: null,
  hasDirectory: true,
  notice: null,
  hasDirectoryError: false,
};

describe('deriveEmptyStateContent (#65 / #115 / #120)', () => {
  it('startupFailure wins over everything and offers retry', () => {
    const lastDir = deriveEmptyStateContent(
      {
        ...base,
        startupFailure: 'lastDirectory',
        hasDirectory: false,
        notice: { kind: 'error', message: 'x' },
      },
      t,
    );
    expect(lastDir).toEqual({
      title: 'errorLastDirectoryLoadFailed',
      subtitle: 'startupFailedSubtitle',
      canRetry: true,
    });
    expect(deriveEmptyStateContent({ ...base, startupFailure: 'initialize' }, t)?.title).toBe(
      'startupInitFailedTitle',
    );
  });

  it('shows the welcome screen only when no directory was ever configured', () => {
    expect(deriveEmptyStateContent({ ...base, hasDirectory: false }, t)).toEqual({
      title: 'welcomeTitle',
      subtitle: 'welcomeSubtitle',
    });
    // notice があっても未設定ならようこそ
    expect(
      deriveEmptyStateContent(
        { ...base, hasDirectory: false, notice: { kind: 'emptyPlaylist' } },
        t,
      )?.title,
    ).toBe('welcomeTitle');
  });

  it.each([
    [{ kind: 'emptyPlaylist' as const }, 'emptyPlaylistTitle', 'emptyPlaylistSubtitle', undefined],
    [{ kind: 'rootUnavailable' as const }, 'rootUnavailable', '', undefined],
    [{ kind: 'loadFailedGaveUp' as const }, 'loadFailedGaveUp', '', undefined],
    [
      { kind: 'noReadableImages' as const },
      'noReadableImagesTitle',
      'noReadableImagesSubtitle',
      true,
    ],
    [
      { kind: 'mediaFailureStreak' as const },
      'mediaFailureStreakTitle',
      'mediaFailureStreakSubtitle',
      true,
    ],
  ])('maps notice %j to its dedicated card', (notice, title, subtitle, canContinue) => {
    const got = deriveEmptyStateContent({ ...base, notice }, t);
    expect(got?.title).toBe(title);
    expect(got?.subtitle).toBe(subtitle);
    expect(got?.canContinue).toBe(canContinue);
    expect(got?.canRetry).toBeUndefined();
  });

  it('shows the rejection message as the subtitle of a generic error', () => {
    expect(
      deriveEmptyStateContent({ ...base, notice: { kind: 'error', message: 'boom' } }, t),
    ).toEqual({
      title: 'genericErrorTitle',
      subtitle: 'boom',
    });
  });

  it('falls back to the directory-unreachable card when only a directoryError exists', () => {
    expect(deriveEmptyStateContent({ ...base, hasDirectoryError: true }, t)).toEqual({
      title: 'directoryUnreachableTitle',
      subtitle: 'directoryUnreachableSubtitle',
    });
  });

  it('prefers a notice over the directoryError card', () => {
    expect(
      deriveEmptyStateContent(
        { ...base, hasDirectoryError: true, notice: { kind: 'rootUnavailable' } },
        t,
      )?.title,
    ).toBe('rootUnavailable');
  });

  it('returns null while loading (directory known, nothing to report)', () => {
    expect(deriveEmptyStateContent(base, t)).toBeNull();
  });
});

describe('deriveBottomNotice (#65レビュー S3)', () => {
  const none = { notice: null, mediaSkipToast: null, directoryErrorMessage: null };

  it('returns null when there is nothing to show', () => {
    expect(deriveBottomNotice(none, t)).toBeNull();
  });

  it('priority: rootUnavailable / loadFailedGaveUp / error notice > skip toast > directoryError', () => {
    const toast = { count: 3 };
    expect(
      deriveBottomNotice(
        { notice: { kind: 'rootUnavailable' }, mediaSkipToast: toast, directoryErrorMessage: 'd' },
        t,
      ),
    ).toBe('rootUnavailable');
    expect(
      deriveBottomNotice(
        { notice: { kind: 'loadFailedGaveUp' }, mediaSkipToast: toast, directoryErrorMessage: 'd' },
        t,
      ),
    ).toBe('loadFailedGaveUp');
    expect(
      deriveBottomNotice(
        {
          notice: { kind: 'error', message: 'm' },
          mediaSkipToast: toast,
          directoryErrorMessage: 'd',
        },
        t,
      ),
    ).toBe('m');
    expect(
      deriveBottomNotice({ ...none, mediaSkipToast: toast, directoryErrorMessage: 'd' }, t),
    ).toBe('mediaSkipToast:{"count":3}');
    expect(deriveBottomNotice({ ...none, directoryErrorMessage: 'd' }, t)).toBe('d');
  });

  it('does not surface notices that have their own full-screen card (emptyPlaylist etc.)', () => {
    expect(deriveBottomNotice({ ...none, notice: { kind: 'emptyPlaylist' } }, t)).toBeNull();
    expect(deriveBottomNotice({ ...none, notice: { kind: 'noReadableImages' } }, t)).toBeNull();
    expect(
      deriveBottomNotice(
        { ...none, notice: { kind: 'mediaFailureStreak' }, directoryErrorMessage: 'd' },
        t,
      ),
    ).toBe('d');
  });
});
