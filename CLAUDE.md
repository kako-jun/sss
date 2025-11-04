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
- **EXIF読み取り**: kamadak-exif v0.5 (画像のみ)
- **画像処理**: image v0.24
- **ランダム生成**: rand v0.8

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
- **表示間隔**: 10秒固定
- **対象ファイル**:
  - 画像: JPG, PNG, GIF, BMP, WEBP など
  - 動画: MP4, MOV, AVI, MKV など
- **表示モード**: 4K最適化 (3840x2160)
- **画像処理**: 4Kを超える画像は自動リサイズ (Lanczos3フィルタ)
- **動画処理**: ネイティブサイズで表示

### 3. .sssignoreフィルタリング
- gitignoreスタイルのパターンマッチング
- globsetライブラリによる高速フィルタリング
- 対象ファイル: `.sssignore`
- 配置場所: スキャン対象フォルダのルート

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

### 6. UI/UX

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
   - ファイル名
   - ファイルパス
   - ファイルサイズ
   - 撮影日時（画像のみ、EXIFから取得）
   - 画像サイズ（幅x高さ）
   - カメラ情報（画像のみ、EXIF: メーカー、モデル、焦点距離、F値、ISO、露出時間）
   - 動画の場合: EXIF情報なし、ファイル情報のみ表示

2. **プログレス表示**
   - 現在位置 / 総数（例: 1,234 / 100,000）

3. **操作ボタン**
   - **Resume**: スライドショー再開
   - **Previous**: 前の画像/動画に戻る（履歴から取得、表示回数をインクリメントしない）
   - **Open in Explorer**: ファイルマネージャーで開く（Windows: explorer /select、Linux: nautilus/dolphin/xdg-open）
   - **Settings**: 設定画面を開く

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
- Tauriコマンドハンドラ（7つ）
  1. `scan_folder`: フォルダスキャン
  2. `init_playlist`: プレイリスト初期化
  3. `get_next_image`: 次の画像/動画取得
  4. `get_previous_image`: 前の画像/動画取得
  5. `open_in_explorer`: ファイルマネージャーで開く
  6. `get_stats`: 統計情報取得
  7. `get_playlist_info`: プレイリスト情報取得

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
- アイコン: icon.ico

### Linux
- ファイルマネージャー連携: nautilus/dolphin/xdg-open
- アイコン: icon.png

## 今後の実装予定

### 動画対応の完全実装
- [ ] 動画ファイル形式の判定
- [ ] 動画プレーヤーコンポーネント
- [ ] 動画の自動再生と停止制御
- [ ] 動画の長さに応じた表示時間調整（現在は10秒固定）
- [ ] 動画のサムネイル生成（オプション）
- [ ] 動画メタデータの取得（時長、コーデック、解像度など）

### その他の機能拡張
- [ ] 表示間隔のカスタマイズ
- [ ] お気に入り機能（削除しない前提で）
- [ ] 表示統計のグラフ化
- [ ] スライドショーのエクスポート（HTML/動画）
- [ ] リモートフォルダ対応（ネットワークドライブ）

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
