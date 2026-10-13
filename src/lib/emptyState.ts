import type { SlideshowNotice } from '../hooks/useSlideshow';
import type { Translate } from './i18n';
import type { StartupFailureKind } from './startup';

export type EmptyStateContent = {
  title: string;
  subtitle: string;
  canContinue?: boolean;
  canRetry?: boolean;
};

/** 全画面の案内画面を出す起動失敗（'settings' は既定値で続行するので対象外） */
export type StartupFailureScreen = Exclude<StartupFailureKind, 'settings'>;

export type EmptyStateInput = {
  startupFailure: StartupFailureScreen | null;
  hasDirectory: boolean;
  notice: SlideshowNotice | null;
  /** 起動時スキャン失敗の有無（文言ではなく有無だけを見る） */
  hasDirectoryError: boolean;
};

/**
 * 画像が無いときの全画面案内の内容を導出する（#65）。
 * 「ようこそ」は本当に未設定（ディレクトリが一度も設定されていない）の時だけ出す。
 * 設定済みだが空/接続不可/読込失敗の場合は専用の案内にする。
 * 表示するものが無い（読込中）ときは null。
 */
export function deriveEmptyStateContent(
  input: EmptyStateInput,
  t: Translate,
): EmptyStateContent | null {
  const { startupFailure, hasDirectory, notice, hasDirectoryError } = input;
  if (startupFailure !== null) {
    return {
      title:
        startupFailure === 'lastDirectory'
          ? t('errorLastDirectoryLoadFailed')
          : t('startupInitFailedTitle'),
      subtitle: t('startupFailedSubtitle'),
      canRetry: true,
    };
  }
  if (!hasDirectory) {
    return { title: t('welcomeTitle'), subtitle: t('welcomeSubtitle') };
  }
  if (notice?.kind === 'emptyPlaylist') {
    return { title: t('emptyPlaylistTitle'), subtitle: t('emptyPlaylistSubtitle') };
  }
  if (notice?.kind === 'rootUnavailable') {
    return { title: t('rootUnavailable'), subtitle: '' };
  }
  if (notice?.kind === 'loadFailedGaveUp') {
    return { title: t('loadFailedGaveUp'), subtitle: '' };
  }
  if (notice?.kind === 'noReadableImages') {
    return {
      title: t('noReadableImagesTitle'),
      subtitle: t('noReadableImagesSubtitle'),
      canContinue: true,
    };
  }
  if (notice?.kind === 'mediaFailureStreak') {
    return {
      title: t('mediaFailureStreakTitle'),
      subtitle: t('mediaFailureStreakSubtitle'),
      canContinue: true,
    };
  }
  if (notice?.kind === 'error') {
    return { title: t('genericErrorTitle'), subtitle: notice.message };
  }
  // #65レビュー修正: restorePlaylist失敗→前景rescanLastDirectory自体が失敗した場合、
  // initialize() が一度も呼ばれないため notice はずっと null のまま。hasDirectory は
  // 既に true なので「ようこそ」ではなく専用の案内にする。
  if (hasDirectoryError) {
    return {
      title: t('directoryUnreachableTitle'),
      subtitle: t('directoryUnreachableSubtitle'),
    };
  }
  return null;
}

export type BottomNoticeInput = {
  notice: SlideshowNotice | null;
  mediaSkipToast: { count: number } | null;
  /** 現在のロケールへ解決済みの起動時ディレクトリエラー文言 */
  directoryErrorMessage: string | null;
};

/**
 * 画像表示中に出す控えめな下部トーストの文言を導出する（#65レビュー修正・S3）。
 * notice（rootUnavailable/loadFailedGaveUp/error）を最優先にし、次にスキップ通知、
 * 最後に directoryError（同時に出て重なるのを防ぐ）。
 */
export function deriveBottomNotice(input: BottomNoticeInput, t: Translate): string | null {
  const { notice, mediaSkipToast, directoryErrorMessage } = input;
  if (notice?.kind === 'rootUnavailable') return t('rootUnavailable');
  if (notice?.kind === 'loadFailedGaveUp') return t('loadFailedGaveUp');
  if (notice?.kind === 'error') return notice.message;
  if (mediaSkipToast) return t('mediaSkipToast', { count: mediaSkipToast.count });
  return directoryErrorMessage;
}
