import { useCallback, useEffect, useRef, useState } from 'react';
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
 * 反映待ちが無くなる）。ただし実行中の再スキャンが既に見ていた変更（id <= `lockedUpTo`）とは
 * 相殺しない: その再スキャンは取り消し前の状態を読んでいる可能性があり、終わった後に
 * もう一度再スキャンが要る状態を保つ。
 */
export function applyChange(
  pending: PendingChange[],
  change: ExcludeRuleChange,
  id: number,
  lockedUpTo = 0,
): PendingChange[] {
  const opposite = pending.findIndex(
    (c) => c.pattern === change.pattern && c.kind !== change.kind && c.id > lockedUpTo,
  );
  if (opposite >= 0) return pending.filter((_, i) => i !== opposite);
  return [...pending, { ...change, id }];
}

export function toNotice(pending: ExcludeRuleChange[]): ExcludeRescanNotice | null {
  if (pending.length === 0) return null;
  if (pending.length === 1) return { kind: pending[0].kind, pattern: pending[0].pattern };
  return { kind: 'multiple' };
}

/**
 * `App` が1つだけ保持する（`Settings` は開くたびに再マウントされるため、ここに置かないと
 * 閉じて開き直すだけで案内・実行中フラグ・結果が消える）。スキャン全般の単一ガード
 * （`begin`/`end`）も兼ね、除外ルールタブの再スキャンとフォルダタブのスキャンが並走しない。
 */
export function useExcludeRescan(onRefreshed: () => void) {
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [rescanning, setRescanning] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<ExcludeRescanError | null>(null);
  /** スキャン全般（除外ルールタブの再スキャン・フォルダタブのスキャン）が実行中か。UI の無効化用 */
  const [busy, setBusy] = useState(false);
  const idRef = useRef(0);
  /** スキャン実行中か（除外ルールタブの再スキャン・フォルダタブのスキャン共通） */
  const runningRef = useRef(false);
  /** 実行中のスキャンが開始時点で見ていた変更 id（実行中でなければ 0） */
  const lockedUpToRef = useRef(0);
  const mountedRef = useRef(true);
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const noteChange = useCallback((change: ExcludeRuleChange) => {
    idRef.current += 1;
    const id = idRef.current;
    const locked = lockedUpToRef.current;
    setTotal(null);
    setError(null);
    setPending((prev) => applyChange(prev, change, id, locked));
  }, []);

  /**
   * スキャンを始める。既に実行中なら null。戻り値はこの時点までに加えられた変更の id で、
   * 成功時に `clearUpTo` へ渡す（開始後に加わった変更は未反映なので消さない）。
   */
  const begin = useCallback((): number | null => {
    if (runningRef.current) return null;
    runningRef.current = true;
    if (mountedRef.current) setBusy(true);
    lockedUpToRef.current = idRef.current;
    return idRef.current;
  }, []);

  const end = useCallback(() => {
    runningRef.current = false;
    lockedUpToRef.current = 0;
    if (mountedRef.current) {
      setBusy(false);
      // 「別のスキャン実行中」の表示は、そのスキャンが終わったら消す
      setError((prev) => (prev?.kind === 'code' && prev.raw === 'scanInProgress' ? null : prev));
    }
  }, []);

  /** 成功したスキャンが見ていた変更（id <= token）を反映済みとして外す。 */
  const clearUpTo = useCallback((token: number) => {
    if (!mountedRef.current) return;
    setPending((prev) => prev.filter((c) => c.id > token));
    setTotal(null);
    setError(null);
  }, []);

  /** 完了/失敗の表示だけ消す（除外ルールタブを離れたとき。反映待ちと実行中は消さない）。 */
  const clearResult = useCallback(() => {
    setTotal(null);
    setError(null);
  }, []);

  const rescan = useCallback(async () => {
    const token = begin();
    if (token === null) {
      // 別のスキャン（フォルダタブ等）が実行中。並走させず、理由を示す。
      if (mountedRef.current) setError({ kind: 'code', raw: 'scanInProgress' });
      return;
    }
    setRescanning(true);
    setError(null);
    setTotal(null);
    try {
      const progress = await rescanLastDirectory();
      if (!mountedRef.current) return;
      if (!progress) {
        setError({ kind: 'key', key: 'failedToScanDirectory' });
        return;
      }
      setTotal(progress.totalFiles);
      setPending((prev) => prev.filter((c) => c.id > token));
      onRefreshedRef.current();
    } catch (err) {
      console.error('Failed to rescan after exclude rule change:', err);
      if (mountedRef.current) {
        setError({ kind: 'code', raw: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      end();
      if (mountedRef.current) setRescanning(false);
    }
  }, [begin, end]);

  return {
    notice: toNotice(pending),
    rescanning,
    busy,
    total,
    error,
    noteChange,
    begin,
    end,
    clearUpTo,
    clearResult,
    rescan,
  };
}

export type ExcludeRescanController = ReturnType<typeof useExcludeRescan>;
