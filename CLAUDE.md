# Smart Slide Show (sss) - プロジェクト仕様書

## プロジェクト概要

**アプリ名**: sss (Smart Slide Show)
**作者**: kako-jun
**目的**: 10万枚以上の写真・動画を公平に表示するスライドショーアプリ

## 技術スタック

### バックエンド

- **フレームワーク**: Tauri v2 (最新版、モバイル対応準備)
- **言語**: Rust (edition 2021)
- **データベース**: SQLite (rusqlite v0.32, bundled)
- **並列処理**: rayon v1
- **ファイル走査**: walkdir v2
- **フィルタリング**: globset v0.4
- **EXIF読み取り**: kamadak-exif v0.6 (画像のみ)
- **画像処理**: image v0.25
- **キャッシュ管理**: md5 v0.7 (ファイル名ハッシュ生成)
- **ランダム生成**: rand v0.8
- **スクリーンセーバー抑制**: keepawake v0.4 (クロスプラットフォーム対応)
- **プラグイン**:
  - tauri-plugin-dialog v2 (ダイアログ)
  - tauri-plugin-opener v2 (URLを開く)
  - tauri-plugin-single-instance v2 (単一インスタンス)

### フロントエンド

- **フレームワーク**: React 19 + TypeScript
- **ビルドツール**: Vite v7
- **アニメーション**: Framer Motion
- **スタイリング**: TailwindCSS v3
- **アイコン**: Lucide React

## コア機能

### 1. 完全平等ランダム表示

- アルゴリズム: Complete Equality Shuffle
- 全画像をシャッフルしたリストを作成
- リストを順番に表示
- 全て表示完了後、再シャッフル
- 同じ画像が連続して表示されないことを保証

### 2. スライドショー

- **表示間隔**: 5〜60秒でカスタマイズ可能（設定画面から変更）
- **対象ファイル**:
  - 画像: JPG, PNG, GIF, BMP, WEBP など
  - 動画: MP4, WebM, OGV, M4V（旧フォーマットはffmpeg同梱後に対応予定 #45）
- **表示モード**: 4K最適化 (3840x2160)
- **EXIF回転**: `img`要素に`crossOrigin`/`image-orientation`を明示指定せず、WebView既定の動作（`image-orientation: from-image`＝EXIFに従い自動回転）に任せる。`apply_exif_rotation=false`なのにEXIFが回転を要求している画像だけ例外で、バックエンドが「格納画素のまま・EXIF無し」のキャッシュに差し替える（原本を返すとWebViewが勝手に回転し設定と食い違うため）。crossOriginを付けてCSSで明示切替する設計は、wryのWebKitGTK実装がassetスキームをCORS有効登録しておらずLinux本番で画像が出なくなるリスクがあるため撤去した
- **画像処理**: 4K超/WebView非対応形式(TIFF等)/`apply_exif_rotation=false`時の回転要求のいずれかに該当する画像だけをキャッシュ対象にし、自動リサイズ(Lanczos3フィルタ)でキャッシュフォルダに保存。出力フォーマットはデコード後の実データのアルファ有無で決定(透過ならPNG、無ければJPEG品質90%明示)。アニメGIF/WebPは静止フレーム化を避けるため常にキャッシュ対象外
- **画像ロード**: Tauriの`convertFileSrc()`でプロトコル経由読み込み（クロスプラットフォーム対応）
- **先読みキャッシュ**: 5枚先まで先読み。生成は単一ワーカースレッド+キューで直列処理（弱いCPU対応、連打してもスレッド数・メモリが有界）。原本を返すと表示が誤る画像（TIFF等/`apply_exif_rotation=false`時の回転要求）は変換完了を待ってからパスを返す（`tauri::async_runtime::spawn_blocking`で実行スレッドは塞がない）。キャッシュは合計サイズ上限(既定2GB)超で古いものから自動削除（直近提供分は除外）、書込は一時ファイル→renameでアトミック、失敗した画像は再要求を抑止。起動時/全データ初期化時はcache_dirを退避ディレクトリへrename→再作成してクリア（ワーカーの新規書込との競合を回避）
- **動画処理**: ウィンドウにフィット表示（object-fit: contain）、再生終了で自動次送り

### 3. 除外ルール（ignore）フィルタリング

- 除外ルールはDBの `ignore_rules` テーブル（`pattern` + `rule_type`。主キーは `(pattern, rule_type)` の複合キー）に保存する（旧 `.sssignore` ファイルは**初回スキャン時**にDBへ**1回限り**移行し、`app_settings` にフラグを立てる。移行後は `.sssignore.bak` にリネームされ二度と読まれない）
- `rule_type = "glob"`: gitignoreスタイルのglobパターン（globsetライブラリ）。**末尾 `/` のパターンはディレクトリ名照合として扱う**（「スキャンルートからの相対パス上で、いずれかの祖先ディレクトリ名が一致」。`**/.thumbnails/`・`**/@eaDir/`・任意のドットフォルダを表す `**/.**/` など）。スキャンルート自体がドットディレクトリ配下でも、相対パスで判定するため誤って全除外にはならない
- `rule_type = "date"`: 撮影日（`YYYY-MM-DD`）による除外。判定は独立テーブル `exif_cache`（`path`/`captured_date`/`file_mtime`。`file_metadata` とは別で `mark_deleted` の対象外）に保存済みの撮影日を最優先に使う。撮影日ルールが1件以上ある場合に限り、スキャン時に `exif_cache` が未取得/古い（ファイルのmtimeが食い違う）候補だけ rayon で並列にEXIFを読み直す。未取得のまま残った画像はパス文字列中の日付表記（`YYYY-MM-DD`/`YYYYMMDD`、スキャンルートからの相対パスで探索）でフォールバック判定する。詳細は `docs/architecture.md` 参照
- ファイル/ディレクトリ単位の除外（オーバーレイの除外メニュー）は `globset::escape` でメタ文字（`[`,`]`,`{`,`}`,`*`,`?`）をエスケープしてから登録するため、`photo[1].jpg` のような名前でも自己マッチする。手動追加（設定画面）は `Glob::new` で検証し、不正なパターンはエラーを返す（UIにも表示する）
- 除外ルールで対象外になったファイルは「削除」とは区別される。`file_metadata`/`image_stats`（表示履歴）は消えず、プレイリストからのみ外れる。物理的な削除の判定は、除外ルールを一切適用しない生スキャンの結果を基準に行う

### 4. 表示履歴管理

- **SQLiteテーブル**: `image_stats`
- **記録情報**:
  - 表示回数 (`display_count`)
  - 最終表示日時 (`last_displayed`)
- **用途**: 表示統計の可視化、公平性の検証

### 5. 差分スキャン

- 前回スキャン時のファイル情報をSQLiteに保存（比較対象は**今回スキャンするディレクトリ配下のみ**。複数フォルダを切り替えて使ってもA→B→Aで各フォルダの情報が確定削除されない、#63）
- ファイルサイズと更新日時で変更を検出
- 変更されたファイルのみDBへ反映（新規/変更分のみのupsert＋確定削除分の削除を1トランザクションで、#63）
- **高速起動**: 10万枚規模でも数秒で起動可能
- `walkdir`/ファイル単位のメタデータ取得エラー（1970年より前のmtime含む）は件数・代表例を結果に残し、該当パス配下は削除せず「不明」として扱う（#63）

### 6. スクリーンセーバー抑制

- アプリ起動中は常にスクリーンセーバーとディスプレイスリープを抑制
- クロスプラットフォーム対応 (Windows/Linux/macOS)
- keepawakeクレートによる実装

### 7. UI/UX

#### 通常表示

- 最大化ウィンドウ（フルスクリーンではない）
- 画像/動画を中央に表示（object-fit: contain）
- 背景: 黒
- UI非表示

#### マウス移動時

- オーバーレイUI表示（グラスモーフィズムデザイン）
- 3秒間アイドル状態でUI非表示
- **自動一時停止**: マウス移動時にスライドショーを一時停止

#### オーバーレイUI内容

1. **ファイル情報**
   - 📁 ファイルパス（フルパス表示）
   - 🖼️ 画像サイズ（幅x高さ）
   - 💾 ファイルサイズ
   - 📅 撮影日時（画像のみ、EXIFから取得）
   - 📍 GPS座標（画像のみ、EXIF: 緯度・経度）
   - 📊 プレイリスト位置: 現在位置 / 総数（例: 1,234 / 100,000）
   - 🔢 表示回数: 何回表示されたか
   - 🕒 最新表示: 最後に表示された日時（ISO 8601形式: YYYY-MM-DD HH:MM:SS）
   - 動画の場合: EXIF情報なし、ファイル情報のみ表示

2. **操作ボタン**
   - **前へ**: 前の画像/動画に戻る（履歴から取得、表示回数をインクリメントしない）
   - **次へ**: 次の画像/動画へ進む（即座に表示）
   - **開く**: ファイルマネージャーで開く（Windows: explorer /select、Linux: nautilus/dolphin/xdg-open）
   - **設定**: 設定画面を開く

3. **UI操作**
   - マウス移動で表示、3秒アイドルで自動非表示
   - オーバーレイ外クリックで即座に非表示
   - マウス操作中は自動的にスライドショーを一時停止、非表示で自動再開

#### キーボードショートカット

- **ESC**: アプリを終了
- **左矢印キー**: 前の画像/動画へ戻る
- **右矢印キー**: 次の画像/動画へ進む
- キーリピート（押しっぱなし）による多重発火は無視する（`e.repeat`、#65）

#### 案内画面・通知（#65）

`get_next_image`/`get_previous_image` の結果は `ImageNavigationResult`（`kind`で
区別、詳細は下記API一覧）で意味ごとに分岐し、状況に応じた画面/通知を出す:

- **ようこそ画面**: ディレクトリが一度も設定されていない（本当に未設定の）時だけ。
  「フォルダを選択」ボタンを表示する
- **空プレイリスト**: ディレクトリは設定済みだが除外ルール等で表示対象が0件の場合、
  専用の案内（「表示できる写真がありません」）を出す。ようこそ画面とは区別する
- **フォルダ接続不可**（NAS/USB切断等）: 直前の画像を維持したまま、控えめな
  日本語通知（「フォルダに接続できません。再接続をお待ちください…」）を出す。
  鑑賞中の画像を消さない
- **読込失敗**: 自動で次の画像へ進む（連続失敗が上限に達したら諦めて通知に切替）。
  ユーザー操作を要求しない
- **起動時自動スキャンで前回ディレクトリが拒否された場合**: 理由をようこそ/
  案内画面に表示する（以前は`console.error`のみで握りつぶしていた）

文言は `src/lib/messages.ts` にキー→文言のフラットな辞書として集約（i18n本体は
別Issue #80で ja/en に分割する前提の構造）。

#### 設定画面

- フォルダ選択ダイアログ
- スキャン実行ボタン
- スキャン結果表示（追加/更新/削除ファイル数、総ファイル数）
- 統計情報表示

## データベーススキーマ

### file_metadata テーブル

```sql
CREATE TABLE file_metadata (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    modified_time INTEGER NOT NULL  -- Unix timestamp
);
```

- **用途**: 差分スキャン用のファイルキャッシュ

### image_stats テーブル

```sql
CREATE TABLE image_stats (
    path TEXT PRIMARY KEY,
    display_count INTEGER DEFAULT 0,
    last_displayed TEXT  -- ISO 8601 timestamp
);
```

- **用途**: 表示履歴管理

### playlist_list / playlist_position テーブル

プレイリスト状態の永続化（#62で実使用開始）。当初は `playlist_state` 1テーブルに
まとめていたが、**#62レビューM3(must)** で書込頻度の異なる2テーブルへ分割した:
`shuffled_list`（10万件規模でJSONが数MBになりうる）を含む1行を、`advance` のたびの
軽量更新（`next_index`/`history` だけ変える）でも毎回書き直すことになり、SQLiteは
行全体をコピーして書くため実測で1回あたり数十ms・1日あたり数十GB相当の無駄な
I/Oになっていたため。旧 `playlist_state`（#61以前からある未使用テーブル。実使用
されたことは一度も無い）はv2マイグレーションでドロップ済み。

```sql
CREATE TABLE playlist_list (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    directory_path TEXT,  -- どのスキャン対象ディレクトリの状態か
    shuffled_list TEXT    -- JSON array（パス）
);

CREATE TABLE playlist_position (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_index INTEGER DEFAULT 0,  -- 消費済み件数(0..=len)。#62レビューM1
    history TEXT,                  -- JSON array（パス。インデックスではない、#62）
    history_position INTEGER DEFAULT 0
);
```

- **用途**: 常にそれぞれ1行（`id=1`）だけを持つ。
  - `playlist_list`（directory_path/shuffled_list）は、シャッフル確定時
    （新規作成・巡の再シャッフル・`update_images`）に `playlist_position` と
    同じトランザクションでフル保存する（`Database::save_playlist_full`）。
  - `advance`/`go_back` のたびは `playlist_position`（next_index/history/
    history_position）だけを軽量更新する（`Database::save_playlist_position`。
    `playlist_list` には一切触れない）。
  - 起動時は `Database::load_playlist_state` で両テーブルを読み、`directory_path`
    が一致すれば `Playlist::from_persisted` で復元する。JSON列が壊れていても
    エラーにはせず空リストへフォールバックする（#62レビューS3）。特に `history`
    だけが壊れていても `shuffled_list`/`next_index` は健全なまま読め、続きから
    再開できる。
  - **#62レビューS1**: `scan_directory` のスキャン完了を待たずに表示を始められる
    よう、独立した `restore_playlist` コマンドが起動直後にまずこの読み出しを行う
    （詳細は §3 コマンド一覧、`docs/architecture.md` §5③）。
  - **#62レビューS2**: ディレクトリの一致判定は生の文字列比較ではなく
    `commands::playlist_persistence::normalize_directory_key`（`canonicalize`
    優先、失敗時は末尾区切り除去）で行う。
  - 1行しか持たないため、フォルダA→B→Aと切り替えるとAの巡の途中経過は失われ、
    Bに切り替えた時点で上書きされる（複数フォルダの状態を同時に保持しない設計。
    #62レビューS2、詳細は `docs/features.md`）。

### ignore_rules テーブル

```sql
CREATE TABLE ignore_rules (
    pattern TEXT NOT NULL,
    rule_type TEXT NOT NULL DEFAULT 'glob',  -- "glob" | "date"（#61で追加）
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pattern, rule_type)  -- 複合主キー（#61: 同一文字列のglob/dateルール衝突回避）
);
```

- **用途**: 除外ルール（旧 `.sssignore` の移行先）。`rule_type` で通常globと撮影日ルールを区別する
- **マイグレーション**: `PRAGMA user_version` を使った汎用マイグレーション機構（`database.rs::run_migrations`）で列追加・主キーの作り直しを1トランザクションで行う。既存の `pattern` 文字列自体は変更不要（判定ロジック側の修正のみで新しい挙動が効くため）

### exif_cache テーブル

```sql
CREATE TABLE exif_cache (
    path TEXT PRIMARY KEY,
    captured_date TEXT,      -- YYYY-MM-DD。EXIFに無ければNULL
    file_mtime INTEGER       -- 取得時点のファイルmtime（再取得要否の判定に使う）
);
```

- **用途**: 撮影日除外ルールの判定用キャッシュ（#61）。`file_metadata` とは独立し、`mark_deleted`（物理削除の反映）の対象外にする。表示時（`get_next_image`等）の遅延取得、およびスキャン時（撮影日ルールが1件以上ある場合のみ）の並列EXIF再取得の両方で書き込む

### scan_history テーブル

```sql
CREATE TABLE scan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_time TEXT DEFAULT CURRENT_TIMESTAMP,
    folder_path TEXT NOT NULL,
    total_files INTEGER DEFAULT 0,
    added_files INTEGER DEFAULT 0,
    updated_files INTEGER DEFAULT 0,
    deleted_files INTEGER DEFAULT 0
);
```

- **用途**: スキャン履歴の記録

## Rustモジュール構成

### src-tauri/src/main.rs

- bin エントリ。`sss_lib::run()` を呼ぶだけの薄い殻（`windows_subsystem` 属性のみ保持）

### src-tauri/src/lib.rs

- ライブラリ本体（`sss_lib`）。`run()` が Tauri アプリを初期化（プラグイン登録・Tauriコマンド登録・スクリーンセーバー抑制・キャッシュ管理・`AppState` 構築）
- 芯モジュール（scanner/playlist/ignore/image_processor/database/commands）を `pub` 公開し、結合テスト `tests/golden_e2e.rs`（フォルダ→scan→ignore→playlist の golden e2e）から直接叩けるようにする lib+bin 分割

### src-tauri/src/database.rs

- SQLite操作
- テーブル初期化
- CRUD操作

### src-tauri/src/scanner.rs

- 並列ファイルスキャン（rayon使用）
- 差分検出
- EXIF情報抽出（画像のみ）
- 対応ファイル形式の判定

### src-tauri/src/ignore.rs

- DBの `(pattern, rule_type)` から `IgnoreFilter` を構築（globset）
- 末尾 `/` パターンをディレクトリ名照合用globに正規化（`normalize_dir_pattern`）し、スキャンルートからの相対パスで判定
- 撮影日ルールの判定（DB保存済み撮影日 優先 / パス文字列中の日付 `extract_date_from_path` でフォールバック）

### src-tauri/src/playlist.rs

- シャッフルアルゴリズム実装（末尾到達時の再シャッフル、境界での連続表示防止）
- 履歴管理（#62: パスで保持。インデックス保持だと再シャッフルで別画像を指してしまうため）
- 進行カーソルは `next_index`（消費済み件数、範囲 `0..=len`。#62レビューM1(must)）で
  持つ。`next_index==0`が「開始前」、`next_index==len`が「巡の末尾」を意味し、
  専用の番兵フラグは持たない（旧 `current_index`+`before_start` の2状態管理は、
  `update_images` の削除処理で表示中の画像自身が削除されるケースの補正を誤ると
  未表示画像を1枚飛ばすバグがあった）
- 永続化用アクセサ（`shuffled_list`/`next_index`/`history`/`history_position` の
  getterと `from_persisted` コンストラクタ）を提供するのみで、DB自体には触らない
  （実際の読み書きは `database.rs`（`save_playlist_full`/`save_playlist_position`/
  `load_playlist_state`）と `commands/playlist_persistence.rs`/`commands/scan.rs`/
  `commands/image.rs`/`commands/file_operations.rs` が行う。Tauri/DB非依存を保つ設計）

### src-tauri/src/image_processor.rs

- 画像の最適化（4K超/TIFF等/`apply_rotation=false`時の回転要求でキャッシュが必要になった場合のみ実施。EXIF回転は`DynamicImage::apply_orientation`委譲、出力フォーマットは実データのアルファ有無で決定/透過はPNG・JPEG品質90%明示）
- キャッシュ要否判定（`plan_cache_file`）・同期待ち要否判定（`requires_synchronous_cache`）
- EXIF情報抽出
- 画像サイズ取得（ヘッダのみ、`ImageInfo`表示用に回転時は幅高さ入替）

### src-tauri/src/cache_worker.rs

- 画像最適化キャッシュを作る単一ワーカースレッド（優先度/世代管理付きキュー、アトミック書込、サイズ上限LRU削除、`request_current_and_wait`同期待ち、失敗セット、panic保護）
- 起動時/`reset_all_data`共通のキャッシュクリア（`clear_cache_dir`: 退避rename→再作成、古いtrash掃除）

### src-tauri/src/commands/

- Tauriコマンドハンドラ（23個）
  1. `scan_directory`: フォルダスキャン（リアルタイム進捗イベント付き）。プレイリストの
     新規作成/差分更新に加え、メモリ上にプレイリストが無い場合（`restore_playlist` が
     復元できなかった、またはまだ呼ばれていない）はDB保存済みのプレイリスト状態を
     読み、対象ディレクトリが一致すれば復元して差分適用する
  2. `restore_playlist`: 起動直後、DB保存済みのプレイリスト状態を**スキャン完了を
     待たずに**復元する（#62レビューS1）。フロントはまずこれを呼び、`true`（復元
     成功、または既に初期化済みで既存維持）ならスキャンをバックグラウンドへ回して
     即座に表示を始め、`false`（保存なし/ディレクトリ不一致/対象ディレクトリに今
     アクセスできない/スキャン中）ならスキャン完了を待つ従来のフローに
     フォールバックする（#62レビュー2巡目 N-M1 must: NAS/USB未マウント等で対象
     ディレクトリに今アクセスできない場合は復元しない。N-S2: 既にplaylistがあれば
     既存維持、スキャン中は割り込まない。#62レビュー3巡目 nit: 「既にplaylistが
     ある」判定は`directory_path`が今回のリクエストと一致する場合のみ既存維持と
     認め、`is_some`確認〜設定までロックを保持し続けTOCTOUを塞ぐ）
  3. `get_next_image`: 次の画像/動画取得（5枚先読みキャッシュ、advance後の永続化込み）。
     実ファイルが消えている画像に当たったら`MAX_MISSING_FILE_SKIPS`(20)回を上限に
     内部でさらに次へ進み直し、最初に実在する画像を返す（#62レビュー2巡目 N-S1。
     以前は1件消えただけで「No more images」のエラー画面になっていた）。
     #62レビュー3巡目 T-M1(must): ループの各反復の前に対象ディレクトリ自体の生死を
     確認し、無ければ一切advanceせず打ち切る（NAS/USB切断時に1回の呼び出しで
     最大20件ぶん未表示画像を無駄消費するのを防ぐ）。S-b: ファイル不在
     （`Missing`）とキャッシュ変換の失敗/タイムアウト（`ProcessingFailed`）を区別し、
     後者はループで繰り返さず即座に打ち切る（最悪20×5秒のブロックを防ぐ）。
     戻り値は`ImageNavigationResult`（#65、`#[serde(tag = "kind", content = "data")]`）
     — `found`/`emptyPlaylist`（ディレクトリ設定済みだが0件）/`loadFailed`
     （変換失敗/タイムアウト/上限到達）/`rootUnavailable`（ディレクトリ自体に
     アクセス不可）を区別する。フロントは`'No more images'`等の文字列比較をせず
     `kind`で分岐する（旧実装は成功以外を全て`Ok(None)`に潰していた）
  4. `get_previous_image`: 前の画像/動画取得（表示回数を増やさない、go_back後の永続化込み）。
     `get_next_image`と同様、消えたファイルは内部で読み飛ばす（N-S1）。ディレクトリ
     自体の生死確認とProcessingFailedの即時打ち切りも同様（T-M1/S-b）。戻り値も
     同じ`ImageNavigationResult`（#65）で、履歴の先頭に達して戻れない場合は
     `noHistory`（エラーではなく単純な境界）
  5. `open_in_explorer`: ファイルマネージャーで開く（OS別対応）
  6. `get_stats`: 統計情報取得
  7. `get_playlist_info`: プレイリスト情報取得（位置、総数、戻れるか）
  8. `get_last_directory_path`: 最後にスキャンしたフォルダパス取得
  9. `exit_app`: アプリケーション終了
  10. `save_setting`: 設定を保存
  11. `get_setting`: 設定を取得
  12. `pick_image`: 画像をPictures/sss-pickedフォルダにコピー
  13. `exclude_image`: 画像をDBの除外ルールに追加（日付/ファイル/フォルダ除外）。
      即時反映（file/date）は `Playlist::update_images` の直後に必ずフル保存する
      （#62レビューM2(must): 保存し忘れると再起動を跨いだときに除外した画像が復活する）
  14. `get_display_stats`: 統計データ取得（グラフ用、全画像の表示回数）
  15. `get_default_share_directory`: ピック先デフォルトパス取得
  16. `reset_all_data`: 全データ初期化（#64）。中核ロジックは`commands::system::
reset_core`（Tauri非依存の`pub fn`。`reset_all_data`本体と
      `tests/reset_all_data_e2e.rs`の両方から呼ぶ、#79レビューshould4）に切り出し。
      DBファイルは削除せず、開いた接続のまま`Database::reset_to_defaults`（対象は
      `USER_TABLES`定数、#79レビューshould3。`sqlite_sequence`もクリア）で全ユーザー
      データテーブル（`app_settings`含む）を1トランザクションで空にし既定除外ルールを
      再投入する（スキーマ・`user_version`は維持）。ピック済み画像ファイル自体は
      対象外（削除しない）。メモリ上の`playlist`/`directory_path`もクリアし、
      キャッシュクリア（`clear_cache_dir`、`cache_dir`は`AppState::cache_dir`を
      そのまま使いDBリセット後に追加のfallibleなパス解決をしない。#79レビュー
      should1）・ワーカーの失敗セットクリアも行った後、`app.restart()`でプロセス
      自体を再起動する。DBロックは`state.db.lock()`から`app.restart()`まで保持し
      続け、in-flightの`get_next_image`等の書き戻しを遮断する（#79レビュー nit。
      全DBコマンドがasyncなためデッドロックしない）。当初はasset scopeを
      `forbid_directory()`で明示的に取り消しフロントが`window.location.reload()`
      するだけの設計だったが、実測で「`forbid_directory`したディレクトリはその後
      `allow_directory`しても許可が復活しない（取り消すAPIが無い）」ことが判明し、
      初期化後に同じフォルダを選び直すと画像が二度と表示できなくなる実装バグだった
      ため撤回した。プロセス再起動なら asset scope・メモリ状態が新規プロセスとして
      確実に作り直される（詳細は`docs/architecture.md`§5⑤）。`tauri dev`実行時の
      挙動は未検証（`beforeDevCommand`ごとkillされ得る）で、実機確認は`tauri build`
      （`--debug`可）の成果物で行う。`scan_directory`と同じ`ScanGuard`で
      スキャンと排他する
  17. `get_ignore_patterns`: 除外ルール一覧を取得
  18. `remove_ignore_pattern`: 除外ルールを削除
  19. `add_ignore_pattern`: 除外ルールを手動追加
  20. `get_recent_images`: 最近表示した画像一覧（最新100件、除外済み除く）
  21. `get_picked_images`: ピック済み画像一覧
  22. `delete_picked_image`: ピック済み画像を削除
  23. `reset_all_display_counts`: 全画像の表示回数をリセット

## Reactコンポーネント構成

### src/App.tsx

- メインアプリケーションコンポーネント
- スライドショー制御ロジック
- マウスアイドル検出

### src/components/Slideshow.tsx

- 画像/動画表示コンポーネント
- Framer Motionによるフェードアニメーション

### src/components/OverlayUI.tsx

- グラスモーフィズムUI
- ファイル情報表示
- 操作ボタン

### src/components/Settings.tsx

- 設定モーダル
- フォルダ選択
- スキャン実行
- 結果表示

### src/hooks/useSlideshow.ts

- スライドショーロジック
- 10秒タイマー管理
- 再生/一時停止制御

### src/hooks/useMouseIdle.ts

- マウスアイドル検出
- 3秒タイムアウト

### src/lib/tauri.ts

- Tauriコマンドのラッパー関数

### src/types.ts

- TypeScript型定義

## パフォーマンス目標

- **起動時間**: <5秒（10万ファイル、差分スキャン時）
- **画像切り替え**: <100ms
- **メモリ使用量**: <500MB（通常動作時）
- **並列スキャン**: CPUコア数に応じた最適化

## クロスプラットフォーム対応

### Windows

- エクスプローラー連携: `explorer /select,<path>`
- スクリーンセーバー抑制: keepawake
- アイコン: icon.ico

### Linux

- ファイルマネージャー連携: nautilus/dolphin/xdg-open
- スクリーンセーバー抑制: keepawake
- アイコン: icon.png

### macOS

- Finder連携: `open -R <path>`
- スクリーンセーバー抑制: keepawake
- アイコン: icon.icns

## 運用に関する推奨事項

### 自動起動・終了（サイネージ用途）

アプリを常時稼働させる場合、OS側で管理することを推奨します：

**Windows: タスクスケジューラー**

- 起動トリガー: 毎日8:00に `sss.exe` を実行
- 終了タスク: 毎日22:00に `taskkill /IM sss.exe /F` を実行
- 利点: PCの再起動や停電からの復旧後も自動で動作

**Linux: cron / systemd timer**

- cronで毎日の起動・終了を設定
- systemd timerで柔軟なスケジュール管理

**macOS: launchd**

- plistファイルで起動・終了時刻を設定

アプリ内部に自動起動・終了機能は実装していません。これはOSレベルで管理する方がより確実で、クロスプラットフォーム対応も容易だからです。

## CI/CD

- **CI**: `.github/workflows/ci.yml` — push/PR to main で2ジョブ実行
  - `check`（ubuntu-22.04）: `npm run lint` / `npm run format:check` / `npm run build` / `npm test`（vitest）/ `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test`
  - `cross-platform`（windows-latest / macos-latest）: `cargo clippy --all-targets -- -D warnings` / `cargo test`。`#[cfg(windows)]`/`#[cfg(target_os = "macos")]` 配下のコード・実機限定テストは ubuntu だけでは一度もコンパイルされないため（#63 で発覚した Windows 固有バグの反省）
  - `npm run e2e` は CI に含めない（実ブラウザ/実ファイル前提のため手動実行）
- **Audit**: `.github/workflows/audit.yml`（ci.yml とは別ファイル）— `rustsec/audit-check` で `src-tauri` の Rust 依存関係を検査。`src-tauri/Cargo.toml`/`Cargo.lock` を変更する push/PR と、毎週月曜03:00 UTC の schedule（新規登録された既知脆弱性の検出用）でのみ実行し、無関係な変更で毎回は回さない
  - **ignore 方針**: 直せない/直す価値のない advisory（例: 上流未対応の unmaintained warning）が出た場合は、`rustsec/audit-check` の `ignore` 入力に advisory ID を追加し、なぜ ignore するか・いつ見直すかを同じ行にコメントで残す。安易な ignore 追加はせず、まず `cargo update` での解消を優先する
- **Release**: `.github/workflows/release.yml` — 手動 dispatch。`validate` ジョブで (1) dispatch 元ブランチが `main` であること (2) `version` 入力が `vX.Y.Z`（プレリリース識別子任意）の形式であること (3) 同名タグが未使用であること (4) 入力 version と `tauri.conf.json`/`Cargo.toml`/`package.json` の version 一致 (5) CHANGELOG.md に対応する `[version]` 節が存在すること (6) `npm test`/`cargo test` の通過、を順にチェックし、いずれか失敗で fail。通過後に3-OS matrix（macOS/Linux/Windows）で `tauri-action` がビルドし、release note は CHANGELOG.md の該当節へのリンク。**成果物は署名なし**（macOS Gatekeeper/Windows SmartScreen の回避手順は README に追記予定、#71）
  - **リリース手順**: 1. `tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json` の version を揃えて更新 2. CHANGELOG.md の `[Unreleased]` を `[X.Y.Z] - YYYY-MM-DD` に改名し、新しい空の `[Unreleased]` を上に用意 3. これらを含む PR を作成し main にマージ 4. GitHub Actions の `Release Build` を `workflow_dispatch` で実行し、`version` に `vX.Y.Z` を入力（main ブランチから実行すること） 5. `validate` → `build` の通過を確認し、GitHub Releases に3プラットフォーム分の成果物が揃ったことを確認する
- **Pre-commit**: Husky + lint-staged (`eslint --fix` + `prettier` for TS/JS, `prettier` for JSON/CSS/MD) + `cargo fmt`
- **CHANGELOG.md**: Keep a Changelog 形式。v1.0.0 以降の変更を記録。**本 PR（#70 CI/CD 整備）マージ以降、コード変更を伴う PR は自分の変更を `[Unreleased]` セクションに追記する**

## TODO: 仕様変更・機能追加

### 🔧 バグ修正

- [x] **keepawake設定の修正**: `.sleep(true)`を`.sleep(false)`に変更してノートPC蓋閉じ時のスリープを許可（ディスプレイスリープは抑制を継続）
- [ ] **表示回数の2重カウント問題**: 「前へ」で戻った画像を「次へ」で再度開いた場合、表示回数が2重にカウントされる問題を修正

### 📍 GPS/位置情報機能

- [x] **EXIF GPS座標の取得**: kamadak-exifでGPS情報（緯度・経度）を抽出
- [ ] **地図の埋め込み表示**: オーバーレイ内に地図を埋め込み表示（ボタンではなく）
  - 位置：左端、高さ2行分
  - GPS情報がある場合のみ表示
  - Google Maps API または Leaflet を使用

### 📤 ピック機能（SNS用候補選別）

- [x] **ファイルコピー機能**: オーバーレイの…メニューからピック（コピー）
- [x] **デフォルトコピー先**: `Pictures/sss-picked`フォルダ
- [x] **フォルダ自動作成**: コピー先フォルダが存在しない場合は自動作成
- [x] **視覚的フィードバック**: コピー完了時にステータスメッセージを表示
- [x] **設定画面でカスタマイズ**: コピー先フォルダパスを変更可能

### 🚫 除外機能（ignore_rulesテーブル連携）

- [x] **オーバーレイUIに「除外」ボタンを追加**
- [x] **除外時に3つの選択肢を表示**:
  1. **撮影日付で除外**: EXIF `DateTimeOriginal`優先で撮影日を抽出し、`rule_type="date"`のルールとして`ignore_rules`に追加。`exif_cache`で既に該当日と分かっている画像は即座にプレイリストから外す
  2. **このファイルだけ除外**: `globset::escape`したファイルパスを`rule_type="glob"`で`ignore_rules`に追加
  3. **このフォルダで除外**: `globset::escape`した親フォルダパス+`/**`（サブフォルダ含め再帰的）を`rule_type="glob"`で`ignore_rules`に追加
- [x] **即座にプレイリストから削除**: ファイル除外は即座、日付除外は`exif_cache`既知分のみ即座。それ以外（ディレクトリ除外・未取得の日付）は次回スキャンで反映
- [x] **視覚的フィードバック**: 除外完了時にステータスメッセージを表示（失敗時はエラーメッセージも表示）

### 🖼️ 画像回転の設定

- [ ] **EXIF Orientationの適用をON/OFF切り替え可能に**
- [ ] **設定画面に「EXIF回転を使用する」チェックボックス追加**
- [ ] **デフォルトはON**: 既存の動作を維持
- [ ] **OFFの場合**: EXIF Orientationを無視して画像を表示

### 🎨 オーバーレイUI全面刷新（実装済み: Issue #6）

- [x] **デフォルト非表示**: マウス移動でフェードイン、3秒アイドルでフェードアウト
- [x] **レイアウト**: 画面下部バー、4列×2行グリッド（上行=情報、下行=操作）
- [x] **デザイン**: グラスモーフィズム半透明背景、モノクロアイコン
- [x] **スライドショー制御**: オーバーレイ hover 中は一時停止、離れると再開
- [x] **上行（情報）**: 地図（GPS）| 撮影日時 | ファイル名 | 位置/回数
- [x] **下行（操作）**: …メニュー | ⏸/▶ | 前へ | 次へ
- [x] **…サブメニュー**: 開く、ピック、除外(3粒度)、設定、ウィンドウモード切替
- [x] **⚙️設定ボタン**: 右上に常時表示

### 📊 設定画面と統計機能

- [ ] **スキャン結果表示の変更**:
  - スキャン直後のみ表示（追加/更新/削除ファイル数、総数）
  - 設定画面を閉じたら統計情報をクリア
  - 再度開いたときは古い情報を表示しない（混乱防止）
- [ ] **統計グラフの追加**:
  - 横長の棒グラフまたは折れ線グラフ
  - 横軸：写真のソート順ID（ファイルパスA-Z順）
  - 縦軸：各写真の表示回数
  - 目的：完全平等ランダムアルゴリズムの検証
  - 理想状態：全ての写真が均等に表示される（全て0→全て1→全て2...）
  - 異常検出：特定の写真だけ表示回数が偏っている場合、バグと判断可能
- [ ] **表示回数のリセット設定**:
  - 設定画面に「フォルダ変更時に表示回数をリセットする」チェックボックス追加
  - デフォルトはON（自動リセット）
  - ONの場合：フォルダを選び直すたびに全ての表示回数を0にリセット
  - OFFの場合：表示回数を保持し続ける（全体的な統計を維持）

### 🎬 動画対応の完全実装

- [x] 動画ファイル形式の判定（mp4, webm, ogg, ogv, m4v）
- [x] 動画プレーヤーコンポーネント（`<video>` タグ、object-fit: contain）
- [x] 動画の自動再生と停止制御（onEnded で次送り）
- [x] 動画の長さに応じた表示時間調整（タイマーではなく再生終了イベント）
- [ ] 動画メタデータの取得（再生時間、コーデック、解像度など）
- [ ] ffmpeg同梱による旧フォーマット変換再生（#45: avi, mkv, flv, wmv等）

### ⚙️ その他の機能拡張

- [ ] リモートフォルダ対応（ネットワークドライブ、NAS）

### 📱 Tauri 2アップグレードとモバイル対応

- [x] **Tauri 2へのアップグレード**:
  - Tauri v1.x → v2.xへの移行
  - 依存関係の更新とAPIの変更対応
  - パフォーマンスとセキュリティの改善
  - 起動時の白いウィンドウ問題を解決（backgroundColor設定）
  - プラグインシステムへの移行完了
- [ ] **Android対応**:
  - Tauri 2のAndroidサポートを活用
  - タブレット最適化（タッチ操作、ジェスチャー対応）
  - レスポンシブレイアウトの実装
- [ ] **iOS対応**（オプション）:
  - iPad向けの最適化
  - タッチインターフェース対応
- [ ] **タッチ操作の実装**:
  - スワイプジェスチャーで前後移動
  - ピンチズームでオーバーレイUI表示/非表示
  - ダブルタップで一時停止/再生
- [ ] **モバイルUI最適化**:
  - 画面サイズに応じた柔軟なレイアウト
  - タブレット向けの大きなボタンとタップエリア
  - 縦画面・横画面の両対応

---

## Tauri 2への移行（2025-11-05 完了）

### 主要な変更点

#### 1. プラグインシステムへの移行

Tauri v1のallowlist機能が、v2では新しいプラグインシステムとパーミッションモデルに置き換わりました：

- `tauri-plugin-dialog`: ファイル選択ダイアログ
- `tauri-plugin-opener`: URLを開く（`tauri-plugin-shell`の`open`はv2で非推奨のため移行、#59）
- `tauri-plugin-single-instance`: 単一インスタンス管理

#### 2. APIの変更

- `@tauri-apps/api/tauri` → `@tauri-apps/api/core`にリネーム
- `app.path_resolver()` → `app.path()`に変更
- `convertFileSrc`の動作はほぼ同じだが、内部実装が改善

#### 3. 起動時の白いウィンドウ問題の解決

`tauri.conf.json`に以下の設定を追加：

```json
{
  "backgroundColor": "#000000"
}
```

これにより、HTMLロード前からウィンドウ背景が黒になり、白いフラッシュが発生しなくなりました。

#### 4. 依存関係の更新と最適化

- Vite v5 → v7
- rusqlite v0.31 → v0.32
- image v0.24 → v0.25
- rayon v1.8 → v1.x
- **base64を削除**: Tauriの`convertFileSrc()`を使用するため不要に
- 画像表示方法の改善: ファイルパスベース（Tauriプロトコル経由）
- その他多数のTauri関連クレート更新

#### 5. ビルド設定

`.cargo/config.toml`を追加してビルドジョブ数を1に制限：

```toml
[build]
jobs = 1
```

これにより、SQLiteコンパイル時のメモリ不足エラーを回避しました。

### モバイル対応の準備

Tauri v2はAndroidとiOSに対応しており、将来的なタブレット版の開発が可能になりました。

---

## 今後の実装予定（アーカイブ）

このセクションは上記TODOに統合されました。

## 注意事項

- **削除機能なし**: 誤操作防止のため、アプリからファイルを削除する機能は実装しない
- **EXIF情報**: 画像のみ対応。動画にはEXIF情報がないため、ファイル情報のみ表示
- **4K最適化**: 表示前に画像をリサイズすることで、メモリ使用量を抑制
- **SQLite**: 単一ファイルDBなので、バックアップが容易

## ライセンス

MIT License

## 参考リソース

- Tauri v2 ドキュメント: https://v2.tauri.app/
- Tauri v2 移行ガイド: https://v2.tauri.app/start/migrate/from-tauri-1/
- kamadak-exif: https://crates.io/crates/kamadak-exif
- rayon: https://crates.io/crates/rayon
- Framer Motion: https://www.framer.com/motion/

## デザインシステム

UIの生成・修正時は `DESIGN.md` に定義されたデザインシステムに従うこと。定義外の色・フォント・スペーシングを勝手に使わない。
