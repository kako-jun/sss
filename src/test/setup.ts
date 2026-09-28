import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setLanguageSetting, clearOsLocaleCache } from '../lib/i18n/store';

// #80: navigator.language をテスト全体でja固定にする（jsdom既定は'en-US'。CI環境の
// OSロケールにも依存させない）。既存テストの多くは日本語UIをそのまま前提にしており、
// 明示的にjaへ固定することで#80のi18n導入前と同じ既定挙動を保つ。英語ロケールを
// 検証したいテストは各テスト内で個別に上書きする（例: App.test.tsx の
// 「App i18n (#80): language setting resolution」）。
// nodeテスト環境（jsdomでないファイル）にもNode組み込みのnavigatorが存在しうるが、
// language プロパティが無い/読み取り専用の場合もあるため失敗しても無視する。
if (typeof navigator !== 'undefined') {
  try {
    Object.defineProperty(navigator, 'language', { value: 'ja-JP', configurable: true });
  } catch {
    // node環境でnavigator.languageが上書きできない場合は無視（i18nのロケール判定は
    // jsdom環境のコンポーネントテストでのみ検証する）。
  }
}

// #80/#82: テスト間でロケール状態が漏れないよう、各テストの前に'auto'へ戻す
// （navigator.languageの既定は上のja-JP固定なので'ja'に解決される）。
// `cachedOsLocale`（#82should3: OSロケールのキャッシュ）もリセットしないと、
// あるテストがinitLocaleにgetOsLocaleを渡して設定した値が後続のテストへ
// 漏れてしまう。
beforeEach(() => {
  clearOsLocaleCache();
  setLanguageSetting('auto');
});

// #80: GraphSection.test.tsx（uPlotでチャートを描画する）向けのjsdom補完。
// uPlotはモジュール読み込み時点で`matchMedia`をグローバル関数として直接呼ぶため
// （devicePixelRatio変更の監視用）、テストファイル内のbeforeEachで用意しても
// import巻き上げにより間に合わない。jsdomはmatchMedia自体を実装していないため、
// setupFiles（テストファイルのimportより先に実行される）でここに用意する。
if (typeof window !== 'undefined' && !window.matchMedia) {
  // `MediaQueryList`はプロジェクトのeslint.config.jsのDOM型グローバル許可リストに
  // 無いため（no-undef）、`typeof window.matchMedia`経由で戻り値型を参照し、
  // 型名を裸のグローバル識別子として書かない。
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as ReturnType<typeof window.matchMedia>) as typeof window.matchMedia;
}

// Global teardown ordering matters for hooks that schedule recurring timers
// (useSlideshow runs a ~16ms progress interval). We must unmount every mounted
// component *before* restoring real timers, otherwise a queued fake-timer
// callback can leak into the real Node timer queue and fire after the jsdom
// environment is torn down ("window is not defined"). Order:
//   1. unmount React trees (effect cleanup clears the intervals)
//   2. drop any timer callback still queued under fake timers
//   3. restore real timers / mocks
afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
});
