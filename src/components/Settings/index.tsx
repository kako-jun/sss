import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ScanSection } from './ScanSection';
import { IntervalSection } from './IntervalSection';
import { SettingsSection } from './SettingsSection';
import { VideoSection } from './VideoSection';
import { ShareDirectorySection } from './ShareDirectorySection';
import { LanguageSection } from './LanguageSection';
import { ExcludeRulesSection } from './ExcludeRulesSection';
import type { ExcludeRescanController } from './useExcludeRescan';
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
  /**
   * #111: 除外ルール変更後の再スキャン案内・実行状態。Settings は開くたびに再マウントされるため、
   * 状態は App が保持して渡す（閉じて開き直しても案内・実行中・結果が残る）。
   */
  excludeRescan: ExcludeRescanController;
  onIntervalChange?: (interval: number) => void;
  /** #68: 動画の音声ON/OFFが変わったときに、再生中のスライドショーへ即時反映するための通知。 */
  onVideoAudioChange?: (enabled: boolean) => void;
  /** #68: 動画の最大再生時間（秒、0=無制限）が変わったときの通知。 */
  onVideoMaxDurationChange?: (sec: number) => void;
  initialTab?: TabType;
  /**
   * このモーダルを開いた操作がマウスクリックだったか（#66レビュー3巡目
   * should）。`useFocusTrap`へそのまま渡す。詳細はそちらのJSDoc参照。
   */
  openedViaMouse?: boolean;
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
  excludeRescan,
  onIntervalChange,
  onVideoAudioChange,
  onVideoMaxDurationChange,
  initialTab,
  openedViaMouse = false,
}: SettingsProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'scan');
  const [statsKey, setStatsKey] = useState(0); // 統計グラフの強制再マウント用
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  // #66 問題9(a11y): 設定モーダルは role=dialog/aria-modal無し・フォーカストラップ
  // 無しだった（Tabで背後の写真オーバーレイへフォーカスが漏れる）。
  useFocusTrap(panelRef, isOpen, openedViaMouse);

  if (!isOpen) return null;

  const selectTab = (id: TabType) => {
    setActiveTab(id);
    // #111: 除外ルールタブを離れるとき、見終えた完了/失敗の表示は消す（反映待ちと実行中は残す。
    // 離れている間に完了したものは消えず、戻ったときに見られる）
    if (activeTab === 'exclude' && id !== 'exclude') excludeRescan.clearResult();
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
      // #66レビュー2巡目should2: 垂直中央寄せ(items-center)だと、タブ切替で
      // 内容の高さが変わるたびにモーダル自体の上端位置が上下に動いてしまう
      // （内容に追従する高さ設計と、画面中央に固定したい見た目が両立しない）。
      // 上寄せ(items-start + pt-[12vh])にすることで、ヘッダー・タブ行の位置は
      // タブ切替に関わらず常に固定され、下端だけが内容量に応じて伸縮する。
      className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-start justify-center pt-[12vh] z-50"
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
        // #66レビュー3巡目should: マウスで開いた場合はuseFocusTrapがパネル
        // 自身（tabIndex=-1）にフォーカスする。その際にデフォルトの
        // フォーカスリングが出ないようにする（キーボードで開いた場合は閉じる
        // ボタンにフォーカスが行くのでこの見た目には関係しない）。
        // `!outline-none`（important修飾）が必要な理由: index.cssの
        // `[tabindex]:focus-visible { outline: ...; }` は属性セレクタ+疑似
        // クラスで詳細度(0,2,0)を持ち、Tailwindの素の`.outline-none`
        // （詳細度(0,1,0)）より高いため、importantを付けないと負けて
        // リングが出てしまう（実ブラウザe2eで確認済み）。
        className="bg-neutral-950 rounded-2xl shadow-2xl p-7 max-w-2xl w-full mx-8 max-h-[76vh] overflow-hidden border border-white/10 flex flex-col !outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 id="settings-heading" className="text-lg font-medium text-white/80">
            {t('settingsTitle')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('closeTooltip')}
            title={t('closeTooltip')}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors"
          >
            <X className="w-5 h-5" />
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
                // #66レビュー2巡目nit: 非選択タブの文字色を/40→/50に
                // （言語セグメントの非選択と揃える。DESIGN.mdのテキスト階層に
                // 合わせて統一）。
                className={`px-3 py-2 text-sm transition-colors whitespace-nowrap flex-shrink-0 outline-offset-[-2px] ${
                  selected
                    ? 'text-white/90 font-medium border-b-2 border-white/80'
                    : 'text-white/50 hover:text-white/70 border-b-2 border-transparent'
                }`}
              >
                {t(labelKey)}
              </button>
            );
          })}
        </div>

        {/* タブコンテンツ。#66視覚刷新: 旧50vhの固定最小高は短い内容のタブ
            （フォルダ・オプション等）でもモーダルが常に画面の半分を占めて
            間延びして見えた。#66レビューshould: 控えめな最小高（260px）に
            縮めても「固定値を置く」こと自体が内容追従の原則に反するため撤廃し、
            完全に内容の高さへ追従させる（タブ切替時の見た目のガタつきより、
            短い内容のタブが間延びして見えることの方を避ける）。最大は
            モーダル自体のmax-h-[76vh]に任せてスクロールする（#66レビュー
            2巡目should2: 上寄せpt-[12vh]と合わせて下端にも同程度の余白が
            残るように80vh→76vhへ調整）。各パネルに role=tabpanel/
            aria-labelledbyを付け、対応するタブと対応付ける。 */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'scan' && (
            <div role="tabpanel" id="tabpanel-scan" aria-labelledby="tab-scan" tabIndex={0}>
              <ScanSection onScanComplete={onScanComplete} guard={excludeRescan} />
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
              <VideoSection
                onAudioChange={onVideoAudioChange}
                onMaxDurationChange={onVideoMaxDurationChange}
              />
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
              <ExcludeRulesSection rescan={excludeRescan} />
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
              <HistorySection onRuleChanged={excludeRescan.noteChange} />
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
