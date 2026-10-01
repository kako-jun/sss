import { X, Plus, RefreshCw } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import {
  getIgnorePatterns,
  removeIgnorePattern,
  addIgnorePattern,
  rescanLastDirectory,
} from '../../lib/tauri';
import type { IgnoreRule } from '../../types';
import { useT, resolveAddPatternErrorMessage, resolveScanErrorMessage } from '../../lib/i18n';

/**
 * #111: 除外ルールの追加・削除は DB に書くだけでプレイリストには反映されない
 * （反映は次の再スキャン）。反映待ちの変更を「再スキャン案内」として1件に集約して持つ。
 * 連続操作でも通知は1つのまま（1件なら具体的な文言、2件以上は総称の文言）。
 * 設定タブを切り替えてもセクションが unmount されるだけで案内が消えないよう、
 * 状態自体は親（Settings）が持つ。
 */
export type ExcludeRescanNotice =
  | { kind: 'added'; pattern: string }
  | { kind: 'removed'; pattern: string }
  | { kind: 'multiple' };

/** 既存の案内（なければ null）に新しい変更を畳み込む。2件目以降は総称の文言になる。 */
export function foldExcludeRescanNotice(
  prev: ExcludeRescanNotice | null,
  change: { kind: 'added' | 'removed'; pattern: string },
): ExcludeRescanNotice {
  return prev === null ? change : { kind: 'multiple' };
}

interface ExcludeRulesSectionProps {
  /** 反映待ちの変更（なければ null）。親が保持する */
  notice?: ExcludeRescanNotice | null;
  /** ルールを追加・削除した直後の通知 */
  onRuleChanged?: (change: { kind: 'added' | 'removed'; pattern: string }) => void;
  /**
   * 再スキャンが成功した通知。`applied` は「実行中に新たな変更が入らず、案内を消してよい」。
   * 親はプレイリスト情報の更新（`onScanComplete` 相当）と、`applied` のとき案内のクリアを行う。
   */
  onRescanned?: (applied: boolean) => void;
}

export function ExcludeRulesSection({
  notice = null,
  onRuleChanged,
  onRescanned,
}: ExcludeRulesSectionProps) {
  const t = useT();
  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [loading, setLoading] = useState(true);
  // #82レビューshould1: 確定済みの文言でなく生のエラーコードを保持し、
  // レンダーのたびに現在のロケールへ変換する（言語切替中の新旧混在防止）。
  const [addError, setAddError] = useState<string | null>(null);
  const addErrorMessage = addError === null ? null : resolveAddPatternErrorMessage(addError);
  // #111: 再スキャン（案内のボタン）の状態。失敗は生コードで保持して描画時に解決する（#82should1）。
  const [rescanning, setRescanning] = useState(false);
  const [rescanTotal, setRescanTotal] = useState<number | null>(null);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const rescanErrorMessage = rescanError === null ? null : resolveScanErrorMessage(rescanError, '');
  // 再スキャン実行中にルールが変わったら、完了しても案内を消さない（その変更は未反映）ための連番
  const changeSeqRef = useRef(0);

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

  const noteRuleChanged = (kind: 'added' | 'removed', pattern: string) => {
    changeSeqRef.current += 1;
    setRescanTotal(null);
    setRescanError(null);
    onRuleChanged?.({ kind, pattern });
  };

  // #111: 自動再スキャンにはしない（10万枚規模では重い。連続で数件直す間に何度も走らせない）。
  // 案内＋ボタンで利用者が1回にまとめて反映する。ScanSection の「スキャン」と同じ
  // 引数なしの rescanLastDirectory を使う（#93）。
  const handleRescan = async () => {
    if (rescanning) return;
    const seqAtStart = changeSeqRef.current;
    setRescanning(true);
    setRescanError(null);
    setRescanTotal(null);
    try {
      const progress = await rescanLastDirectory();
      if (progress === null) return;
      setRescanTotal(progress.totalFiles);
      onRescanned?.(changeSeqRef.current === seqAtStart);
    } catch (err) {
      console.error('Failed to rescan after exclude rule change:', err);
      setRescanError(err instanceof Error ? err.message : String(err));
    } finally {
      setRescanning(false);
    }
  };

  const handleRemove = async (pattern: string, ruleType: IgnoreRule['ruleType']) => {
    try {
      await removeIgnorePattern(pattern, ruleType);
      setRules((prev) => prev.filter((r) => !(r.pattern === pattern && r.ruleType === ruleType)));
      noteRuleChanged('removed', pattern);
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
      noteRuleChanged('added', trimmed);
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
              onClick={handleRescan}
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
