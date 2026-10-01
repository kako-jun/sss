// #119: アプリ内の確認モーダル用ストア。
//
// `window.confirm()` は tauri_plugin_dialog::init() が Promise を返す非同期版に
// 差し替えており、dialog 権限を付与していない（#93）ため reject される。Promise は
// 常に truthy なので `if (!confirm(...))` が素通りし、確認なしで破壊的操作が走る
// 事故が起きた。確認は必ずこのモジュールの `confirmDialog()` を `await` する。
//
// `<ConfirmDialogHost />`（App 直下）が購読して描画する。Host が未マウントの場合は
// 「キャンセル」扱い（false）で解決し、確認できないまま破壊的操作が進むことを防ぐ。

export interface ConfirmDialogOptions {
  /** 本文。`\n` は改行として表示される。 */
  message: string;
  /** OK（実行）ボタンのラベル。 */
  confirmLabel: string;
}

export interface ConfirmDialogRequest extends ConfirmDialogOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let current: ConfirmDialogRequest | null = null;
let seq = 0;
let hostCount = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConfirmDialogRequest(): ConfirmDialogRequest | null {
  return current;
}

export function isConfirmDialogOpen(): boolean {
  return current !== null;
}

/** Host のマウント/アンマウントを数える（未マウント時に false で即解決するため）。 */
export function registerConfirmDialogHost(): () => void {
  hostCount += 1;
  return () => {
    hostCount -= 1;
    if (hostCount === 0) settleConfirmDialog(false);
  };
}

/** 確認モーダルを開き、OK なら true、キャンセル/ESC/背景クリックなら false で解決する。 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (hostCount === 0) return Promise.resolve(false);
  // 既に開いている場合は先のものをキャンセル扱いにして差し替える。
  settleConfirmDialog(false);
  return new Promise<boolean>((resolve) => {
    seq += 1;
    current = { ...options, id: seq, resolve };
    emit();
  });
}

export function settleConfirmDialog(ok: boolean): void {
  const req = current;
  if (!req) return;
  current = null;
  emit();
  req.resolve(ok);
}
