# Smart Slide Show (sss) - プロジェクト仕様書

## プロジェクト概要

**アプリ名**: sss (Smart Slide Show)
**作者**: kako-jun
**目的**: 10万枚以上の写真・動画を公平に表示するスライドショーアプリ

## 技術スタック

### バックエンド
- **フレームワーク**: Tauri v1.5
- **言語**: Rust (edition 2021)
- **データベース**: SQLite (rusqlite v0.31, bundled)
- **並列処理**: rayon v1.8
- **ファイル走査**: walkdir v2.4
- **フィルタリング**: globset v0.4
- **EXIF読み取り**: kamadak-exif v0.6 (画像のみ)
- **画像処理**: image v0.24
- **画像エンコーディング**: base64 v0.21
- **ランダム生成**: rand v0.8
- **スクリーンセーバー抑制**: keepawake v0.4 (クロスプラットフォーム対応)

### フロントエンド
- **フレームワーク**: React 18 + TypeScript
- **ビルドツール**: Vite
- **アニメーション**: Framer Motion
- **スタイリング**: TailwindCSS
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
  - 動画: MP4, MOV, AVI, MKV など
- **表示モード**: 4K最適化 (3840x2160)
- **画像処理**: 4Kを超える画像は自動リサイズ (Lanczos3フィルタ)
- **画像ロード**: base64エンコーディングでクロスプラットフォーム対応
- **先読みキャッシュ**: 5枚先まで先読み（直列処理、弱いCPU対応）
- **動画処理**: ネイティブサイズで表示

### 3. .sssignoreフィルタリング
- gitignoreスタイルのパターンマッチング
- globsetライブラリによる高速フィルタリング
- 対象ファイル: `.sssignore`
- 配置場所: ユーザーホームディレクトリ (Windows: %USERPROFILE%、Unix: $HOME)

### 4. 表示履歴管理
- **SQLiteテーブル**: `image_stats`
- **記録情報**:
  - 表示回数 (`display_count`)
  - 最終表示日時 (`last_displayed`)
- **用途**: 表示統計の可視化、公平性の検証

### 5. 差分スキャン
- 前回スキャン時のファイル情報をSQLiteに保存
- ファイルサイズと更新日時で変更を検出
- 変更されたファイルのみ再処理
- **高速起動**: 10万枚規模でも数秒で起動可能

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
   - 📸 カメラ情報（画像のみ、EXIF: メーカー、モデル、焦点距離、F値、ISO、露出時間）
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

### playlist_state テーブル
```sql
CREATE TABLE playlist_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    shuffled_list TEXT NOT NULL,  -- JSON array
    current_index INTEGER DEFAULT 0,
    history TEXT NOT NULL  -- JSON array
);
```
- **用途**: プレイリスト状態の永続化

### ignore_rules テーブル
```sql
CREATE TABLE ignore_rules (
    pattern TEXT PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```
- **用途**: .sssignoreルールのキャッシュ

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
- アプリケーションエントリーポイント
- Tauriコマンドの登録
- スクリーンセーバー抑制の初期化
- キャッシュディレクトリの管理

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
- .sssignoreファイルの読み込み
- globsetによるパターンマッチング

### src-tauri/src/playlist.rs
- シャッフルアルゴリズム実装
- 履歴管理
- 状態の永続化

### src-tauri/src/image_processor.rs
- 画像の最適化（4Kリサイズ）
- EXIF情報抽出
- 画像サイズ取得

### src-tauri/src/commands.rs
- Tauriコマンドハンドラ（9つ）
  1. `scan_folder`: フォルダスキャン
  2. `init_playlist`: プレイリスト初期化
  3. `get_next_image`: 次の画像/動画取得（5枚先読みキャッシュ）
  4. `get_previous_image`: 前の画像/動画取得
  5. `open_in_explorer`: ファイルマネージャーで開く
  6. `get_stats`: 統計情報取得
  7. `get_playlist_info`: プレイリスト情報取得
  8. `get_last_folder_path`: 最後にスキャンしたフォルダパス取得
  9. `exit_app`: アプリケーション終了

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

## TODO: 仕様変更・機能追加

### 🔧 バグ修正
- [x] **keepawake設定の修正**: `.sleep(true)`を`.sleep(false)`に変更してノートPC蓋閉じ時のスリープを許可（ディスプレイスリープは抑制を継続）
- [ ] **表示回数の2重カウント問題**: 「前へ」で戻った画像を「次へ」で再度開いた場合、表示回数が2重にカウントされる問題を修正

### 📍 GPS/位置情報機能
- [x] **EXIF GPS座標の取得**: kamadak-exifでGPS情報（緯度・経度）を抽出
- [x] **カメラ情報の削除**: EXIF表示からメーカー、モデル、焦点距離、F値、ISO、露出時間を削除（撮影日時のみ残す）
- [ ] **地図の埋め込み表示**: オーバーレイ内に地図を埋め込み表示（ボタンではなく）
  - 位置：左端、高さ2行分
  - GPS情報がある場合のみ表示
  - Google Maps API または Leaflet を使用

### 📤 シェアマーク機能（SNS用候補選別）
- [ ] **ファイルコピー機能**: オーバーレイUIに「シェアマーク」ボタンを追加し、クリックでファイルをコピー
- [ ] **デフォルトコピー先**: `Pictures/sss`フォルダ（Windows: `%USERPROFILE%\Pictures\sss`、Linux/macOS: `~/Pictures/sss`）
- [ ] **フォルダ自動作成**: コピー先フォルダが存在しない場合は自動作成
- [ ] **視覚的フィードバック**: コピー完了時にトースト通知を表示
- [ ] **設定画面でカスタマイズ**: コピー先フォルダパスを変更可能に
- [ ] **重複ファイル処理**: 同名ファイルが存在する場合の処理（上書き/リネーム/スキップ）

### 🚫 除外機能（.sssignore連携）
- [ ] **オーバーレイUIに「除外」ボタンを追加**
- [ ] **除外時に3つの選択肢を表示**:
  1. **撮影日付で除外**: EXIF DateTimeから日付を抽出し、その日付を含むパスにマッチするパターンを.sssignoreに追加
  2. **このファイルだけ除外**: 特定のファイル名パターンを.sssignoreに追加
  3. **このフォルダで除外**: 親フォルダパスを.sssignoreに追加
- [ ] **即座にプレイリストから削除**: .sssignore更新後、該当ファイルをプレイリストから除外
- [ ] **視覚的フィードバック**: 除外完了時にトースト通知を表示

### 🖼️ 画像回転の設定
- [ ] **EXIF Orientationの適用をON/OFF切り替え可能に**
- [ ] **設定画面に「EXIF回転を使用する」チェックボックス追加**
- [ ] **デフォルトはON**: 既存の動作を維持
- [ ] **OFFの場合**: EXIF Orientationを無視して画像を表示

### 🎨 オーバーレイUI全面刷新
- [ ] **常時表示**: マウス移動不要、常に画面下部に表示
- [ ] **レイアウト**: 画面下部にぴったり貼り付け、左右フル幅、高さ2行程度
- [ ] **デザイン**: 目立たないモノクロアイコン、半透明背景
- [ ] **スライドショー制御の変更**:
  - デフォルト：オーバーレイ表示中でもスライドショー継続
  - オーバーレイにマウスオーバー/タップ → スライドショー一時停止
  - オーバーレイ以外をタップ → スライドショー再開
- [ ] **左側（閲覧情報）**:
  - 地図（2行分の高さ、GPS情報がある場合のみ、左端）
  - 撮影日時（デジタル時計風の大きめ表示、地図の横）
  - その他情報（ファイル名、サイズ、プレイリスト位置、表示回数など、コンパクトに）
- [ ] **右側（操作アイコン）**:
  - 前へ、次へ、開く、シェア、除外、設定
  - モノクロ、目立たないデザイン

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
- [ ] 動画ファイル形式の判定
- [ ] 動画プレーヤーコンポーネント
- [ ] 動画の自動再生と停止制御
- [ ] 動画の長さに応じた表示時間調整
- [ ] 動画メタデータの取得（時長、コーデック、解像度など）

### ⚙️ その他の機能拡張
- [ ] **表示間隔のカスタマイズ**: 設定画面から秒数を変更可能に（現在は10秒固定）
- [ ] リモートフォルダ対応（ネットワークドライブ、NAS）

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

- Tauri ドキュメント: https://tauri.app/
- kamadak-exif: https://crates.io/crates/kamadak-exif
- rayon: https://crates.io/crates/rayon
- Framer Motion: https://www.framer.com/motion/
