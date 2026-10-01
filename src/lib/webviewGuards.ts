/**
 * WebView 既定の右クリックメニュー・ブラウザ系ショートカットの抑止（#116）。
 *
 * sss はネイティブアプリとして振る舞う。本番（Tauri の WebView2/WKWebView/WebKitGTK）で
 * 「再読み込み」「検証」等の既定メニューが出たり、F5/Ctrl+R で画面が作り直されたり、
 * Ctrl+P/Ctrl+S/Ctrl+U/Ctrl+F/ズームといったブラウザ機能が起動したりしないようにする。
 *
 * - 開発時（`import.meta.env.DEV`）は devtools・再読み込みを妨げないよう何も抑止しない
 *   （e2e だけ `VITE_FORCE_WEBVIEW_GUARDS=true` で本番と同じ抑止を有効にして検証する）。
 * - 抑止は `preventDefault()` のみ。`stopPropagation` はしないので、アプリ自前のショートカット
 *   （F/F11/Space/?/矢印/Esc、確認モーダルの Esc/Tab/Enter/Space）には一切影響しない。
 *   本モジュールが握る組み合わせは「修飾キー付き」か「F3/F5/F7/F12」だけで、
 *   これらは App の keydown ハンドラが元々無視する（`hasModifierKey`）か未使用のキー。
 * - Ctrl+C/V/X/Z は抑止しない。Ctrl+A は入力欄の外でだけ抑止する（`body { user-select: none }`
 *   でも select-text を付けた箇所だけがハイライトされてしまうため）。入力欄の中は通常どおり使える。
 */

/** 右クリックメニューを残す（コピー/貼り付けを使わせる）対象か。input/textarea/contentEditable。 */
export function isContextMenuAllowedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** WebView 既定の動作を起こす keydown か（本番で preventDefault する対象）。 */
export function isBlockedBrowserShortcut(e: KeyboardEvent): boolean {
  // 自動入力(autofill)などの合成イベントは key が undefined のことがある。
  const key = e.key;
  if (typeof key !== 'string') return false;
  // 修飾キー無しでも起動するもの: 再読み込み/devtools/検索の次へ/キャレットブラウズ。
  if (key === 'F5' || key === 'F12' || key === 'F3' || key === 'F7') return true;
  const ctrl = e.ctrlKey || e.metaKey;
  // Alt+←/→ はブラウザの「戻る/進む」。
  if (e.altKey && !ctrl && (key === 'ArrowLeft' || key === 'ArrowRight')) return true;
  if (!ctrl) return false;
  const k = key.toLowerCase();
  // Ctrl+R / Ctrl+Shift+R（再読み込み）、Ctrl+Shift+I/J/C（devtools）、Ctrl+U（ソース表示）、
  // Ctrl+P（印刷）、Ctrl+S（保存）、Ctrl+F/G（検索）、Ctrl+O（ファイルを開く）。
  if (['r', 'u', 'p', 's', 'f', 'g', 'o'].includes(k)) return true;
  if (e.shiftKey && ['i', 'j', 'c'].includes(k)) return true;
  // ズーム: Ctrl + / - / 0 / =（テンキー含む。US配列の + は Shift+=）。
  if (['+', '=', '-', '_', '0'].includes(key)) return true;
  if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract' || e.code === 'Numpad0') return true;
  return false;
}

export interface WebviewGuardOptions {
  /** true なら何も抑止しない（開発時）。 */
  dev: boolean;
}

/**
 * ガードを `target`（通常は document）に登録し、解除関数を返す。
 * `dev` が true の場合は何も登録しない。
 */
export function installWebviewGuards(target: Document, { dev }: WebviewGuardOptions): () => void {
  if (dev) return () => {};
  const onContextMenu = (e: MouseEvent) => {
    if (isContextMenuAllowedTarget(e.target)) return;
    e.preventDefault();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isBlockedBrowserShortcut(e)) {
      e.preventDefault();
      return;
    }
    // Ctrl+A（全選択）は入力欄の中だけ通常どおり。それ以外では、select-text を付けた箇所
    // （オーバーレイのファイル名等）だけが青くハイライトされる半端な見た目になるので抑止する。
    if (
      typeof e.key === 'string' &&
      e.key.toLowerCase() === 'a' &&
      (e.ctrlKey || e.metaKey) &&
      !isContextMenuAllowedTarget(e.target)
    ) {
      e.preventDefault();
    }
  };
  // Ctrl+ホイール / ピンチ（Chromium は ctrlKey 付き wheel として届く）によるズーム。
  // passive:false でないと preventDefault できない。
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  target.addEventListener('contextmenu', onContextMenu, true);
  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    target.removeEventListener('contextmenu', onContextMenu, true);
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('wheel', onWheel, true);
  };
}

/** main.tsx 用: 環境（dev/e2e 強制）を解決して登録する。 */
export function installDefaultWebviewGuards(): () => void {
  const forced = import.meta.env.VITE_FORCE_WEBVIEW_GUARDS === 'true';
  return installWebviewGuards(document, { dev: import.meta.env.DEV && !forced });
}
