import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ScanSection } from './ScanSection';
import { IntervalSection } from './IntervalSection';
import { SettingsSection } from './SettingsSection';
import { ShareDirectorySection } from './ShareDirectorySection';
import { LanguageSection } from './LanguageSection';
import { ExcludeRulesSection } from './ExcludeRulesSection';
import { PickSection } from './PickSection';
import { HistorySection } from './HistorySection';
import { GraphSection } from './GraphSection';
import { InfoSection } from './InfoSection';
import { MODAL_ANIMATION_DURATION } from '../../constants';
import { useT } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: () => void;
  onIntervalChange?: (interval: number) => void;
  initialTab?: TabType;
}

export type TabType = 'scan' | 'options' | 'exclude' | 'pick' | 'history' | 'stats' | 'info';

// #66 視覚刷新: 7個のタブボタンをほぼ同じJSXで個別に書いていたのを配列駆動にする
// （a11yロール付与とキーボード操作を1箇所に集約するための整理も兼ねる）。
const TAB_ORDER: ReadonlyArray<{ id: TabType; labelKey: MessageKey }> = [
  { id: 'scan', labelKey: 'tabScan' },
  { id: 'options', labelKey: 'tabOptions' },
  { id: 'exclude', labelKey: 'tabExclude' },
  { id: 'pick', labelKey: 'tabPick' },
  { id: 'history', labelKey: 'tabHistory' },
  { id: 'stats', labelKey: 'tabStats' },
  { id: 'info', labelKey: 'tabInfo' },
];

export function Settings({
  isOpen,
  onClose,
  onScanComplete,
  onIntervalChange,
  initialTab,
}: SettingsProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'scan');
  const [statsKey, setStatsKey] = useState(0); // 統計グラフの強制再マウント用
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  // #66 問題9(a11y): 設定モーダルは role=dialog/aria-modal無し・フォーカストラップ
  // 無しだった（Tabで背後の写真オーバーレイへフォーカスが漏れる）。
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const selectTab = (id: TabType) => {
    setActiveTab(id);
    if (id === 'stats') setStatsKey((prev) => prev + 1); // タブを開くたびにkeyを変更して再マウント
  };

  // タブ行のキーボード操作（WAI-ARIA Tabsパターン: 矢印キー/Home/Endでロービング
  // タブインデックスを移動し、移動と同時に選択するautomatic activation方式）。
  const handleTabRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    e.preventDefault();
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (tabs.length === 0) return;
    const currentIndex = Math.max(
      0,
      tabs.findIndex((el) => el.getAttribute('aria-selected') === 'true'),
    );
    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    const nextTab = tabs[nextIndex];
    selectTab(nextTab.dataset.tabId as TabType);
    nextTab.focus();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: MODAL_ANIMATION_DURATION }}
      className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-50"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
        tabIndex={-1}
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: MODAL_ANIMATION_DURATION }}
        className="bg-neutral-950 rounded-xl shadow-2xl p-7 max-w-2xl w-full mx-8 max-h-[90vh] overflow-hidden border border-white/8 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 id="settings-heading" className="text-lg font-medium text-white/70">
            {t('settingsTitle')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('closeTooltip')}
            title={t('closeTooltip')}
            className="p-1.5 hover:bg-white/8 rounded transition-colors"
          >
            <X className="w-5 h-5 text-white/30 hover:text-white/60" />
          </button>
        </div>

        {/* タブナビゲーション。#82レビュー2巡目should1: tabScanを「フォルダ」に
            した影響で幅720（ja）だと各タブが1文字ずつ折り返る回帰が起きたため、
            ボタンは折り返さず(whitespace-nowrap flex-shrink-0)、行自体を
            横スクロール可能にする（DESIGN.md準拠の控えめなスクロールバーは
            index.cssの::-webkit-scrollbarで全要素共通適用済み）。
            #82レビュー3巡目nit: パディングをpx-4→px-3にして幅720（ja）で
            横スクロール無しに収まるようにした（狭幅では引き続きスクロール可能）。
            各ボタンにoutline-offset-[-2px]を付け、overflow-x-autoのコンテナで
            フォーカスリングの上下端が切れないようにした（負のoffsetでリングを
            要素の内側に描画する）。
            #66 問題9(a11y): role=tablist/tab・aria-selected・ロービング
            tabIndex・矢印キー移動を追加。 */}
        <div
          role="tablist"
          aria-label={t('settingsTabsLabel')}
          onKeyDown={handleTabRowKeyDown}
          className="flex gap-1 mb-6 border-b border-white/8 overflow-x-auto"
        >
          {TAB_ORDER.map(({ id, labelKey }) => {
            const selected = activeTab === id;
            return (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                data-tab-id={id}
                aria-selected={selected}
                aria-controls={`tabpanel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(id)}
                className={`px-3 py-2 text-sm transition-colors whitespace-nowrap flex-shrink-0 outline-offset-[-2px] ${
                  selected
                    ? 'text-white/80 border-b border-white/50'
                    : 'text-white/30 hover:text-white/50'
                }`}
              >
                {t(labelKey)}
              </button>
            );
          })}
        </div>

        {/* タブコンテンツ（高さ固定でタブ切替時のガタつきを防止）。各パネルに
            role=tabpanel/aria-labelledbyを付け、対応するタブと対応付ける。 */}
        <div className="flex-1 overflow-y-auto min-h-[50vh]">
          {activeTab === 'scan' && (
            <div role="tabpanel" id="tabpanel-scan" aria-labelledby="tab-scan" tabIndex={0}>
              <ScanSection onScanComplete={onScanComplete} />
            </div>
          )}
          {activeTab === 'options' && (
            <div
              role="tabpanel"
              id="tabpanel-options"
              aria-labelledby="tab-options"
              tabIndex={0}
              className="space-y-8"
            >
              <IntervalSection onIntervalChange={onIntervalChange} />
              <SettingsSection />
              <ShareDirectorySection />
              <LanguageSection />
            </div>
          )}
          {activeTab === 'exclude' && (
            <div
              role="tabpanel"
              id="tabpanel-exclude"
              aria-labelledby="tab-exclude"
              tabIndex={0}
              className="space-y-8"
            >
              <ExcludeRulesSection />
            </div>
          )}
          {activeTab === 'pick' && (
            <div
              role="tabpanel"
              id="tabpanel-pick"
              aria-labelledby="tab-pick"
              tabIndex={0}
              className="space-y-8"
            >
              <PickSection />
            </div>
          )}
          {activeTab === 'history' && (
            <div
              role="tabpanel"
              id="tabpanel-history"
              aria-labelledby="tab-history"
              tabIndex={0}
              className="space-y-8"
            >
              <HistorySection />
            </div>
          )}
          {activeTab === 'stats' && (
            <div
              role="tabpanel"
              id="tabpanel-stats"
              aria-labelledby="tab-stats"
              tabIndex={0}
              className="space-y-8"
            >
              <GraphSection key={statsKey} />
            </div>
          )}
          {activeTab === 'info' && (
            <div
              role="tabpanel"
              id="tabpanel-info"
              aria-labelledby="tab-info"
              tabIndex={0}
              className="space-y-8"
            >
              <InfoSection />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
