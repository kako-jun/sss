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
│    AppState（db / playlist / directory_path / cache_dir /  │
│              cache_worker）                                │
│    playlist / scanner / image_processor / cache_worker /   │
│    ignore / database                                       │
└───────────────┬──────────────────────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
   SQLite（sss.db）   ファイルシステム
   ・メタデータ        ・写真/動画の原本（読み取り）
   ・表示統計          ・キャッシュ（4K縮小/EXIF回転済、サイズ上限付きLRU）
   ・除外ルール        ・ピックフォルダ（sss-picked）
   ・設定/スキャン履歴
```

各層の責務:

- **React フロントエンド**: 表示・ユーザー操作・タイマー進行のみを持つ。状態（現在の画像・再生中フラグ・進捗）は React 側に、永続データはすべてバックエンド側に置く。
- **Tauri IPC**: フロントとバックの唯一の境界。コマンド呼び出し（`invoke`）と、長時間処理の進捗通知（`scan-progress` イベント）の2系統。
- **Rust バックエンド**: ファイル走査・差分検出・画像最適化・統計・設定永続化を担う。アプリ全体の可変状態は `AppState`（`Mutex` で保護）に集約する。画像最適化キャッシュの生成は単一ワーカースレッド（`cache_worker.rs`）が直列に行う。
- **SQLite / ファイルシステム**: メタデータ・統計・設定は SQLite に、画像原本は読み取り専用、加工済み画像は起動時に退避→バックグラウンド削除でクリアする・サイズ上限（既定2GB、直近提供分は除外）を超えたら古いものから削除するキャッシュに置く。

## 3. モジュール責務表

### バックエンド（`src-tauri/src/`）

| モジュール                    | 責務                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.rs`                     | bin エントリ。`sss_lib::run()` を呼ぶだけの薄い殻（`windows_subsystem` 属性のみ保持）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lib.rs`                      | ライブラリ本体（`sss_lib`）。`run()` で Tauri アプリを初期化（プラグイン登録・`AppState` 構築・`invoke_handler` 登録）。芯モジュールを `pub` 公開し結合テスト（`tests/golden_e2e.rs`）から直接叩けるようにする。起動直後、キャッシュ/ピック先/`scan_history` の全スキャン先（前回ディレクトリ含む）を asset scope へ動的許可する副作用も持つ。起動時のキャッシュクリアは cache_dir を退避ディレクトリ（`cache-trash-<timestamp>`）へ rename→空の cache_dir を再作成し、退避先の削除はバックグラウンドスレッドに任せる（rename はエントリの付け替えのみで一瞬。この直後に起動する `CacheWorker` との削除競合を避ける。cache_dir というパス自体は asset scope 許可対象のため途切れさせない）。続けて `CacheWorker::spawn` で画像最適化ワーカーを1本起動する                      |
| `asset_scope.rs`              | asset protocol scope（`convertFileSrc` が読み込めるディレクトリ）の動的許可に使う純関数群と検証ゲート。`resolve_share_directory`（ピック先の解決）・`resolve_and_sanitize_share_directory`（解決+検証を束ねたラッパー。`save_setting`/`pick_image`共用）・`startup_allow_dirs`（起動直後に許可すべき候補列挙。ピック先+スキャン履歴の複数ディレクトリに対応）・`sanitize_allow_dir`（空文字列/相対パス/存在しないパス/ファイルを拒否し、`canonicalize` 済み絶対パスのみ通す検証ゲート。ファイルシステムルートは `is_protected_root` でホームディレクトリが属するドライブ〔Unixは`/`一択〕だけを拒否し、SDカード等の他ドライブ直下は許可）を提供。実際の `allow_directory` 呼び出しは `lib.rs`/`commands/scan.rs`/`commands/settings.rs`/`commands/file_operations.rs` 側が行う |
| `commands/types.rs`           | `AppState`（共有可変状態）と IPC で受け渡す型（`ScanProgress` / `Stats`）の定義                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `commands/scan.rs`            | ディレクトリ走査コマンド。差分スキャン実行 → DB 更新 → プレイリスト構築/更新 → `last_directory_path` 保存。旧 `~/.sssignore` の DB 移行も担う。スキャン対象ディレクトリを `sanitize_allow_dir` で検証後 asset scope へ動的許可する副作用を持ち、拒否された場合は Err を返してスキャンを中止する（手動スキャン・起動時自動スキャン共通）                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `commands/image.rs`           | プレイリスト遷移（次へ/前へ）。表示回数の加算（ファイル存在確認後）、5枚先の先読み要求を `cache_worker` へ投入、`ImageInfo`（サイズ・EXIF・統計）の組み立て                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `commands/file_operations.rs` | ファイラ起動、ピック（コピー）、除外ルール CRUD、画像除外、最近表示一覧、ピック済み一覧/削除、表示回数リセット。`pick_image` はピック先ディレクトリを `create_dir_all` した直後に `resolve_and_sanitize_share_directory` で再検証し asset scope へ許可する副作用を持つ（初回起動等でディレクトリ未作成のうちは許可できないため）                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `commands/stats.rs`           | 統計取得（総数/表示済み数）、プレイリスト状態（位置/総数/戻れるか）、グラフ用の表示回数一覧                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `commands/settings.rs`        | 設定の保存/取得、前回ディレクトリパスの取得。`share_directory_path` 保存時は `resolve_and_sanitize_share_directory` で検証後、asset scope へ即時許可する副作用を持つ（ディレクトリがまだ存在しない場合はここでは許可できず、`pick_image` 側で再許可する）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `commands/system.rs`          | アプリ終了、全データ初期化（DB・キャッシュ削除）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `playlist.rs`                 | **完全平等ランダムの正本**。シャッフル済みリスト・現在位置・最大100件の閲覧履歴を持つ `Playlist` struct。前後移動・末尾到達時の再シャッフルを管理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `scanner.rs`                  | `walkdir` でのメディアファイル収集（画像/動画拡張子で判定）と `rayon` 並列メタデータ取得。`mtime` による差分検出（新規/変更/削除。`size` は記録のみ）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `image_processor.rs`          | 画像の 4K リサイズ（Lanczos3）+ EXIF Orientation 補正（`DynamicImage::apply_orientation` に委譲。ただし実際に画素へ焼き込むのはキャッシュ生成が必要になった画像だけ）、キャッシュ要否判定（`plan_cache_file`: WebView非対応形式/4K超のいずれか。回転**だけ**が理由ではキャッシュを作らない。アニメGIF/WebPは常に対象外）、ヘッダのみの画像寸法取得（回転時は幅高さ入替。表示用の `ImageInfo.width/height` にのみ使う）、JPEG品質90%明示（透過保持のためPNG原本はPNGのまま）、EXIF（撮影日時・GPS・寸法）抽出、動画判定                                                                                                                                                                                                                                                         |
| `cache_worker.rs`             | 画像最適化キャッシュを作る単一ワーカースレッド。要求はキューで重複排除し、現在表示中の画像を先読みより優先処理（新しい current 要求が来たら古い current は格下げ）。新しい先読みバッチが来たら古い世代の先読み要求を破棄。一時ファイル→rename でアトミック書込。合計サイズが上限（既定2GB）を超えたら mtime の古いものから削除するが、直近に実際へ返したパスは除外し mtime も参照時に更新する（真のLRUに近づける）。WebView非対応形式（TIFF等）は `request_current_and_wait` で変換完了を待ってから返す。変換失敗は失敗セットに記録し再要求を抑止。ジョブ処理は `catch_unwind` で囲み panic でスレッドが死なないようにする                                                                                                                                                     |
| `ignore.rs`                   | `globset` ベースの除外フィルタ。フルパスと各パスコンポーネントの両方でマッチ判定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `database.rs`                 | SQLite ラッパ。スキーマ初期化（6テーブル）、メタデータ/統計/除外ルール/設定/スキャン履歴の読み書き、旧スキーマからのマイグレーション。`get_distinct_scan_directories` で過去にスキャンした全ディレクトリ（重複なし）を返し、起動時の asset scope 許可に使う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

`lib.rs` の `run()` 内 `invoke_handler` に登録された全 22 コマンドをドメイン別に示します（フロントからは `src/lib/tauri.ts` 経由で呼ばれます）。

### scan（走査）

| コマンド         | 役割                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scan_directory` | ディレクトリを差分スキャンして DB を更新し、プレイリストを構築/更新する。進捗は `scan-progress` イベントで通知。副作用: スキャン対象を `sanitize_allow_dir` で検証後 asset scope へ動的許可（手動スキャン・起動時自動スキャン共通経路）。検証で拒否された場合（ホームドライブのルート等）は Err を返しスキャンを中止する |

### image（プレイリスト遷移）

| コマンド             | 役割                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `get_next_image`     | 次の画像へ進める。新規画像かつファイル存在確認後にのみ表示回数を +1 し、5枚先まで先読み要求を単一ワーカーへ投入する。`ImageInfo` を返す |
| `get_previous_image` | 履歴を1つ戻る（表示回数は加算しない）。`ImageInfo` を返す                                                                               |

### file_operations（ピック / 除外 / 削除 / ファイラ / 履歴）

| コマンド                      | 役割                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_in_explorer`            | OS のファイラで画像を選択状態で開く（Windows/macOS/Linux 別実装）                                                                                                                                                 |
| `pick_image`                  | 画像をピックフォルダ（既定 `Pictures/sss-picked`）へコピー。同名は時刻付与で衝突回避。副作用: フォルダを `create_dir_all` した直後に asset scope へ再許可（未作成時は `save_setting` 側の許可が失敗しているため） |
| `exclude_image`               | 画像を `date`/`file`/`directory` のいずれかで除外ルール化（DB へ追加）。`file` は即プレイリストからも除去                                                                                                         |
| `get_default_share_directory` | 既定のピック先パス（`Pictures/sss-picked`）を返す                                                                                                                                                                 |
| `get_ignore_patterns`         | 除外ルール（glob）の一覧を返す                                                                                                                                                                                    |
| `add_ignore_pattern`          | 除外ルールを手動追加する                                                                                                                                                                                          |
| `remove_ignore_pattern`       | 除外ルールを削除する                                                                                                                                                                                              |
| `get_recent_images`           | 最近表示した画像（最大100件、除外ルール適用後）を返す                                                                                                                                                             |
| `get_picked_images`           | ピックフォルダ内の画像一覧を返す                                                                                                                                                                                  |
| `delete_picked_image`         | ピックフォルダ内の画像を削除（フォルダ外のファイルは拒否）                                                                                                                                                        |
| `reset_all_display_counts`    | 全画像の表示回数を 0 にリセットする                                                                                                                                                                               |

### stats（統計 / プレイリスト状態）

| コマンド            | 役割                                                           |
| ------------------- | -------------------------------------------------------------- |
| `get_stats`         | 総画像数と表示済み画像数を返す                                 |
| `get_playlist_info` | 現在位置・総数・戻れるか（`position, total, canGoBack`）を返す |
| `get_display_stats` | グラフ用に全画像の表示回数一覧（パス順）を返す                 |

### settings（設定）

| コマンド                  | 役割                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `save_setting`            | キー/値で設定を保存する。副作用: `share_directory_path` の場合、解決先を `sanitize_allow_dir` で検証後 asset scope へ即時許可 |
| `get_setting`             | キーで設定値を取得する                                                                                                        |
| `get_last_directory_path` | 前回スキャンしたディレクトリパスを返す                                                                                        |

### system（システム）

| コマンド         | 役割                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit_app`       | アプリを安全に終了する                                                                                                                                                                                                                 |
| `reset_all_data` | DB ファイルを削除し、キャッシュを退避ディレクトリへ rename→空の cache_dir を再作成して全データを初期化する（起動時クリアと同じ手法。稼働中の `CacheWorker` の書込との競合を避けつつ、cache_dir 自体は asset scope 許可対象のため残す） |

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

1. 起動時、`App.tsx` が前回ディレクトリを差分スキャンし、`useSlideshow.initialize` が最初の `get_next_image` を呼んで先頭画像を読み込む。
2. `useSlideshow` のタイマーが間隔ごとに `get_next_image` を呼ぶ（動画はタイマーでなく `onEnded` で次へ）。
3. `get_next_image` は `Playlist::advance` で進め、新規画像かつファイル存在確認後にのみ表示回数を +1、5枚先までの先読み要求を単一ワーカー（`cache_worker.rs`）のキューへ投入する。現在画像のキャッシュ要求は先読みより優先して処理され、要求は重複排除・世代管理（新しい先読みバッチが来たら古い世代の先読み要求を破棄）される。
4. `←`/`→` キーや OverlayUI のボタンで前後移動。戻りは `get_previous_image` → `Playlist::go_back`（履歴は最大100件、戻り中の進行は表示回数を加算しない）。
5. 画像表示時、`Slideshow.tsx` は `optimizedPath`（4K超/TIFF等で必要になった場合のキャッシュ。まだ生成されていなければ原本をそのまま表示。TIFF等 WebView 非対応形式は変換完了を待ってから返すため原則キャッシュ済み）があれば優先し、`convertFileSrc` でローカルファイルを表示する。**回転は原則バックエンドで焼き込まず、フロントの `image-orientation` CSS で行う**（`ImageInfo.applyRotation` の値に連動して `from-image`/`none` を切替）。asset プロトコルは WebView から見て別オリジンであり、`crossOrigin` 無しのクロスオリジン画像は `image-orientation` 自体が無視される（Edge で実測確認）ため、`img` 要素には `crossOrigin="anonymous"` も付与する（tauri の asset protocol ハンドラは `Access-Control-Allow-Origin` に実際の window origin を返すため、認証情報なしの CORS リクエストで通る）。4K超/TIFF等で結局キャッシュが焼かれた画像は、生成時点で `apply_rotation` に従って画素を回転しEXIFなしで書き出すため、`from-image` を当てても二重回転はしない。動画・地図タイル（OverlayUI の OSM 画像）には `crossOrigin` を付けない。

### ④ ピック / 除外 / ignore の反映

- **ピック**: `pick_image` が原本をピックフォルダへコピー（原本は変更しない）。
- **除外（file）**: `exclude_image` が除外ルールを DB に追加し、即座にプレイリストからも除去 → その場で反映。
- **除外（date / directory）**: ルールを DB に追加するが、反映には再スキャンが必要。
- **ignore ルールの編集**: 追加/削除はすぐ DB に保存されるが、走査結果への反映は次回スキャン時。

## 6. 主要な設計判断

### (a) 完全平等ランダムを `Playlist` に隔離する

ランダム性の中心ロジックを `playlist.rs` の `Playlist` struct 1か所に閉じ込めています。`shuffled_list`（シャッフル済み全画像）を先頭から順に消費し、末尾に到達したら再シャッフルすることで、**1巡するまで同じ写真は二度出ない**＝全画像が均等に表示される、を構造的に保証します。再シャッフル時は「直前に表示した画像が新しい巡の先頭に来たら2番目と入れ替える」ことで、巡の境目での連続表示も防いでいます。前後移動は `history`（最大100件）＋`history_position` で扱い、`advance` は戻った先から再び新規へ進むときだけ表示回数を加算します（履歴内の再表示は重複カウントしない）。このロジックを 1 struct に隔離しているため、平等性の単体テストが容易で（`playlist.rs` 内にテストあり）、IPC・画像処理・UI から独立して検証・変更できます。

### (b) 差分スキャン（mtime）

10万枚規模では毎回の全走査と全 DB 書き込みは重いため、`scanner.rs` は前回のファイルメタデータ（パス→`mtime`。`size` も保持しますが変更判定には使いません）と突き合わせて差分だけを処理します。`mtime` が変わったファイルは新規として再登録し、消えたファイルは削除として DB から除去します。これにより 2回目以降の起動が高速になります。

### (c) ignore パターン

除外は `globset` ベースの glob で表現し、DB の `ignore_rules` テーブルに永続化します（`.thumbnails/`・`Thumbs.db`・`.DS_Store`・`@eaDir/`・`desktop.ini`・ドットフォルダなどを既定で投入）。マッチ判定はフルパスに加えて各パスコンポーネント単位でも行うため、フォルダ名だけのパターン（例: `private`）でも階層途中のフォルダを除外できます。`exclude_image` は EXIF 日付・ファイルパス・親ディレクトリのいずれかから自動でパターンを生成します。

### (d) 画像最適化キャッシュは単一ワーカー + キューで直列化する

旧実装は `get_next_image`／先読み1件ごとに `thread::spawn` していたため、キーリピート等で数十本のスレッドが同時に巨大画像をフルデコード＋Lanczos3する事故があった（#60）。`cache_worker.rs` は常駐スレッド1本に置き換え、要求をキューで管理する：現在表示中の画像の要求は先読みより優先して処理し、新しい current 要求が来たら古い current は先読み優先度へ格下げする（同時に「現在画像」は1件だけという前提を保つ）。同じキャッシュファイルへの要求は重複排除、新しい先読みバッチが来たら古い世代の先読み要求（現在画像分は除く）を破棄する。書込は一時ファイル→`rename` でアトミックに行い（`exists()` が書込途中のファイルを返す事故を防ぐ）、合計サイズが上限（既定2GB、`CACHE_MAX_BYTES`）を超えたら更新日時の古いものから削除する。ただし直近に実際へ返した（表示に使った）パスは削除対象から除外し、キャッシュヒット時に mtime も更新するため、生成順（実質FIFO）ではなく真のLRUに近い。ジョブ処理は `catch_unwind` で囲み、image crate 内で panic が起きてもワーカースレッド自体は死なない。変換に失敗した画像はキー（cache_file）を失敗セットに記録し、同じキーの再要求（current/prefetch とも）を抑止する。

キャッシュ要否の判定（`image_processor::plan_cache_file`）は WebView が直接表示できない形式（TIFF等）・表示サイズが4K超のいずれかで、**EXIF回転が必要というだけではキャッシュを作らない**（回転は下記(e)の通りフロントのCSSで行う）。4K超判定はヘッダ上の生の幅高さ（回転前）で行う（WebViewは原本をそのままデコードしてからCSSで回転を表示上適用するだけで、デコード時のメモリコストは回転の有無に関係ないため）。アニメーションしうる形式（GIF/WebP）は静止フレーム化を避けるため常に対象外とする。キャッシュキーには原本の mtime・サイズも含め、原本が置き換わった場合に古いキャッシュを誤って使い回さないようにしている。

WebView が直接表示できない形式（TIFF等）は、原本をそのまま返しても表示できないため、キャッシュ未生成時は `CacheWorker::request_current_and_wait`（タイムアウト付き）で変換完了を同期的に待ってからキャッシュパスを返す。失敗・タイムアウト時はファイル不在と同様に `Ok(None)` を返しスキップ扱いにする（フロント側の自動スキップ自体は #65）。4K超のみが理由の画像は原本もWebViewで表示できるため、これまで通り非同期（先に原本を返し、バックグラウンドでキャッシュを作る）。

### (e) 回転はバックエンドで焼き込まず、フロントの `image-orientation` CSS で行う（#60 レビュー方針転換）

当初はキャッシュ生成時にEXIF回転を画素へ焼き込む設計だったが、レビューにより「回転だけの理由でキャッシュを作らない」方針へ転換した。`ImageInfo.applyRotation`（`apply_exif_rotation` 設定のスナップショット）をバックエンドがフロントへ渡し、`Slideshow.tsx` の `img` 要素が `image-orientation` を `from-image`（ON）/`none`（OFF）に切り替える。asset プロトコルは WebView から見て別オリジンであり、`crossOrigin` 無しのクロスオリジン画像は `image-orientation` 自体が無視される（Edge で実測確認済み）ため、`img` 要素には `crossOrigin="anonymous"` も付与する。tauri 2.10.3 の asset protocol ハンドラ（`asset.rs`）は `Access-Control-Allow-Origin` に実際の window origin をそのまま返す（ワイルドカードではない）ため、認証情報なしの CORS リクエストで通る。動画・地図タイル（OSM）には `crossOrigin` を付けない。4K超/TIFF等で結局キャッシュが焼かれる画像は、生成時に `apply_rotation` に従って画素を回転しEXIFなしで書き出すため、`from-image` を当てても二重回転はしない。

## 7. テスト

バックエンドは `src-tauri` を **lib+bin 分割**（`[lib] name = "sss_lib"`）しており、芯モジュールはライブラリとして公開されます。これにより:

- **モジュール内ユニットテスト**（`scanner.rs` / `playlist.rs` / `ignore.rs` / `image_processor.rs` / `cache_worker.rs` / `asset_scope.rs` の `#[cfg(test)]`）— 拡張子判定・平等ランダム・履歴・ignore マッチ・asset scope の許可対象解決/拒否条件（空文字列/相対パス/存在しないパス/ファイルの拒否、ファイルシステムルートはホームディレクトリが属するドライブだけを拒否し他ドライブは許可、正常な絶対ディレクトリの許可、複数スキャン履歴ディレクトリの列挙）など。`image_processor.rs` は Rust テスト内でバイト列から Orientation 1〜8 の EXIF を埋め込んだ小さな JPEG フィクスチャ（数KB）を生成し、EXIF仕様の幾何定義（水平反転・転置・90度回転等の数式）から独立に導出した期待値と画素・幅高さ入替を比較する（image crate の rotate/flip 関数を呼んで期待値を作ると実装のバグを実装自身でなぞってしまうため）。`cache_worker.rs` はアトミック書込・直近提供分を除外したサイズ上限LRU削除・current優先度の格下げ/世代管理・`request_current_and_wait` の成功/タイムアウト/失敗セット即時失敗・catch_unwindパターンをディレクトリ操作込みで検証する。
- **結合テスト**（`src-tauri/tests/get_next_image_missing_file.rs`）— dev-dependencies限定の `tauri::test::mock_app()` で最小の Tauri App を作り、`#[tauri::command]` を `State` 経由で直接呼ぶ。プレイリスト上は新規画像でも実ファイルが存在しない場合に表示回数が加算されないことを固定する。
- **golden e2e**（`src-tauri/tests/golden_e2e.rs`）— フィクスチャのフォルダ木を生成し、`scan → ignore 除外 → playlist 構築 → 差分検出` の一気通貫を `sss_lib::{scanner,ignore,playlist}` 経由で機械検証する。デスクトップアプリで Web e2e はできないが、フィクスチャ駆動なら人手なしで「どのファイルがスライドショーに乗るか」の芯を守れる。scan（WalkDir+rayon 並列）と playlist（乱数シャッフル）は順序が非決定なので、判定は**ソート集合・件数・差分**で行う。
- フロントエンドは vitest（`src/lib/tauri.test.ts` / `src/components/Slideshow.test.tsx` 等）。`Slideshow.test.tsx` は `applyRotation` に連動した `image-orientation` の切替と `crossOrigin` 付与を固定する。

CI（`.github/workflows/ci.yml`）が push/PR で `cargo fmt --check` / `clippy -- -D warnings` / `cargo test` / フロント vitest を回す。

---

UI のデザインシステム（配色・タイポグラフィ・形状・禁止事項など）はリポジトリ直下の `DESIGN.md` を唯一の正本とします。本ドキュメントは構造の地図、`DESIGN.md` は見た目の規約という役割分担です。
