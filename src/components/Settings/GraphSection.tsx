import { useState, useEffect, useRef, useCallback } from 'react';
import { getDisplayStats, getStats, resetAllDisplayCounts } from '../../lib/tauri';
import type { Stats } from '../../types';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useT, useLocale } from '../../lib/i18n';

export function GraphSection() {
  const t = useT();
  // #80: `t` 自体は常に同一の関数参照（`useT`はロケール変更時の再レンダーのみを
  // 起こす）なので、下のチャート再構築effectを言語切替に追従させるには
  // `locale` 自体を依存配列に含める必要がある。
  const locale = useLocale();
  const [displayStats, setDisplayStats] = useState<Array<[string, number]>>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const [graphStats, summaryStats] = await Promise.all([getDisplayStats(), getStats()]);
      setDisplayStats(graphStats);
      setStats(summaryStats);
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
    if (!chartRef.current || displayStats.length === 0 || isLoading) {
      return;
    }

    // 既存のグラフを破棄
    if (plotRef.current) {
      plotRef.current.destroy();
      plotRef.current = null;
    }

    // X軸: ファイルID (0, 1, 2, ...)
    const xData = displayStats.map((_, i) => i);
    // Y軸: 表示回数
    const yData = displayStats.map(([, count]) => count);

    const data: uPlot.AlignedData = [xData, yData];

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 300,
      series: [
        {
          label: t('seriesFileId'),
        },
        {
          label: t('seriesDisplayCount'),
          stroke: 'rgba(255, 255, 255, 0.5)',
          fill: 'rgba(255, 255, 255, 0.05)',
          width: 1,
          points: {
            show: displayStats.length <= 50, // 50ファイル以下の場合のみポイント表示
          },
        },
      ],
      axes: [
        {
          label: t('axisFileIdSorted'),
          stroke: 'rgba(255,255,255,0.3)',
          labelFont: '11px sans-serif',
          labelSize: 12,
          labelGap: 8,
          grid: {
            stroke: 'rgba(255,255,255,0.05)',
            width: 1,
          },
          ticks: {
            stroke: 'rgba(255,255,255,0.1)',
            width: 1,
          },
          values: (_u: uPlot, vals: number[]) => vals.map((v: number) => Math.round(v).toString()), // 整数のみ表示
        },
        {
          label: t('seriesDisplayCount'),
          stroke: 'rgba(255,255,255,0.3)',
          labelFont: '11px sans-serif',
          labelSize: 12,
          labelGap: 8,
          grid: {
            stroke: 'rgba(255,255,255,0.05)',
            width: 1,
          },
          ticks: {
            stroke: 'rgba(255,255,255,0.1)',
            width: 1,
          },
        },
      ],
      scales: {
        x: {
          time: false,
          range: [0, displayStats.length - 1], // データ範囲を正確に設定
        },
      },
      legend: {
        show: true,
        live: false,
      },
    };

    plotRef.current = new uPlot(opts, data, chartRef.current);

    // ウィンドウリサイズ対応
    const handleResize = () => {
      if (plotRef.current && chartRef.current) {
        plotRef.current.setSize({
          width: chartRef.current.clientWidth,
          height: 300,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, [displayStats, isLoading, locale, t]);

  if (isLoading) {
    return (
      <div className="p-4 bg-black/30 rounded text-center text-white/30 text-sm border border-white/5">
        {t('loadingLabel')}
      </div>
    );
  }

  if (displayStats.length === 0) {
    return (
      <div className="p-4 bg-black/30 rounded text-center text-white/30 text-sm border border-white/5">
        {t('noStatsData')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stats && (
        <div className="flex justify-between text-white/40 text-sm">
          <span>{t('viewedFilesCountLabel')}</span>
          <span className="font-mono text-white/60">
            {stats.displayedImages.toLocaleString()} / {stats.totalImages.toLocaleString()}
          </span>
        </div>
      )}

      <div className="bg-black/30 rounded p-4 border border-white/5">
        <h3 className="text-sm font-medium text-white/50 mb-4 uppercase tracking-wider">
          {t('displayCountPerImageTitle')}
        </h3>
        <div ref={chartRef} className="w-full" />
        <div className="mt-3 text-xs text-white/25">{t('fairnessExplanation')}</div>
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
