import { useState, useEffect, useRef, useCallback } from 'react';
import { getDisplayStats, resetAllDisplayCounts } from '../../lib/tauri';
import type { DisplayStats } from '../../types';
import { Check } from 'lucide-react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useT, useLocale } from '../../lib/i18n';
import { EVEN_SPREAD_MAX, percentOf, spreadOf } from '../../lib/displayCountChart';
import { CHART_HEIGHT, buildDisplayCountOptions } from './displayCountPlot';

export function GraphSection() {
  const t = useT();
  // #80: `t` 自体は常に同一の関数参照（`useT`はロケール変更時の再レンダーのみを
  // 起こす）なので、下のチャート再構築effectを言語切替に追従させるには
  // `locale` 自体を依存配列に含める必要がある。
  const locale = useLocale();
  const [displayStats, setDisplayStats] = useState<DisplayStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    try {
      setDisplayStats(await getDisplayStats());
    } catch (err) {
      console.error('Failed to load display stats:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleReset = async () => {
    if (!window.confirm(t('confirmResetDisplayCounts'))) return;

    setIsResetting(true);
    try {
      await resetAllDisplayCounts();
      await loadStats();
    } catch (err) {
      console.error('Failed to reset display counts:', err);
    } finally {
      setIsResetting(false);
    }
  };

  useEffect(() => {
    if (!chartRef.current || !displayStats || displayStats.files === 0 || isLoading) {
      return;
    }

    const host = chartRef.current;
    plotRef.current?.destroy();
    plotRef.current = new uPlot(
      buildDisplayCountOptions(displayStats, host.clientWidth, locale),
      // X軸: 表示回数 / Y軸: その回数のファイル数（ヒストグラム。#67）
      [displayStats.bins.map((bin) => bin.count), displayStats.bins.map((bin) => bin.files)],
      host,
    );

    // 設定モーダルの幅変化にも追従する（window の resize だけでは足りない）。
    let observer: InstanceType<typeof window.ResizeObserver> | null = null;
    const handleResize = () =>
      plotRef.current?.setSize({ width: host.clientWidth, height: CHART_HEIGHT });
    if (typeof window.ResizeObserver !== 'undefined') {
      observer = new window.ResizeObserver(handleResize);
      observer.observe(host);
    } else {
      window.addEventListener('resize', handleResize);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [displayStats, isLoading, locale, t]);

  if (isLoading) {
    return (
      <div className="p-4 bg-black/30 rounded-lg text-center text-white/50 text-sm">
        {t('loadingLabel')}
      </div>
    );
  }

  if (!displayStats || displayStats.files === 0) {
    return (
      <div className="p-4 bg-black/30 rounded-lg text-center text-white/50 text-sm">
        {t('noStatsData')}
      </div>
    );
  }

  const spread = spreadOf(displayStats);
  const isEven = spread <= EVEN_SPREAD_MAX;
  // 「表示済み / 全体」もヒストグラムから導く（別コマンドの get_stats を呼ばない）。
  // 全体 = 集計対象のファイル数、表示済み = 全体から「0回」の階級のファイル数を引いたもの。
  const totalImages = displayStats.files;
  const neverShown = displayStats.bins.find((bin) => bin.count === 0)?.files ?? 0;
  const displayedImages = totalImages - neverShown;
  const viewedPercent = percentOf(displayedImages, totalImages);
  const meanText = displayStats.mean.toLocaleString(locale, { maximumFractionDigits: 1 });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-black/40 rounded-lg p-3">
          <div className="text-xs text-white/50">{t('statViewedLabel')}</div>
          <div className="mt-1 font-mono text-white/80">
            <span className="text-2xl">{displayedImages.toLocaleString(locale)}</span>
            <span className="text-sm text-white/50">
              {' / '}
              {totalImages.toLocaleString(locale)}
            </span>
          </div>
          <div className="mt-2 h-0.5 rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-white/60"
              style={{ width: `${Math.min(100, viewedPercent)}%` }}
            />
          </div>
        </div>
        <div className="bg-black/40 rounded-lg p-3">
          <div className="text-xs text-white/50">{t('statAverageLabel')}</div>
          <div className="mt-1 font-mono text-2xl text-white/80">{meanText}</div>
        </div>
        <div className="bg-black/40 rounded-lg p-3">
          <div className="text-xs text-white/50">{t('statRangeLabel')}</div>
          <div className="mt-1 font-mono text-2xl text-white/80">
            {displayStats.min}
            {'\u2013'}
            {displayStats.max}
          </div>
        </div>
      </div>

      <div className="bg-black/40 rounded-lg p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-white/70">
            {t('displayCountDistributionTitle')}
          </h3>
          <span
            data-testid="fairness-badge"
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-white/70"
          >
            {isEven && <Check className="h-3 w-3" aria-hidden="true" />}
            {isEven ? t('fairnessEvenBadge') : t('fairnessSpreadBadge', { n: spread })}
          </span>
        </div>
        <div
          ref={chartRef}
          role="img"
          aria-label={t('chartAriaLabel', {
            files: displayStats.files.toLocaleString(locale),
            min: displayStats.min,
            max: displayStats.max,
            mean: meanText,
          })}
          className="w-full"
        />
        <p className="mt-3 text-xs text-white/50">{t('fairnessExplanation')}</p>

        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-white/50 hover:text-white/80 transition-colors">
            {t('viewAsTable')}
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto">
            <table className="w-full text-xs text-white/70">
              <thead className="text-white/50">
                <tr>
                  <th className="py-1 text-left font-normal">{t('axisDisplayCount')}</th>
                  <th className="py-1 text-right font-normal">{t('seriesFileCount')}</th>
                  <th className="py-1 text-right font-normal">{t('tableColumnShare')}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {displayStats.bins.map((bin) => (
                  <tr key={bin.count}>
                    <td className="py-0.5 text-left">{bin.count}</td>
                    <td className="py-0.5 text-right">{bin.files.toLocaleString(locale)}</td>
                    <td className="py-0.5 text-right">
                      {percentOf(bin.files, displayStats.files).toLocaleString(locale, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                      %
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      <button
        onClick={handleReset}
        disabled={isResetting}
        className="text-sm text-red-400/60 hover:text-red-400/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {isResetting ? t('resettingLabel') : t('resetDisplayCountsButton')}
      </button>
    </div>
  );
}
