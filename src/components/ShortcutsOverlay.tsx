import { useRef } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { MODAL_ANIMATION_DURATION } from '../constants';

interface ShortcutsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * キーボードショートカット一覧（#66 問題4）。`?` キー、または右上のショートカット
 * ボタンで開く。Escapeでの閉じ方は`App.tsx`のグローバルキーボードハンドラが担当する
 * （設定モーダルと同じ方針で、ここでは扱わない）。
 */
export function ShortcutsOverlay({ isOpen, onClose }: ShortcutsOverlayProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const shortcuts: Array<[string, string]> = [
    ['Space', t('shortcutSpace')],
    ['← / →', t('shortcutNavigate')],
    ['F / F11', t('shortcutFullscreen')],
    ['Esc', t('shortcutEscape')],
    ['?', t('shortcutHelp')],
  ];

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
        aria-labelledby="shortcuts-heading"
        tabIndex={-1}
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: MODAL_ANIMATION_DURATION }}
        // #66レビューnit: 設定モーダルと同じ角丸(rounded-2xl)・枠線色(border-white/10)・
        // 閉じるボタン(rounded-full)に統一する。
        className="bg-neutral-950 rounded-2xl shadow-2xl p-7 max-w-md w-full mx-8 border border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 id="shortcuts-heading" className="text-lg font-medium text-white/80">
            {t('shortcutsTitle')}
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

        <dl className="space-y-3">
          {shortcuts.map(([key, description]) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <dt className="font-mono text-xs px-2 py-1 bg-white/8 border border-white/10 rounded text-white/70 whitespace-nowrap shrink-0">
                {key}
              </dt>
              <dd className="text-sm text-white/50 text-right">{description}</dd>
            </div>
          ))}
        </dl>
      </motion.div>
    </motion.div>
  );
}
