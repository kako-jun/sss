import { useState, useEffect, useRef } from 'react';
import { getDisplayStats, getStats } from '../../lib/tauri';
import type { Stats } from '../../types';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export function GraphSection() {
  const [displayStats, setDisplayStats] = useState<Array<[string, number]>>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    // タブが表示されるたびにデータを再読み込み（keyによる再マウント）
    const loadStats = async () => {
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
    };

    loadStats();
  }, []);

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
          label: 'ファイルID',
        },
        {
          label: '表示回数',
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
          label: 'ファイルID (A-Z順)',
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
          label: '表示回数',
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
  }, [displayStats, isLoading]);

  if (isLoading) {
    return (
      <div className="p-4 bg-black/30 rounded text-center text-white/30 text-sm border border-white/5">
        読み込み中...
      </div>
    );
  }

  if (displayStats.length === 0) {
    return (
      <div className="p-4 bg-black/30 rounded text-center text-white/30 text-sm border border-white/5">
        データがありません。スキャンを実行してください。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stats && (
        <div className="flex justify-between text-white/40 text-sm">
          <span>1回でも表示済みのファイル数:</span>
          <span className="font-mono text-white/60">
            {stats.displayedImages.toLocaleString()} / {stats.totalImages.toLocaleString()}
          </span>
        </div>
      )}

      <div className="bg-black/30 rounded p-4 border border-white/5">
        <h3 className="text-sm font-medium text-white/50 mb-4 uppercase tracking-wider">
          画像ごとの表示回数
        </h3>
        <div ref={chartRef} className="w-full" />
        <div className="mt-3 text-xs text-white/25">
          完全平等ランダムアルゴリズムが正しく動作していれば、全てのファイルが均等に表示されます
        </div>
      </div>
    </div>
  );
}
