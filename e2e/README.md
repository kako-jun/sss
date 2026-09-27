# e2e（実ブラウザ, ローカル専用）

vitest + jsdom では再現できない、実ブラウザ固有のタイミング問題を検証するための
実ブラウザ e2e。playwright-core（devDependency、ブラウザ本体は同梱しない）で
システムにインストール済みの Chrome または Edge を headless 起動する。

対象は `#65レビュー` で見つかった2件のmust不具合:

- **M1**: `AnimatePresence mode="wait"` は前の要素の退場アニメーション(500ms)が
  終わるまで新しい `<video>` を実際にはマウントしない。isPlaying の変化を見る
  React effect は path が変わった瞬間にも発火するが、その時点ではまだ古い/空の
  `videoRef` を見ており、新要素への `play()` が一度も呼ばれず永久停止していた
  （画像→動画・動画→動画の2本目）。
- **M2**: 1件だけのプレイリスト等で同じ path が連続で返ると、`key`/`src` が
  変わらず `<img onLoad>`/`<video onEnded>` が再発火しない（タイマーが
  張られない・動画が永久に止まる）。

どちらも jsdom では `<img>`/`<video>` の読み込み・再生が実際には発生しない
（`play()`/`onload` が呼ばれない）ため、vitest の単体テストだけでは検出できず、
実ブラウザでの検証が要る。

## 実行方法

```sh
npm run e2e
```

- リポジトリルートから実行する。
- 内部で `vite`（ポート1420）を起動し、終了時に必ず kill する。**先に別の
  `npm run dev`/`npm run tauri:dev` が動いていると起動に失敗するので閉じてから
  実行すること**。
- CI には組み込まない（システムに Chrome/Edge のインストールが要るため）。

## 仕組み

- `init.js`: `page.addInitScript()` でブラウザへ注入し、
  `window.__TAURI_INTERNALS__`（Tauri の IPC 層）を薄くモックする。これにより
  Tauri ランタイム無しで `vite dev` 単体から `App.tsx` をそのまま動かせる。
  URLの `#hash` でシナリオを選ぶ（例: `http://localhost:1420/#one`）。
- `run.js`: vite dev サーバーの起動・システムブラウザの起動・各シナリオの実行・
  終了処理（vite dev サーバーの確実な kill）を行う。可視判定は `element.hidden`
  等のプロパティでなく実ブラウザの `getComputedStyle` で行う（CLAUDE.md絶対
  ルール1）。

## シナリオ一覧

| hash      | 検証内容                                                                          |
| --------- | --------------------------------------------------------------------------------- |
| `i2v_vv`  | 画像→動画→動画と回しても動画が autoplay で再生され続ける（M1の回帰）              |
| `one`     | 1件だけのプレイリストで `get_next_image` が表示間隔ごとに呼ばれ続ける（M2の回帰） |
| `welcome` | ディレクトリ未設定時の「ようこそ」画面                                            |
| `empty`   | ディレクトリ設定済みだが0件の専用案内（「ようこそ」ではない）                     |
| `unreach` | 起動時の前景スキャン失敗→「前回のフォルダを読めません」全画面案内                 |
| `toast`   | 復元成功後の背景スキャン失敗→写真を隠さない下部トースト                           |

新しいシナリオを追加する場合は `init.js` の `seqs`/`invoke` の分岐と `run.js` の
`scenarios` 配列の両方に追記する。
