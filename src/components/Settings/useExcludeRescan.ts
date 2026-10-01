import { useCallback, useRef, useState } from 'react';
import { rescanLastDirectory } from '../../lib/tauri';
import type { MessageKey } from '../../lib/i18n';

/**
 * #111: 除外ルールの追加・削除は DB に書くだけでプレイリストには反映されない
 * （反映は次の再スキャン）。反映待ちの変更と再スキャンの進行状態を、設定画面の
 * 親（`Settings`）で持つためのフック。タブを切り替えると各セクションは unmount されるが、
 * 状態はここにあるので、再スキャン中にタブを往復しても二重実行・完了表示の取りこぼし・
 * 実行中に加えた変更の案内消去が起きない。
 */

/** 除外ルールの変更1件。`ExcludeRulesSection`（手動）と `HistorySection`（履歴から除外）が共通で通知する。 */
export interface ExcludeRuleChange {
  kind: 'added' | 'removed';
  pattern: string;
}

/** 画面に出す案内。変更が1件なら具体的な文言、2件以上は総称の文言。 */
export type ExcludeRescanNotice = ExcludeRuleChange | { kind: 'multiple' };

/** 再スキャン失敗の保持形。確定文言でなく生コード/辞書キーで持ち、描画時に解決する（#82should1）。 */
export type ExcludeRescanError = { kind: 'code'; raw: string } | { kind: 'key'; key: MessageKey };

interface PendingChange extends ExcludeRuleChange {
  id: number;
}

/**
 * 変更を畳み込む。同じパターンの追加と削除が打ち消し合う（追加→削除で元に戻った場合は
 * 反映待ちが無くなる）。逆向きの変更が複数あれば古い方から相殺する。
 */
export function applyChange(
  pending: PendingChange[],
  change: ExcludeRuleChange,
  id: number,
): PendingChange[] {
  const opposite = pending.findIndex((c) => c.pattern === change.pattern && c.kind !== change.kind);
  if (opposite >= 0) return pending.filter((_, i) => i !== opposite);
  return [...pending, { ...change, id }];
}

export function toNotice(pending: ExcludeRuleChange[]): ExcludeRescanNotice | null {
  if (pending.length === 0) return null;
  if (pending.length === 1) return { kind: pending[0].kind, pattern: pending[0].pattern };
  return { kind: 'multiple' };
}

export function useExcludeRescan(onRefreshed: () => void) {
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [rescanning, setRescanning] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<ExcludeRescanError | null>(null);
  const idRef = useRef(0);
  const runningRef = useRef(false);
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;

  const noteChange = useCallback((change: ExcludeRuleChange) => {
    idRef.current += 1;
    const id = idRef.current;
    setTotal(null);
    setError(null);
    setPending((prev) => applyChange(prev, change, id));
  }, []);

  /** 手動スキャン（フォルダタブ）の成功など、再スキャン済みになったとき。 */
  const clearAll = useCallback(() => {
    setPending([]);
    setTotal(null);
    setError(null);
  }, []);

  /** 完了/失敗の表示だけ消す（除外ルールタブを開き直したとき。反映待ちと実行中は消さない）。 */
  const clearResult = useCallback(() => {
    setTotal(null);
    setError(null);
  }, []);

  const rescan = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    // この再スキャンに間に合っている変更（id が開始時点以下）だけを、成功時に反映済みとして外す。
    const seenUpTo = idRef.current;
    setRescanning(true);
    setError(null);
    setTotal(null);
    try {
      const progress = await rescanLastDirectory();
      if (!progress) {
        setError({ kind: 'key', key: 'failedToScanDirectory' });
        return;
      }
      setTotal(progress.totalFiles);
      setPending((prev) => prev.filter((c) => c.id > seenUpTo));
      onRefreshedRef.current();
    } catch (err) {
      console.error('Failed to rescan after exclude rule change:', err);
      setError({ kind: 'code', raw: err instanceof Error ? err.message : String(err) });
    } finally {
      runningRef.current = false;
      setRescanning(false);
    }
  }, []);

  return {
    notice: toNotice(pending),
    rescanning,
    total,
    error,
    noteChange,
    clearAll,
    clearResult,
    rescan,
  };
}

export type ExcludeRescanController = ReturnType<typeof useExcludeRescan>;
