import { X, Plus, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getIgnorePatterns, removeIgnorePattern, addIgnorePattern } from '../../lib/tauri';
import type { IgnoreRule } from '../../types';
import { useT, resolveAddPatternErrorMessage, resolveScanErrorMessage } from '../../lib/i18n';
import type { ExcludeRescanController } from './useExcludeRescan';

interface ExcludeRulesSectionProps {
  /**
   * #111: 再スキャン案内と再スキャンの進行状態。状態は親（Settings）が持つ
   * （タブを往復しても二重実行や完了表示の取りこぼしが起きないよう、このセクションの unmount で失わない）。
   */
  rescan?: ExcludeRescanController;
}

export function ExcludeRulesSection({ rescan }: ExcludeRulesSectionProps = {}) {
  const t = useT();
  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [loading, setLoading] = useState(true);
  // #82レビューshould1: 確定済みの文言でなく生のエラーコードを保持し、
  // レンダーのたびに現在のロケールへ変換する（言語切替中の新旧混在防止）。
  const [addError, setAddError] = useState<string | null>(null);
  const addErrorMessage = addError === null ? null : resolveAddPatternErrorMessage(addError);
  // #111: 失敗は生コード/辞書キーで保持され、描画のたびに現在のロケールへ解決する（#82should1）。
  const rescanError = rescan?.error ?? null;
  const rescanErrorMessage =
    rescanError === null
      ? null
      : rescanError.kind === 'key'
        ? t(rescanError.key)
        : resolveScanErrorMessage(rescanError.raw, '');
  const notice = rescan?.notice ?? null;
  const rescanning = rescan?.rescanning ?? false;
  const rescanTotal = rescan?.total ?? null;

  useEffect(() => {
    getIgnorePatterns()
      .then((result) => {
        setRules(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load ignore patterns:', err);
        setLoading(false);
      });
  }, []);

  const handleRemove = async (pattern: string, ruleType: IgnoreRule['ruleType']) => {
    try {
      await removeIgnorePattern(pattern, ruleType);
      setRules((prev) => prev.filter((r) => !(r.pattern === pattern && r.ruleType === ruleType)));
      rescan?.noteChange({ kind: 'removed', pattern });
    } catch (err) {
      console.error('Failed to remove ignore pattern:', err);
    }
  };

  const handleAdd = async () => {
    const trimmed = newPattern.trim();
    // 手動追加は常に glob として扱うため、同じ pattern+ruleType=glob の重複だけ弾く
    // （撮影日ルールと文字列が同じでも共存できる。#61レビュー nit の複合キー化に対応）
    if (!trimmed || rules.some((r) => r.pattern === trimmed && r.ruleType === 'glob')) return;

    try {
      // 手動追加は常に通常globルールとして扱う（撮影日ルールはオーバーレイの
      // 「撮影日付で除外」からのみ作られる）
      await addIgnorePattern(trimmed);
      setRules((prev) => [...prev, { pattern: trimmed, ruleType: 'glob' }]);
      setNewPattern('');
      setAddError(null);
      rescan?.noteChange({ kind: 'added', pattern: trimmed });
    } catch (err) {
      // #61レビュー S2: 不正なglob（閉じていない `{` 等）はバックエンドがErrを返す
      // ようになった。従来はconsole.errorに流すだけで画面上は何も起きなかったので、
      // ユーザーに失敗を伝える。
      console.error('Failed to add ignore pattern:', err);
      // #82レビューshould1: 生のコードのまま保持する（`resolveAddPatternErrorMessage`は
      // 未知の文字列に対して`addPatternFailedGeneric`へフォールバックするため、
      // 文字列でないerrはString(err)化しても実質同じ結果になる）。
      setAddError(typeof err === 'string' ? err : String(err));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAdd();
    }
  };

  if (loading) {
    // #66レビュー2巡目nit: /30→/50（他の説明/補助テキストと同じ濃さに統一）。
    return <div className="text-white/50 text-sm">{t('loadingLabel')}</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-white/70">{t('excludeRulesTitle')}</h3>
        <p className="text-xs text-white/50 mt-1">{t('excludeRulesDescription')}</p>
      </div>

      {(notice !== null || rescanning || rescanTotal !== null || rescanErrorMessage) && (
        <div
          role="status"
          className="space-y-2 p-3 bg-black/30 rounded-lg text-sm"
          data-testid="exclude-rescan-notice"
        >
          {notice !== null && (
            <p className="text-white/60">
              {notice.kind === 'added'
                ? t('excludeRuleAddedNeedsRescan', { pattern: notice.pattern })
                : notice.kind === 'removed'
                  ? t('excludeRuleRemovedNeedsRescan', { pattern: notice.pattern })
                  : t('excludeRulesChangedNeedsRescan')}
            </p>
          )}
          {rescanTotal !== null && notice === null && (
            <p className="text-white/60">
              {t('excludeRescanDone', { count: rescanTotal.toLocaleString() })}
            </p>
          )}
          {rescanErrorMessage && <p className="text-red-400/70">{rescanErrorMessage}</p>}
          {(notice !== null || rescanning) && (
            <button
              onClick={rescan?.rescan}
              disabled={rescanning}
              className="flex items-center gap-2 px-3 py-1.5 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded-lg transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-4 h-4 ${rescanning ? 'animate-spin' : ''}`} />
              {rescanning ? t('excludeRescanning') : t('excludeRescanNow')}
            </button>
          )}
        </div>
      )}

      {rules.length === 0 ? (
        <div className="text-white/50 text-sm">{t('noExcludeRules')}</div>
      ) : (
        <div className="space-y-1">
          {rules.map(({ pattern, ruleType }) => (
            <div
              key={`${pattern}-${ruleType}`}
              className="flex items-center justify-between gap-2 px-3 py-1.5 bg-black/40 rounded-lg group"
            >
              <div className="flex items-center gap-2 min-w-0">
                {ruleType === 'date' && (
                  <span className="shrink-0 px-1.5 py-0.5 text-xs leading-none rounded bg-white/10 text-white/50">
                    {t('dateRuleTag')}
                  </span>
                )}
                <span className="text-white/55 text-sm truncate" title={pattern}>
                  {pattern}
                </span>
              </div>
              <button
                onClick={() => handleRemove(pattern, ruleType)}
                // #66 問題9(#61レビュー由来): hoverのみで表示されるとキーボード/
                // タッチで見えなかった。既定でも薄く見せ、hover/focusで強調する。
                className="p-1 hover:bg-white/10 rounded-lg transition-colors shrink-0 opacity-40 group-hover:opacity-100 focus-visible:opacity-100"
                title={t('removeTooltip')}
                aria-label={t('removeTooltip')}
              >
                <X className="w-3.5 h-3.5 text-white/40 hover:text-white/70" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newPattern}
          onChange={(e) => {
            setNewPattern(e.target.value);
            setAddError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('addPatternPlaceholder')}
          className="flex-1 px-3 py-2 bg-black/40 text-white/50 rounded-lg border border-white/8 focus:outline-none focus:border-white/20 text-sm"
        />
        {/* #66視覚刷新: 主要操作（追加）はDESIGN.md「Buttons — Primary」にする。 */}
        <button
          onClick={handleAdd}
          disabled={!newPattern.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-white/90 hover:bg-white disabled:bg-white/10 disabled:text-white/30 disabled:cursor-not-allowed text-black font-medium rounded-lg transition-colors shrink-0 text-sm"
        >
          <Plus className="w-4 h-4" />
          {t('addButtonLabel')}
        </button>
      </div>
      {addErrorMessage && <div className="text-red-400/80 text-sm">{addErrorMessage}</div>}
    </div>
  );
}
