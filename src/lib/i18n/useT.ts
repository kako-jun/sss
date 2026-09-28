import { useSyncExternalStore } from 'react';
import { subscribeLocale, getLocale, type Locale } from './store';
import { t } from './t';

/** 現在のロケールを購読する（変更されたら再レンダーする）。 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/**
 * コンポーネント内で使う `t()`。ロケール変更を購読し、切替が即座に画面へ
 * 反映されるようにする（`useLocale()` を内部で呼ぶことで再レンダーを起こす。
 * `t` 自体は呼び出し時点の `getLocale()` を都度読むので常に最新）。
 */
export function useT(): typeof t {
  useLocale();
  return t;
}
