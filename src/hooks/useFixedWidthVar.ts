import { useLayoutEffect, type RefObject } from 'react';

/**
 * #114: 1行の中で「縮む前半 + 縮まない後半」を、flex を使わずインラインで組むための補助。
 *
 * flex の子要素はブロック化されるため、選択・コピーのシリアライズでその境目に改行が入り、
 * ファイル名が `head\ntail` に割れる（#116 の「ファイル名はコピーできる」を満たせない）。
 * そこで行は通常のインライン（`white-space: nowrap; overflow: hidden`）にし、前半を
 * `inline-block; max-width: calc(100% - var(--fw))` にして、後半（`[data-fixed]`）の実測幅を
 * `--fw` に入れる。インライン連結なので選択文字列は元の文字列と完全に一致する。
 * 後半の幅は ResizeObserver で追従する（フォント読み込み・ロケール切替など）。
 */
export function useFixedWidthVar(rowRef: RefObject<HTMLElement | null>, deps: unknown[]): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const fixed = row.querySelector<HTMLElement>('[data-fixed]');
    if (!fixed) {
      row.style.removeProperty('--fw');
      return;
    }
    const apply = () =>
      row.style.setProperty('--fw', `${Math.ceil(fixed.getBoundingClientRect().width)}px`);
    apply();
    if (typeof globalThis.ResizeObserver === 'undefined') return;
    const ro = new globalThis.ResizeObserver(apply);
    ro.observe(fixed);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
