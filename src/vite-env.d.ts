/// <reference types="vite/client" />

declare module '*.webp' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  /** #116: 'true' なら dev ビルドでも WebView 既定の右クリック/ショートカット抑止を有効にする（e2e 専用）。 */
  readonly VITE_FORCE_WEBVIEW_GUARDS?: string;
}
