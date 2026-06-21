# アーキテクチャ

sss（Smart Slide Show）の内部構造を実装に即してまとめたドキュメントです。新機能の追加・既存機能の修正時に、どのレイヤ・どのモジュールを触ればよいかの地図として使います。

## 1. 概要

sss は、10万枚規模の写真・動画コレクションを **完全平等ランダム** で再生するデスクトップ向けスライドショーアプリです。「ランダム表示なのに同じ写真ばかり出る」問題を、シャッフルベースのプレイリストで解決し、すべての写真に均等な出番を与えます。

### 技術スタック

| 層                 | 技術                                                   |
| ------------------ | ------------------------------------------------------ |
| デスクトップシェル | Tauri v2                                               |
| フロントエンド     | React 19 + TypeScript + Vite                           |
| UI                 | Tailwind CSS / framer-motion / lucide-react / uPlot    |
| バックエンド       | Rust                                                   |
| 永続化             | SQLite（rusqlite）                                     |
| 画像処理           | image / kamadak-exif                                   |
| ファイル走査       | walkdir + rayon（並列メタデータ取得）+ globset（除外） |

## 2. レイヤ構成

フロントエンド（React）とバックエンド（Rust）は Tauri の IPC（`invoke` / イベント）を介して通信します。フロントエンドはファイルシステムや DB に直接触らず、すべての永続化・走査・画像処理はバックエンドが担います。

```
┌──────────────────────────────────────────────────────────┐
│  React フロントエンド（WebView）                          │
│    App.tsx ─ Slideshow / OverlayUI / Settings/*           │
│    hooks（useSlideshow / useMouseIdle）                    │
│    lib/tauri.ts（IPC ラッパ）                              │
└───────────────┬──────────────────────────────────────────┘
                │  Tauri IPC
                │   ・invoke(command, args)  … 要求/応答
                │   ・listen("scan-progress") … 進捗イベント
                │   ・convertFileSrc(path)    … ローカル画像の表示
┌───────────────┴──────────────────────────────────────────┐
│  Rust バックエンド                                         │
│    commands/*（IPC コマンドの入口）                       │
│    AppState（db / playlist / directory_path / cache_dir）  │
│    playlist / scanner / image_processor / ignore / database│
└───────────────┬──────────────────────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
   SQLite（sss.db）   ファイルシステム
   ・メタデータ        ・写真/動画の原本（読み取り）
   ・表示統計          ・キャッシュ（4K縮小/EXIF回転済）
   ・除外ルール        ・ピックフォルダ（sss-picked）
   ・設定/スキャン履歴
```

各層の責務:

- **React フロントエンド**: 表示・ユーザー操作・タイマー進行のみを持つ。状態（現在の画像・再生中フラグ・進捗）は React 側に、永続データはすべてバックエンド側に置く。
- **Tauri IPC**: フロントとバックの唯一の境界。コマンド呼び出し（`invoke`）と、長時間処理の進捗通知（`scan-progress` イベント）の2系統。
- **Rust バックエンド**: ファイル走査・差分検出・画像最適化・統計・設定永続化を担う。アプリ全体の可変状態は `AppState`（`Mutex` で保護）に集約する。
- **SQLite / ファイルシステム**: メタデータ・統計・設定は SQLite に、画像原本は読み取り専用、加工済み画像は起動時クリアされるキャッシュに置く。

## 3. モジュール責務表

### バックエンド（`src-tauri/src/`）

| モジュール                    | 責務                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.rs`                     | Tauri アプリの初期化。プラグイン登録、`AppState` 構築（DB・キャッシュ生成、起動時キャッシュクリア、keep-awake）、`invoke_handler` への全コマンド登録 |
| `commands/types.rs`           | `AppState`（共有可変状態）と IPC で受け渡す型（`ScanProgress` / `Stats`）の定義                                                                      |
| `commands/scan.rs`            | ディレクトリ走査コマンド。差分スキャン実行 → DB 更新 → プレイリスト構築/更新 → `last_directory_path` 保存。旧 `~/.sssignore` の DB 移行も担う        |
| `commands/image.rs`           | プレイリスト遷移（次へ/前へ）。表示回数の加算、5枚先の先読みキャッシュ、`ImageInfo`（サイズ・EXIF・統計）の組み立て                                  |
| `commands/file_operations.rs` | ファイラ起動、ピック（コピー）、除外ルール CRUD、画像除外、最近表示一覧、ピック済み一覧/削除、表示回数リセット                                       |
| `commands/stats.rs`           | 統計取得（総数/表示済み数）、プレイリスト状態（位置/総数/戻れるか）、グラフ用の表示回数一覧                                                          |
| `commands/settings.rs`        | 設定の保存/取得、前回ディレクトリパスの取得                                                                                                          |
| `commands/system.rs`          | アプリ終了、全データ初期化（DB・キャッシュ削除）                                                                                                     |
| `playlist.rs`                 | **完全平等ランダムの正本**。シャッフル済みリスト・現在位置・最大100件の閲覧履歴を持つ `Playlist` struct。前後移動・末尾到達時の再シャッフルを管理    |
| `scanner.rs`                  | `walkdir` でのメディアファイル収集（画像/動画拡張子で判定）と `rayon` 並列メタデータ取得。`mtime`+`size` による差分検出（新規/変更/削除）            |
| `image_processor.rs`          | 画像の 4K リサイズ + EXIF Orientation 補正、画像寸法取得、EXIF（撮影日時・GPS・寸法）抽出、動画判定                                                  |
| `ignore.rs`                   | `globset` ベースの除外フィルタ。フルパスと各パスコンポーネントの両方でマッチ判定                                                                     |
| `database.rs`                 | SQLite ラッパ。スキーマ初期化（6テーブル）、メタデータ/統計/除外ルール/設定/スキャン履歴の読み書き、旧スキーマからのマイグレーション                 |

### フロントエンド（`src/`）

| モジュール                                      | 責務                                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx`                                       | アプリのオーケストレーション。起動時初期化（設定読込→前回フォルダの差分スキャン→プレイリスト初期化）、フルスクリーン同期、キーボードショートカット（←/→/ESC）、ホバー/設定画面での自動一時停止 |
| `components/Slideshow.tsx`                      | 現在の画像/動画を全画面表示。`optimizedPath` 優先で `convertFileSrc` 化、framer-motion でクロスフェード                                                                                        |
| `components/OverlayUI.tsx`                      | 操作オーバーレイ（前/次・再生一時停止・ピック・除外・ファイラで開く・EXIF/位置情報表示）。マウスアイドルでフェードアウト                                                                       |
| `components/Settings/index.tsx`                 | 設定モーダルのタブ管理（scan / options / exclude / pick / history / stats / info）                                                                                                             |
| `components/Settings/ScanSection.tsx`           | フォルダ選択・スキャン実行・進捗表示                                                                                                                                                           |
| `components/Settings/IntervalSection.tsx`       | 表示間隔（秒）の設定                                                                                                                                                                           |
| `components/Settings/SettingsSection.tsx`       | EXIF 自動回転の ON/OFF など表示オプション                                                                                                                                                      |
| `components/Settings/ShareDirectorySection.tsx` | ピック先フォルダの設定                                                                                                                                                                         |
| `components/Settings/ExcludeRulesSection.tsx`   | 除外ルール（glob パターン）の一覧・追加・削除                                                                                                                                                  |
| `components/Settings/PickSection.tsx`           | ピック済み画像の一覧・削除                                                                                                                                                                     |
| `components/Settings/HistorySection.tsx`        | 最近表示した画像の一覧と、そこからの除外操作                                                                                                                                                   |
| `components/Settings/GraphSection.tsx`          | 表示回数の分布グラフ（uPlot）と表示回数リセット                                                                                                                                                |
| `components/Settings/InfoSection.tsx`           | アプリ情報・GitHub リンク・全データ初期化                                                                                                                                                      |
| `hooks/useSlideshow.ts`                         | スライドショーの状態（現在画像・再生中・進捗）と自動進行タイマー。動画はタイマーでなく `onEnded` で次へ                                                                                        |
| `hooks/useMouseIdle.ts`                         | マウス無操作の検知（既定3秒）。オーバーレイの表示/非表示を制御                                                                                                                                 |
| `lib/tauri.ts`                                  | 全 IPC コマンドの型付きラッパ群とディレクトリ選択ダイアログ                                                                                                                                    |
| `constants.ts`                                  | 表示間隔の既定/下限/上限、モーダルアニメーション時間                                                                                                                                           |
| `types.ts`                                      | フロント側の型定義（`ImageInfo` / `ExifInfo` / `ScanProgress` / `Stats` / `RecentImage`）                                                                                                      |

## 4. IPC コマンド一覧

`main.rs` の `invoke_handler` に登録された全 22 コマンドをドメイン別に示します（フロントからは `src/lib/tauri.ts` 経由で呼ばれます）。

### scan（走査）

| コマンド         | 役割                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `scan_directory` | ディレクトリを差分スキャンして DB を更新し、プレイリストを構築/更新する。進捗は `scan-progress` イベントで通知 |

### image（プレイリスト遷移）

| コマンド             | 役割                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `get_next_image`     | 次の画像へ進める。新規画像なら表示回数を +1 し、5枚先まで先読みキャッシュ。`ImageInfo` を返す |
| `get_previous_image` | 履歴を1つ戻る（表示回数は加算しない）。`ImageInfo` を返す                                     |

### file_operations（ピック / 除外 / 削除 / ファイラ / 履歴）

| コマンド                      | 役割                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `open_in_explorer`            | OS のファイラで画像を選択状態で開く（Windows/macOS/Linux 別実装）                                         |
| `pick_image`                  | 画像をピックフォルダ（既定 `Pictures/sss-picked`）へコピー。同名は時刻付与で衝突回避                      |
| `exclude_image`               | 画像を `date`/`file`/`directory` のいずれかで除外ルール化（DB へ追加）。`file` は即プレイリストからも除去 |
| `get_default_share_directory` | 既定のピック先パス（`Pictures/sss-picked`）を返す                                                         |
| `get_ignore_patterns`         | 除外ルール（glob）の一覧を返す                                                                            |
| `add_ignore_pattern`          | 除外ルールを手動追加する                                                                                  |
| `remove_ignore_pattern`       | 除外ルールを削除する                                                                                      |
| `get_recent_images`           | 最近表示した画像（最大100件、除外ルール適用後）を返す                                                     |
| `get_picked_images`           | ピックフォルダ内の画像一覧を返す                                                                          |
| `delete_picked_image`         | ピックフォルダ内の画像を削除（フォルダ外のファイルは拒否）                                                |
| `reset_all_display_counts`    | 全画像の表示回数を 0 にリセットする                                                                       |

### stats（統計 / プレイリスト状態）

| コマンド            | 役割                                                           |
| ------------------- | -------------------------------------------------------------- |
| `get_stats`         | 総画像数と表示済み画像数を返す                                 |
| `get_playlist_info` | 現在位置・総数・戻れるか（`position, total, canGoBack`）を返す |
| `get_display_stats` | グラフ用に全画像の表示回数一覧（パス順）を返す                 |

### settings（設定）

| コマンド                  | 役割                                   |
| ------------------------- | -------------------------------------- |
| `save_setting`            | キー/値で設定を保存する                |
| `get_setting`             | キーで設定値を取得する                 |
| `get_last_directory_path` | 前回スキャンしたディレクトリパスを返す |

### system（システム）

| コマンド         | 役割                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `exit_app`       | アプリを安全に終了する                                            |
| `reset_all_data` | DB ファイルとキャッシュディレクトリを削除して全データを初期化する |

## 5. データフロー

### ① ディレクトリスキャン（差分）

1. `scan_directory` が DB から除外ルールを読み、`IgnoreFilter`（globset）を構築する。
2. `scanner.rs` が `walkdir` で対象拡張子（画像 8種 / 動画 4種）のファイルを集め、除外フィルタを適用。`rayon` で並列に `mtime`・`size` を取得し、100件ごとに進捗を `scan-progress` イベントで通知する。
3. DB の前回メタデータと突き合わせ、**新規**（パスなし）・**変更**（`mtime` 不一致）・**削除**（前回にあって今回ない）を判定する。変更は新規扱い。
4. 結果を DB へ反映（メタデータ upsert、削除行の物理削除、スキャン履歴記録＋100件超の刈り込み）。

### ② プレイリスト構築（完全平等）

- 初回・別ディレクトリのときは `Playlist::new` で全画像を **シャッフル** して新規構築する。
- 同一ディレクトリの再スキャンなら既存プレイリストを `update_images` で更新（削除分を除き、新規分をシャッフルして追加）する。
- スキャン後、`last_directory_path` を DB に保存する。

### ③ スライドショー再生（フロント）

1. 起動時、`App.tsx` が前回ディレクトリを差分スキャンし、`useSlideshow.initialize` で最初の画像を読み込む。
2. `useSlideshow` のタイマーが間隔ごとに `get_next_image` を呼ぶ（動画はタイマーでなく `onEnded` で次へ）。
3. `get_next_image` は `Playlist::advance` で進め、新規画像なら表示回数を +1、5枚先まで先読みキャッシュを作る。
4. `←`/`→` キーや OverlayUI のボタンで前後移動。戻りは `get_previous_image` → `Playlist::go_back`（履歴は最大100件、戻り中の進行は表示回数を加算しない）。
5. 画像表示時、`Slideshow.tsx` は `optimizedPath`（4K縮小/EXIF回転済キャッシュ）があれば優先し、`convertFileSrc` でローカルファイルを表示する。

### ④ ピック / 除外 / ignore の反映

- **ピック**: `pick_image` が原本をピックフォルダへコピー（原本は変更しない）。
- **除外（file）**: `exclude_image` が除外ルールを DB に追加し、即座にプレイリストからも除去 → その場で反映。
- **除外（date / directory）**: ルールを DB に追加するが、反映には再スキャンが必要。
- **ignore ルールの編集**: 追加/削除はすぐ DB に保存されるが、走査結果への反映は次回スキャン時。

## 6. 主要な設計判断

### (a) 完全平等ランダムを `Playlist` に隔離する

ランダム性の中心ロジックを `playlist.rs` の `Playlist` struct 1か所に閉じ込めています。`shuffled_list`（シャッフル済み全画像）を先頭から順に消費し、末尾に到達したら再シャッフルすることで、**1巡するまで同じ写真は二度出ない**＝全画像が均等に表示される、を構造的に保証します。再シャッフル時は「直前に表示した画像が新しい巡の先頭に来たら2番目と入れ替える」ことで、巡の境目での連続表示も防いでいます。前後移動は `history`（最大100件）＋`history_position` で扱い、`advance` は戻った先から再び新規へ進むときだけ表示回数を加算します（履歴内の再表示は重複カウントしない）。このロジックを 1 struct に隔離しているため、平等性の単体テストが容易で（`playlist.rs` 内にテストあり）、IPC・画像処理・UI から独立して検証・変更できます。

### (b) 差分スキャン（mtime + size）

10万枚規模では毎回の全走査と全 DB 書き込みは重いため、`scanner.rs` は前回のファイルメタデータ（パス→`mtime`+`size`）と突き合わせて差分だけを処理します。`mtime` が変わったファイルは新規として再登録し、消えたファイルは削除として DB から除去します。これにより 2回目以降の起動が高速になります。

### (c) ignore パターン

除外は `globset` ベースの glob で表現し、DB の `ignore_rules` テーブルに永続化します（`.thumbnails/`・`Thumbs.db`・`.DS_Store`・`@eaDir/`・`desktop.ini`・ドットフォルダなどを既定で投入）。マッチ判定はフルパスに加えて各パスコンポーネント単位でも行うため、フォルダ名だけのパターン（例: `private`）でも階層途中のフォルダを除外できます。`exclude_image` は EXIF 日付・ファイルパス・親ディレクトリのいずれかから自動でパターンを生成します。

---

UI のデザインシステム（配色・タイポグラフィ・形状・禁止事項など）はリポジトリ直下の `DESIGN.md` を唯一の正本とします。本ドキュメントは構造の地図、`DESIGN.md` は見た目の規約という役割分担です。
