# Smart Slide Show (sss) - プロジェクト仕様書

## プロジェクト概要

**アプリ名**: sss (Smart Slide Show)
**作者**: kako-jun
**目的**: 10万枚以上の写真・動画を公平に表示するスライドショーアプリ

## 技術スタック

### バックエンド

- **フレームワーク**: Tauri v2 (最新版、モバイル対応準備)
- **言語**: Rust (edition 2021)
- **データベース**: SQLite (rusqlite v0.40, bundled)
- **並列処理**: rayon v1
- **ファイル走査**: walkdir v2
- **フィルタリング**: globset v0.4
- **EXIF読み取り**: kamadak-exif v0.6 (画像のみ)
- **画像処理**: image v0.25
- **キャッシュ管理**: md5 v0.8 (ファイル名ハッシュ生成)
- **ランダム生成**: rand v0.9
- **ホーム/標準ディレクトリ解決**: dirs v7（ピック先の既定 `Pictures/sss-picked` やホーム判定）
- **スクリーンセーバー抑制**: keepawake v0.6 (クロスプラットフォーム対応)
- **OSロケール取得**: sys-locale v0.3（`get_os_locale`用。`tauri-plugin-os`は使わない）
- **プラグイン**（`lib.rs` の `run()` で登録。`Cargo.toml` の下限は JS 側 `@tauri-apps/plugin-*` の minor に揃える）:
  - tauri-plugin-dialog 2.8 (フォルダ選択ダイアログ。Rust 側 API のみ使用し、JS 側の権限は付与しない #93)
  - tauri-plugin-opener 2.6 (URLを開く。capability は `https://*` のみ許可)
  - tauri-plugin-process 2.4 (フロントの `exit(0)`。capability は `process:allow-exit` のみ)
  - tauri-plugin-single-instance 2.5 (単一インスタンス。JS側パッケージなし)
  - tauri-plugin-window-state 2.4 (ウィンドウ状態の保存/復元、#78)

### フロントエンド

- **フレームワーク**: React 19 + TypeScript
- **ビルドツール**: Vite v7
- **アニメーション**: Framer Motion
- **スタイリング**: TailwindCSS v3
- **アイコン**: Lucide React
- **グラフ**: uPlot（統計タブのヒストグラム）
- **テスト**: vitest + Testing Library（jsdom）、実ブラウザ e2e は playwright-core（`e2e/`、ローカル専用）

## コア機能

### 1. 完全平等ランダム表示

- アルゴリズム: Complete Equality Shuffle
- 全画像をシャッフルしたリストを作成
- リストを順番に表示
- 全て表示完了後、再シャッフル
- 同じ画像が連続して表示されないことを保証

### 2. スライドショー

- **表示間隔**: 5〜60秒でカスタマイズ可能（設定画面から変更）
- **動画の音声・最大再生時間**（#68）: 設定画面オプションタブの「動画」セクション。`app_settings` の `video_audio_enabled`（`'true'|'false'`、既定オフ=無音）と `video_max_duration_sec`（秒、`0`=無制限が既定、選択肢は `0/30/60/120/300`）。既存の `save_setting`/`get_setting` に乗せ、Rust側の検証・コマンド追加は無い。破損値は `constants.ts` の `parseVideoAudioEnabled`/`parseVideoMaxDuration`/`normalizeVideoMaxDuration` が既定へ丸める（`clampDisplayInterval` と同じ「唯一の検証経路」）。`Slideshow.tsx` は音声オンなら `muted=false`、上限は壁時計タイマーでなく `timeupdate` の `currentTime` で判定し、`ended` と共通の `finishVideo`（`finishedKeyRef` で1本につき1回）から `onAdvance` する。詳細は `docs/architecture.md` §6-(h)
- **対象ファイル**:
  - 画像: JPG/JPEG, PNG, GIF, BMP, WEBP, TIFF/TIF（`scanner.rs` の `IMAGE_EXTENSIONS`）
  - 動画: MP4, WebM, OGV, M4V（`VIDEO_EXTENSIONS`。旧フォーマットはffmpeg同梱後に対応予定 #45）
- **表示モード**: 4K最適化 (3840x2160)
- **ウィンドウ状態の記憶**（#78）: `tauri-plugin-window-state` を `lib.rs` の `run()` で登録する（`StateFlags::all() & !VISIBLE`＝全画面/最大化・位置・サイズ・装飾を保存/復元し、表示状態は対象外）。保存はアプリ終了時（`RunEvent::Exit`、`exit_app`/`exit(0)`/ウィンドウを閉じる）にアプリ設定ディレクトリの `.window-state.json` へ、復元はウィンドウ生成時（フロント起動前）。保存位置がどの実在ディスプレイにも交差しなければ位置は復元せずOS既定位置に出る（ディスプレイが外れた場合）。初回起動（状態ファイル無し）は `tauri.conf.json` の全画面のまま。`taskkill /F` 等の強制終了では保存されない（サイネージ用途の運用メモ）。全データ初期化（`reset_all_data`）はこのファイルを消さない（DBの設定ではないため）。フロントは `getCurrentWindow().isFullscreen()` で実態へ同期する既存の仕組みでそのまま追従する
- **EXIF回転**: `img`要素に`crossOrigin`/`image-orientation`を明示指定せず、WebView既定の動作（`image-orientation: from-image`＝EXIFに従い自動回転）に任せる。`apply_exif_rotation=false`なのにEXIFが回転を要求している画像だけ例外で、バックエンドが「格納画素のまま・EXIF無し」のキャッシュに差し替える（原本を返すとWebViewが勝手に回転し設定と食い違うため）。crossOriginを付けてCSSで明示切替する設計は、wryのWebKitGTK実装がassetスキームをCORS有効登録しておらずLinux本番で画像が出なくなるリスクがあるため撤去した
- **画像処理**: 4K超/WebView非対応形式(TIFF等)/`apply_exif_rotation=false`時の回転要求のいずれかに該当する画像だけをキャッシュ対象にし、自動リサイズ(Lanczos3フィルタ)でキャッシュフォルダに保存。出力フォーマットはデコード後の実データのアルファ有無で決定(透過ならPNG、無ければJPEG品質90%明示)。アニメGIF/WebPは静止フレーム化を避けるため常にキャッシュ対象外（**既知の制約**: そのためEXIF回転タグ付きのWebPは`apply_exif_rotation=false`でもWebViewが回転する。Linuxは`image-orientation`既定が`from-image`になるWebKitGTK 2.30以降を想定。設定画面のサムネイルは設定に関わらず常に向きを焼き込む）
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
- **更新日時（mtime）の不一致だけ**で変更を検出する（`file_size` はDBに記録するが判定には使わない）。前回無かったパスは新規、mtime が変わったパスは変更として区別
- 変更されたファイルのみDBへ反映（新規/変更分のみのupsert＋確定削除分の削除を1トランザクションで、#63）
- **高速起動**: 10万枚規模でも数秒で起動可能
- `walkdir`/ファイル単位のメタデータ取得エラー（1970年より前のmtime含む）は件数・代表例を結果に残し、該当パス配下は削除せず「不明」として扱う（#63）

### 6. スクリーンセーバー抑制

- アプリ起動中は常にスクリーンセーバーとディスプレイスリープを抑制
- クロスプラットフォーム対応 (Windows/Linux/macOS)
- keepawakeクレートによる実装

### 7. UI/UX

#### 通常表示

- 初回起動は全画面（`tauri.conf.json`: `fullscreen: true` / `decorations: false` / 背景 `#000000`）。F / F11 や右上のボタンでウィンドウモードへ切り替えられ、以後は前回の状態を復元する（#78）
- 画像/動画を中央に表示（object-fit: contain）
- 背景: 黒
- UI非表示（マウスを動かすと表示）

#### マウス移動時

- オーバーレイUI表示（グラスモーフィズムデザイン）
- 3秒間アイドル状態でUI非表示（オーバーレイ・右上の常設ボタン列（終了・ショートカット・
  ウィンドウモード・設定）・マウスカーソル自体（`cursor-none`）の3つが同時に消える。#66。
  設定モーダルを開いている間はUI操作中のためカーソルは隠さない）
- **一時停止の条件**: マウス移動そのものでは一時停止しない。`isPlaying = 初期化済み && !ユーザーの一時停止 && !オーバーレイ操作バーにホバー中 && !設定画面表示中`（`App.tsx`）。右上のボタン列にホバーしてもidleタイマーは止まるが再生は止まらない

#### オーバーレイUI内容（#66視覚刷新: 画面下中央に浮かぶ角丸バー1本。左=情報・中央=主要操作・右=副次操作）

1. **左: ファイル情報**（情報が無い項目は表示しない。#66）
   - 📍 GPS座標がある画像だけ、小さな地図サムネイル（クリックでGoogleマップ、EXIF: 緯度・経度）
   - 📅 撮影日（EXIFにある画像だけ）
   - 📁 ファイル名 · プレイリスト位置: 現在位置 / 総数（例: 1,234 / 100,000）
   - 💾 ファイルサイズ・🔢 表示回数・🕒 最新表示（ISO 8601形式）は本文に出さず、ファイル名のtitleツールチップにまとめる
   - 動画の場合: EXIF情報なし、ファイル名・位置のみ表示

2. **中央: 主要操作**
   - **前へ**: 前の画像/動画に戻る（履歴から取得、表示回数をインクリメントしない）
   - **⏸/▶**: 一時停止/再開をトグル
   - **次へ**: 次の画像/動画へ進む（即座に表示）

3. **右: 副次操作**
   - **ピック**（手のアイコン）: ファイルをピック先フォルダにコピー

- **取り消し**（#78）: 除外/ピックの直後は約6秒だけ、状態メッセージの代わりに「取り消す」ボタン付きのトーストを出す（idleフェードの外に置くので、マウスを動かさなくても押せる。確認ダイアログは増やさない）。直近の1件のみ。トーストはホバー中・フォーカス中はタイマー停止（離れたら残りから再開）。戻るものが無い除外の取り消しは `undoExcludeNothing` を表示。`undo_exclude` は現在のスキャンルート配下の画像だけ復帰。再スキャン後の directory/date 除外の取り消しは画像が自動では戻らない（既知の挙動、自動再スキャンは重いため行わない）。除外の取り消し=`undo_exclude`、ピックの取り消し=既存の `delete_picked_image`（コピーしたファイルだけを削除）
- **…メニュー**: 開く（ファイルマネージャー、Windows: explorer /select、macOS: `open -R`、Linux: nautilus/dolphin/xdg-open）・ピックを見る（設定のピックタブを開く）・除外（撮影日付で除外／フォルダを除外／ファイルを除外の3粒度）

4. **UI操作**
   - マウス移動で表示、3秒アイドルで自動非表示（右上の常設ボタン・マウスカーソル自体も同時に非表示、#66）。「外クリックで非表示」は実装していない
   - オーバーレイの操作バーにマウスを乗せている間だけ一時停止し、離れると再開（`isOverlayHovered`）
   - 進捗はバーとは独立した、写真下端の画面幅いっぱいの極細ラインで表示（#66）
   - 右上の常設ボタン列（左から）: ショートカット一覧・ウィンドウモード切替・設定・終了

#### キーボードショートカット

- **ESC**: アプリを終了。**設定画面・後述のショートカット一覧・オーバーレイの「…」メニューを開いている間は
  それを閉じるだけ**でアプリは終了しない（#66）。入力欄（text系input/textarea/
  contentEditable）にフォーカスがある間は、閉じる・終了のどちらも行わず、入力欄のフォーカスを外す（blur）だけ
- **左矢印キー**: 前の画像/動画へ戻る
- **右矢印キー**: 次の画像/動画へ進む
- **Space**: 一時停止/再開を切り替える（#66。フォーカスがボタン等の操作可能な要素に
  ある場合は無効化し、その要素自身のクリック相当の挙動と二重に作用しないようにする）
- **F / F11**: フルスクリーンとウィンドウモードを切り替える（右上のボタンと同じ処理を
  呼ぶ、#66）
- **写真クリック**（#78）: 一時停止/再開のトグル（`Space` と同じ状態を切り替える）。350ms以内の連打（ダブルクリック）は1回に畳む（`lib/photoGestures.ts` の `createClickDebouncer`）。クリック時に `resetIdle()` でオーバーレイを起こし、⏸/▶の状態が見えるようにする
- **写真上のホイール/トラックパッド横スワイプ**（#78）: 縦横で絶対値の大きい軸の累積が40px相当を超えたら前/次へ1回だけ（下・左スワイプ=次、上・右スワイプ=前）。発火後は200ms以上イベントが途切れるまでロック（慣性スクロールで多重に進まない。`createWheelNavigator`）。`ctrl`/`meta`+ホイール（ピンチ）は無視
- 写真上の操作は `App.tsx` が `Slideshow` だけを包む `display: contents` のラッパーに付ける。オーバーレイ・右上ピル・モーダル・案内画面は兄弟要素なので干渉しない
- **?**: キーボードショートカット一覧のオーバーレイを開閉する（右上のキーボード
  アイコンボタンからも同じものを開ける、#66）
- 設定画面を開いている間は ESC 以外のショートカット（Space/F/F11/?/矢印キー）はすべて無効。ショートカット一覧を開いている間は `?`（閉じる）・矢印キー・ESC のみ有効
- キーリピート（押しっぱなし）による多重発火は無視する（`e.repeat`、#65）

#### アクセシビリティ（#66）

- 設定モーダル・ショートカット一覧はどちらも `role="dialog"` `aria-modal="true"`
  を持ち、開くとモーダル内へフォーカストラップする（`Tab`/`Shift+Tab`でモーダルの
  外（背後の写真オーバーレイ等）へフォーカスが漏れない。閉じると元の要素へ戻す）
- 設定タブは `role="tablist"`/`role="tab"`/`aria-selected` を持ち、ロービング
  tabIndexと矢印キー（←/→/Home/End）でのタブ間移動に対応する
- キーボード操作時のフォーカスリング（`:focus-visible`）は白60%不透明度・2px
  （旧15%は黒背景に対して非text コントラスト比が不足していた）
- 除外ルール解除・ピック削除・履歴除外などhoverで強調されるボタンは、hoverしなくても
  既定で薄く（40%不透明度）見え、hover/keyboardフォーカスの両方で強調される
  （タッチ操作・キーボード操作でも見えないボタンを作らない）

#### 案内画面・通知（#65）

`get_next_image`/`get_previous_image` の結果は `ImageNavigationResult`（`kind`で
区別、詳細は下記API一覧）で意味ごとに分岐し、状況に応じた画面/通知を出す:

- **ようこそ画面**: ディレクトリが一度も設定されていない（本当に未設定の）時だけ。
  「フォルダを選択」ボタンと、「? ショートカット一覧を表示」ヒントを表示する。ヒントは
  `<button>`で、クリック（Enter/Space）でも`?`キー・右上ボタンと同じショートカット一覧を
  開ける（#100。`setShortcutsOpenedViaMouse(e.detail > 0)`も右上ボタンと同じ）
- **空プレイリスト**: ディレクトリは設定済みだが除外ルール等で表示対象が0件の場合、
  専用の案内（「表示できる写真がありません」）を出す。ようこそ画面とは区別する
- **フォルダ接続不可**（NAS/USB切断等）: 直前の画像を維持したまま、控えめな
  日本語通知（「フォルダに接続できません。再接続をお待ちください…」）を出す。
  鑑賞中の画像を消さない
- **読込失敗**: 自動で次の画像へ進む（連続失敗が上限に達したら諦めて通知に切替）。
  ユーザー操作を要求しない
- **起動時自動スキャンで前回ディレクトリが拒否された場合**: 理由をようこそ/
  案内画面に表示する（以前は`console.error`のみで握りつぶしていた）

文言は `src/lib/i18n/dictionaries/{ja,en}.ts` にキー→文言のフラットな辞書として
集約し、`t(key, params?)`（`src/lib/i18n/t.ts`）で参照する（#80。旧
`src/lib/messages.ts` の `uiText`/`noticeMessages` はこの辞書に統合され削除済み）。

#### 設定画面

`components/Settings/index.tsx` が7タブを持つ（`TabType`: `scan`/`options`/`exclude`/`pick`/`history`/`stats`/`info`）。開くとスライドショーは一時停止し、閉じると再開する。ようこそ画面のボタンは `scan` タブで開く。

| タブ（ja / en）            | 内容（コンポーネント）                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| フォルダ / Folder          | 「選択」（Rust側ダイアログで選んで即スキャン、#93）・「スキャン」（前回フォルダの再スキャン）・スキャン結果（ファイル数・新規・削除・処理時間・読み取りエラー）（`ScanSection`）。スキャン後も設定画面は閉じない |
| オプション / Options       | 表示間隔5〜60秒（`IntervalSection`）・EXIF回転（`SettingsSection`、`apply_exif_rotation`）・動画の音声/最大再生時間（`VideoSection`）・ピック先（`ShareDirectorySection`）・言語（`LanguageSection`）            |
| 除外ルール / Exclude Rules | ルール一覧・解除・手動追加（`ExcludeRulesSection`）                                                                                                                                                              |
| ピック / Picks             | ピック済みメディアのサムネイル一覧・削除（`PickSection`）                                                                                                                                                        |
| 履歴 / History             | 最近表示した100件のサムネイル一覧・除外（`HistorySection`）                                                                                                                                                      |
| 統計グラフ / Stats         | 表示回数ヒストグラム・表ビュー・表示回数リセット（`GraphSection`）                                                                                                                                               |
| 情報 / Info                | バージョン・GitHubリンク・全データ初期化（ボタン「すべてのデータを初期化」/ "Reset All Data"。確認ダイアログの文言は `InfoSection` と辞書が正本）                                                                |

保存キー（`app_settings`）: `last_directory_path` / `display_interval`（ms） / `apply_exif_rotation` / `share_directory_path` / `language` / `video_audio_enabled` / `video_max_duration_sec` / `sssignore_migrated`。

### 8. 国際化（i18n、#80）

- **辞書**: `src/lib/i18n/dictionaries/{ja,en}.ts`。キー→文言のフラットなオブジェクト（ネストしない）。`{param}`形式のプレースホルダは `t(key, params?)`（`src/lib/i18n/t.ts`）が置換する
- **★ 新しい文言を追加する時のルール（必ず守る）**: UIに新しい文言を書くときは、コンポーネントに直書きせず必ず `ja.ts`/`en.ts` の**両方に同じキーを同時に追加**してから `t()` で参照する。片方だけ追加した状態でコミットしない（`src/lib/i18n/messages.test.ts` がキー集合の不一致・未使用キー・直書き日本語を検出して落ちる）
- **言語決定**: `app_settings.language`（`'ja'|'en'|'auto'`、既定 `auto`）→ `auto` はOSロケールを優先し、取得できない場合だけ `navigator.language`（`ja`で始まればja、それ以外en）にフォールバックする。OSロケールはバックエンドの `get_os_locale`（`src-tauri/src/commands/settings.rs`、`sys-locale`クレート）で取得する。`tauri-plugin-os`は使わず素の`#[tauri::command]`にした（capability許可の追加を避けるため。#82レビュー）。`navigator.language`はmacOSのWKWebViewで`CFBundleLocalizations`（Info.plist）にアプリが対応言語として明示していないロケールだと実際のOS設定に関わらず`en-US`固定になる既知の制約があるため、OSロケールを優先する。`src/lib/i18n/store.ts` の `initLocale()`/`setLanguageSetting()` が管理し、`useT()`/`useLocale()`（`useSyncExternalStore`）でReactコンポーネントに配線する。設定画面の言語切替（オプションタブ、`LanguageSection.tsx`）は即座に反映される
- **起動時のロケール解決は必ず成功する**: `initLocale()`は`getSetting`/`getOsLocale`のどちらが失敗（reject）しても内部で吸収し`'auto'`または既存の解決結果へフォールバックして必ずresolveする。呼び出し元（`App.tsx`）はこの`.then()`の中で起動シーケンス本体を走らせているため、ここでrejectすると起動画面のまま永久に止まる
- **バックエンドのユーザー向けエラー**: Rust側は文言でなくエラーコード（`Result<_, String>` のErrに `"directoryNotFound"` や `"invalidPattern:{detail}"` のようなコード文字列）を返す。フロントは `src/lib/i18n/errors.ts` の `resolveScanErrorMessage`/`resolveAddPatternErrorMessage`/`resolveResetAllDataErrorMessage`/`resolveStartupDirectoryError` でロケールに応じた文言へ変換する。ログ専用（`console.error`/`eprintln!`）の文言は英語のままでよく、コード化の対象外
- **確定文言を状態に持たない**: `App.tsx`の`directoryError`、`ScanSection`の`error`、`ExcludeRulesSection`の`addError`、`InfoSection`の`resetMessage`は、変換済みの表示文言でなく生のエラーコード/辞書キーを状態として保持し、レンダーのたびに現在のロケールへ解決する。`setState`時点で文言に固定すると、表示中に言語を切り替えたときに旧言語のまま固まる（新旧混在）
- **日付は言語によらず常に `YYYY-MM-DD`**（ISO、スラッシュ不可）。数値の桁区切りは `toLocaleString()` など言語に応じて変えてよい
- **ウィンドウタイトル・`<html lang>`・ダイアログtitle**もロケールに追従する（`App.tsx`のロケール変更effect、`selectAndScan()`/`selectShareDirectory()`が渡す`t('selectDirectoryDialogTitle')`/`t('selectShareDirectoryDialogTitle')`）

## データベーススキーマ

`src-tauri/src/database.rs` の `CREATE TABLE IF NOT EXISTS` が正本（8テーブル: `file_metadata` / `image_stats` / `playlist_list` / `playlist_position` / `ignore_rules` / `exif_cache` / `scan_history` / `app_settings`。`reset_to_defaults` の `USER_TABLES` と一致する）。ファイルは `<app_data_dir>/sss.db`。

### file_metadata テーブル

```sql
CREATE TABLE file_metadata (
    path TEXT PRIMARY KEY,
    modified_time INTEGER NOT NULL,  -- Unix timestamp（秒）
    file_size INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- インデックス: idx_modified_time(modified_time)
```

- **用途**: 差分スキャン用のファイルキャッシュ（判定に使うのは `modified_time` のみ）

### image_stats テーブル

```sql
CREATE TABLE image_stats (
    path TEXT PRIMARY KEY,
    display_count INTEGER DEFAULT 0,
    last_displayed DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- インデックス: idx_display_count(display_count), idx_last_displayed(last_displayed)
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
  - **#62レビューS1**: `select_and_scan`/`rescan_last_directory` のスキャン完了を待たずに表示を始められる
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
- **既定ルール**（新規DB作成時と `reset_all_data` 後に `INSERT OR IGNORE`）: `**/.thumbnails/` `**/Thumbs.db` `**/.DS_Store` `**/@eaDir/` `**/desktop.ini` `**/.**/`
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
    directory_path TEXT,
    total_files INTEGER,
    new_files INTEGER,
    deleted_files INTEGER,
    scan_duration_ms INTEGER,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- **用途**: スキャン履歴の記録。`get_distinct_scan_directories` が起動時の asset scope 許可と履歴タブのルート解決に使う

### app_settings テーブル

```sql
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- **用途**: 設定のキー/値ストア（キー一覧は「設定画面」節）。`save_setting`/`get_setting` 経由。`reset_all_data` で空になる

## Rustモジュール構成

### src-tauri/src/main.rs

- bin エントリ。`sss_lib::run()` を呼ぶだけの薄い殻（`windows_subsystem` 属性のみ保持）

### src-tauri/src/lib.rs

- ライブラリ本体（`sss_lib`）。`run()` が Tauri アプリを初期化（プラグイン登録・Tauriコマンド登録・スクリーンセーバー抑制・キャッシュ管理・`AppState` 構築）
- 芯モジュール（scanner/playlist/ignore/image_processor/database/commands）を `pub` 公開し、結合テスト `tests/golden_e2e.rs`（フォルダ→scan→ignore→playlist の golden e2e）から直接叩けるようにする lib+bin 分割

### src-tauri/src/asset_scope.rs

- asset protocol scope（`convertFileSrc` の許可範囲）の動的許可に使う純関数群と検証ゲート（`sanitize_allow_dir`・`startup_allow_dirs` ほか）。`tauri.conf.json` の静的 scope は空

### src-tauri/src/pick.rs

- ピックのファイルシステム処理と「管理下パス」検証（`ensure_managed_media_path`・`ensure_registered_media_path`・`resolve_open_target`・`validate_picked_delete_target`・同名連番コピー）。状態を持たない関数群

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

### src-tauri/src/thumbnail.rs

- 設定画面（履歴・ピック済み）用の長辺256pxのJPEGサムネイル生成（#67）。保存先は`<cache_dir>/thumbs/{md5(パス:更新日時:サイズ)}.jpg`（asset scope許可済み。起動・リセット時の`clear_cache_dir`で掃除され、次回は再生成）。EXIF Orientationは常に焼き込み、透過は黒背景に合成。巨大画像のデコードが並列で走らないよう静的Mutexで直列化し、`cache_worker::write_atomic`で原子的に書く。キャッシュキーの更新日時は**秒精度**（同一秒内の同サイズ差し替えは検出しない。実運用では無視できる仕様）。`thumbs/`は本体キャッシュの2GB上限（`cache_dir`直下のみ計上）の外なので、**専用上限`THUMBS_MAX_BYTES`(256MB)**で管理し、50枚生成ごとに`enforce_cache_limit`で古い順に削除する（直前に書いた1枚は残す）。キャッシュヒット時にサムネイルのmtimeを現在へ更新するので、この削除は実質LRU

### src-tauri/src/cache_worker.rs

- 画像最適化キャッシュを作る単一ワーカースレッド（優先度/世代管理付きキュー、アトミック書込、サイズ上限LRU削除、`request_current_and_wait`同期待ち、失敗セット、panic保護）
- 起動時/`reset_all_data`共通のキャッシュクリア（`clear_cache_dir`: 退避rename→再作成、古いtrash掃除）

### src-tauri/src/commands/

- Tauriコマンドハンドラ（29個。`lib.rs` の `invoke_handler` 登録数と下の番号が一致する）
  1. `select_and_scan`: **フォルダ選択ダイアログを Rust 側で開き**（`tauri-plugin-dialog` の Rust API。`commands::dialog::DirectoryPicker` trait 越しで、本番は `TauriDirectoryPicker`、テストは固定値スタブ）、選ばれたフォルダだけをスキャンする（#93）。JS から渡せるのはダイアログのタイトル文字列のみで、パス文字列を受け取る引数は無い。戻り値は `Some(ScanProgress)`／`None`（キャンセル。エラーにしない）。スキャン成功後に asset scope 許可と `last_directory_path` の保存を行う（本体は Tauri 非依存の `perform_select_and_scan`／共通部 `scan_chosen_directory`）。フォルダ不在は `directoryNotFound`、`sanitize_allow_dir` 拒否は `directoryUnsafe`、二重実行は `scanInProgress`（`ScanGuard`）。スキャン（リアルタイム進捗イベント付き）はプレイリストの新規作成/差分更新に加え、メモリ上にプレイリストが無い場合（`restore_playlist` が復元できなかった、またはまだ呼ばれていない）はDB保存済みのプレイリスト状態を読み、対象ディレクトリが一致すれば復元して差分適用する
  2. `restore_playlist`: 起動直後、DB保存済みのプレイリスト状態を**スキャン完了を
     待たずに**復元する（#62レビューS1）。**引数なし**で、対象は DB 保存済みの前回フォルダ（`last_directory_path`）のみ（#93）。フロントはまずこれを呼び、`true`（復元
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
  5. `open_in_explorer`: ファイルマネージャーで開く（OS別対応）。**対象は管理下パスのみ**（#92）: `pick_image`/`get_thumbnail` と同じ`pick::ensure_managed_media_path`（DB登録 or ピック先フォルダ内）を通し、管理外は存在有無に関わらず同一の`pathNotManaged`で拒否（存在確認のオラクルにならない）。管理下だが実在しない場合のみ`imageFileNotFound`。`~`展開は廃止（UIは絶対パスを渡す）。Windowsではcanonicalの`\\?\`接頭辞を除去してからファイラへ渡す（`pick::strip_verbatim_prefix`）。検証部は`pick::resolve_open_target`に切り出し単体テスト済み。**`exclude_image`とは非対称**（こちらはピック先フォルダ内の実在ファイルも開ける）。フロントは`resolveOpenInExplorerErrorMessage`でja/en表示
  6. `get_playlist_info`: プレイリスト情報取得（位置、総数、戻れるか）
  7. `get_last_directory_path`: 最後にスキャンしたフォルダパス取得（読み取り専用。設定画面の表示用）
  8. `exit_app`: アプリケーション終了
  9. `save_setting`: 設定を保存。**書き込めるキーは許可リスト（`WRITABLE_SETTING_KEYS`: `display_interval`/`language`/`apply_exif_rotation`/`video_audio_enabled`/`video_max_duration_sec`）のみ**で、それ以外は`settingKeyNotWritable`（#93。`last_directory_path`・`share_directory_path`・`sssignore_migrated` は WebView から書き換えられない）
  10. `get_setting`: 設定を取得
  11. `pick_image`: 画像をPictures/sss-pickedフォルダにコピー（同名は`name_1.ext`の連番で、`create_new`で名前を予約→`fs::copy`し上書きしない。更新日時は元ファイルに揃える。#67。**元パスは管理下＋メディア拡張子のみ**: DB（`file_metadata`/`image_stats`）に文字列一致で登録済み、またはピック先フォルダ内の実体ファイル（`canonicalize`で`..`・フォルダ外symlinkを拒否）。管理外は`pathNotManaged`、非メディアは`notMediaFile`のエラーコードで拒否。検証は`pick::ensure_managed_media_path`（canonicalパスを返し後続処理はそれを使う。DB登録パスでもsymlinkは拒否）。**基準のピック先も検証**: `get_picked_directory`は`resolve_validated_share_directory`で不正な保存値（相対・`..`・ルート・ホーム/その祖先）を既定へフォールバックし、ピック先の保存は`select_share_directory`（#93。ダイアログ選択→`is_acceptable_share_directory`で検証→保存、拒否は`shareDirectoryInvalid`）だけで、`save_setting`からは書けない。**拒否するのは**ルート（Windowsはホームと同一ドライブのみ。`D:\`・UNC共有ルートは可）・ホーム自身とその祖先・システム領域（`/etc` `/usr` `/System` `/Library` 等、Windowsは`SystemRoot`/`ProgramFiles`）・ホーム配下の`.ssh/.gnupg/.aws/.kube`・Linuxの`/root`・macOSの`~/Library/Keychains`・相対/`..`（`/opt`と`/run`は外付け/自動マウント`/run/media`を壊すため対象外）。**それ以外の任意ディレクトリは保存できる**（管理下扱いは画像・動画拡張子のファイルのみ。allowlistは外付け/NASを壊すため採らない）。比較は実パス化し、macOS/Windowsは大文字小文字無視。設定画面は`get_share_directory`（解決済みパス）を表示。**脅威モデル**: 防ぐのは素朴な任意パス指定（#87）。さらに#93でフォルダ選択をRust側ダイアログに統合したため、WebViewがダイアログを経ずに任意フォルダを管理下にする経路は無い（残余は「セキュリティ設計」節）
  12. `exclude_image`: 画像をDBの除外ルールに追加（日付/ファイル/フォルダ除外）。**対象はDB登録パス（`file_metadata`/`image_stats`）のみ**（#92）: `pick::ensure_registered_media_path`で管理外（登録済みでも symlink に差し替えられたパスを含む）を、存在確認・EXIF撮影日の読み取り・ルール追加より前に`pathNotManaged`で拒否する（任意ファイルの存在有無・撮影日が漏れず、`image_stats`行も作られない）。登録済みで実在しない場合のみ`imageFileNotFound`。フロントは`resolveExcludeErrorMessage`でja/en表示。**`open_in_explorer`とは非対称**（`open_in_explorer`はピック先フォルダ内の実在ファイルも許可、`exclude_image`は除外ルール・`image_stats`行を作るため登録済みパスのみ）。同類の`undo_display_count`は直前に加算したパスとの一致を要求するため問題なし
      即時反映（file/date）は `Playlist::update_images` の直後に必ずフル保存する
      （#62レビューM2(must): 保存し忘れると再起動を跨いだときに除外した画像が復活する）
  13. `undo_exclude`: 直前の除外を取り消す（#78）。**復帰対象（`restore_paths`）はDB登録済み（`is_known_media_path`）かつメディア拡張子のパスのみ**（#92。`starts_with`は`..`を解決しないため`<root>/../x`が通りうるのを塞ぐ。通常フローの`removedPaths`はスキャン登録済み由来なので影響なし。スキャンルートが`None`のままプレイリストが`Some`になる経路は本番に無く〔`perform_scan`/`restore_playlist`は両者を同じロック内で同時に設定、`reset_all_data`は両方を`None`に戻す〕、`None`分岐は主にテスト用）。`exclude_image` の戻り値（`ExcludeOutcome`）をそのまま受け取り、`ruleAdded` が真の時だけルールを削除し（元からあったルールは消さない）、即時にプレイリストから外していた画像（`removedPaths`）を、除外ルール削除後の残りルールで再判定した上で `Playlist::update_images` の既存規則で**未再生区間**へ戻し、フル保存する。バックエンドは取り消し用の状態を持たない（`AppState` 不変）
  14. `get_display_stats`: 統計データ取得（グラフ用の表示回数ヒストグラム。表示回数ごとのファイル数・最小/最大/平均のみ返し、全件の一覧は返さない）
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
      （`--debug`可）の成果物で行う。`select_and_scan`/`rescan_last_directory`と同じ`ScanGuard`で
      スキャンと排他する
  17. `get_ignore_patterns`: 除外ルール一覧を取得
  18. `remove_ignore_pattern`: 除外ルールを削除
  19. `add_ignore_pattern`: 除外ルールを手動追加
  20. `get_recent_images`: 最近表示した画像一覧（最新100件、除外済み除く）
  21. `get_picked_images`: ピック済みメディア一覧（画像＋動画、スキャナと同じ拡張子定義。#67）
  22. `delete_picked_image`: ピック済み画像を削除（ピック先フォルダ内の通常のメディアファイルのみ。検証は`pick::validate_picked_delete_target`）
  23. `reset_all_display_counts`: 全画像の表示回数をリセット
  24. `get_thumbnail`: 設定画面用サムネイル（静止画は縮小済みJPEGのパス、動画は`{kind:'video'}`。#67。静止画は`pick_image`と同じ管理下パス検証`pick::ensure_managed_media_path`を通し、管理外は`pathNotManaged`で拒否。#87）
  25. `get_share_directory`: 実際に使われるピック先（検証済み解決。不正な保存値は既定へフォールバック済み）を返す。設定画面はこれを表示する（#87）
  26. `undo_display_count`: 表示回数の加算を取り消す（直前に加算したパスと一致する場合のみ。画像読み込み失敗時の`onError`用、#65）
  27. `get_os_locale`: OSのロケール（例: `ja-JP`）を返す（言語`auto`の決定用、#82）
  28. `rescan_last_directory`: DB保存済みの前回フォルダ（過去にダイアログで選ばれたパス）を再スキャンする。**引数なし**（#93）。起動時の自動スキャン・設定画面の「スキャン」ボタンが使う。保存が無ければ`noLastDirectory`（`restore_playlist` は前回フォルダ無しを正常系として`Ok(false)`で返す。ユーザーが明示操作するスキャンはエラーで知らせる、という意図的な非対称）。選択/再スキャンの失敗コードは拒否したパスを`directoryNotFound:{path}`/`directoryUnsafe:{path}`で返す。**`last_directory_path`は`to_string_lossy`で保存するため、非UTF-8のパス（主にLinux）は保存時に置換文字へ変わり、2回目以降の自動復元・再スキャンが`directoryNotFound`になる既知の制約**（ダイアログでの選択直後のスキャンは正しいパスで成功する）。検証・排他・進捗イベント・asset scope許可・保存は`select_and_scan`と共通（`scan_chosen_directory`）
  29. `select_share_directory`: ピック先をダイアログ（Rust側）で選んで保存する（#93）。検証は`is_acceptable_share_directory`（拒否は`shareDirectoryInvalid`）、保存後にasset scopeへ許可。戻り値は保存パス／`None`（キャンセル）。本体は`perform_select_share_directory`

## Reactコンポーネント構成

### src/App.tsx

- メインアプリケーションコンポーネント（起動シーケンスは `lib/startup.ts`）
- 再生可否（`isPlaying`）の導出・キーボードショートカット・写真上のクリック/ホイール・ウィンドウモード切替
- マウスアイドル検出（`useMouseIdle`）・右上の常設ボタン列・ようこそ/空/接続不可などの案内画面

### src/components/Slideshow.tsx

- 画像/動画表示コンポーネント
- Framer Motionによるフェードアニメーション
- 動画の音声（`muted={!videoAudioEnabled}`）・最大再生時間（`timeupdate`で判定）・自動再生拒否時のミュートへのフォールバック・退場中の古い動画のミュート/一時停止（#68）

### src/components/OverlayUI.tsx

- グラスモーフィズムUI（下中央の浮遊バー・進捗ライン・「取り消す」トースト）
- ファイル情報表示
- 操作ボタン（前へ・⏸/▶・次へ・ピック・「…」メニュー）

### src/components/ShortcutsOverlay.tsx

- キーボードショートカット一覧モーダル（`?` または右上のボタン）

### src/components/Settings/

- 設定モーダル（`index.tsx` がタブ管理、各タブは `*Section.tsx`。「設定画面」節の表を参照）

### src/hooks/useSlideshow.ts

- スライドショーロジック（現在画像・通知・進捗）
- 表示間隔タイマー管理（`setTimeout` + 残り時間の保持。間隔は設定値5〜60秒、既定10秒。動画はタイマーでなく `Slideshow.tsx` の `ended`/最大再生時間で進む）
- 再生/一時停止制御（`isPlaying` は `App.tsx` が導出して渡す）

### src/hooks/useMouseIdle.ts

- マウスアイドル検出
- 3秒タイムアウト

### src/hooks/useFocusTrap.ts

- モーダル（設定・ショートカット一覧）のフォーカストラップ

### src/lib/

- `tauri.ts`: Tauriコマンドのラッパー関数
- `startup.ts`: 起動シーケンス（設定読込→`restore_playlist`→バックグラウンドの`rescan_last_directory`）。どちらも引数なし（#93）
- `keyboardShortcuts.ts`・`photoGestures.ts`: ショートカット判定・写真上のクリック/ホイール判定（純関数）
- `displayCountChart.ts`: 統計グラフの目盛り・範囲の純関数
- `i18n/`: 辞書（ja/en）・`t()`・ロケール状態・バックエンドエラーコードの解決

### src/lib/tauri.ts

- Tauriコマンドのラッパー関数

### src/types.ts

- TypeScript型定義

## パフォーマンス目標

以下は**目標値**であり、フルアプリでの通し計測はしていない。実測できているのはバックエンド単体のベンチ（`src-tauri/tests/scan_reflection_throughput.rs`・`db_reflection_throughput.rs`・`exif_resolve_throughput.rs`、いずれも `#[ignore]`。値は `docs/architecture.md` §6(b)(c)）のみ。

- **起動時間**: <5秒（10万ファイル、差分スキャン時）
- **画像切り替え**: <100ms
- **メモリ使用量**: <500MB（通常動作時）
- **並列スキャン**: CPUコア数に応じた最適化

## セキュリティ設計

- **capability**（`src-tauri/capabilities/main.json`）: `core:default`・`core:window:allow-set-fullscreen`/`allow-set-decorations`/`allow-set-title`（ウィンドウモード切替とタイトル更新。`core:default` には含まれず、無いと呼び出しが黙って拒否されてボタンが無反応になる #103）・`opener:allow-open-url`（`https://*` のみ）・`process:allow-exit` だけ。ウィンドウ状態の保存復元（`tauri-plugin-window-state`）は Rust 側のみで JS から呼ばないため権限不要。`src/lib/capabilities.test.ts` が src 内のウィンドウ API/プラグイン import と main.json を突き合わせて権限の不足・過剰を検出する（新しいウィンドウ API を使う時は同ファイルの対応表と main.json を更新する）。切替失敗時は画面下に `role="alert"` の通知を出す。ファイル読み書きはすべて自前の Tauri コマンド経由で `plugin-fs` は使わない。フォルダ選択ダイアログは Rust 側で開くため `dialog:*` 権限は付与しない（#93。JS から `plugin:dialog|*` は呼べない）
- **CSP**（`tauri.conf.json`）: `default-src 'self'`。`img-src` は `'self' asset: https://asset.localhost https://tile.openstreetmap.org data:`、`media-src` は `'self' asset: https://asset.localhost`、`connect-src` は `'self' ipc: http://ipc.localhost https://ipc.localhost`
- **asset scope**: `tauri.conf.json` の静的 scope は空。キャッシュ・ピック先・スキャン履歴のフォルダ・スキャン対象を、起動時と `select_and_scan`/`rescan_last_directory`/`restore_playlist`/`select_share_directory`/`pick_image` で `sanitize_allow_dir`（相対パス・存在しないパス・ルート等を拒否）を通してから動的に許可する
- **管理下パス**（#87・#92）: `pick_image`・`get_thumbnail`（静止画）・`open_in_explorer`・`exclude_image`・`undo_exclude` は、DB登録済み（またはピック先フォルダ内）のメディアファイルだけを対象にする。ピック先の設定値もルート・ホーム・システム領域などを拒否する
- **フォルダ選択はダイアログ経由のみ**（#93）: スキャン対象・ピック先は、Rust 側で開いたダイアログ（`select_and_scan`/`select_share_directory`）で選ばれたパスか、過去にそうして DB に保存されたパス（`rescan_last_directory`/`restore_playlist`。引数なし）だけになる。JS から任意のパス文字列を受け取ってスキャン・asset scope 許可・ピック先にする経路は無い（旧 `scan_directory(directoryPath)` は廃止）。`save_setting` は書き込み許可リスト方式で、DB 保存値（`last_directory_path`/`share_directory_path`）の WebView からの書き換えも塞ぐ。ダイアログ抽象（`DirectoryPicker`）はテスト・e2e の IPC モックで差し替える
- **脅威モデル**: 防ぐのは、WebView（乗っ取られた場合を含む）から任意パスを渡して、任意ファイルを読む/コピーする/存在確認する、任意フォルダをスキャン・管理下にする・ピック先にする操作（#87・#92・#93）。**残余リスク**: (1) WebView が IPC で `select_and_scan`/`select_share_directory` を呼ぶこと自体は止められない（ネイティブダイアログが開く＝ユーザーに見える操作で、対象はユーザーがダイアログで選んだフォルダだけ。ダイアログを勝手に確定する手段は WebView に無いが、ユーザーを騙してダイアログで選ばせる社会工学は防げない）。(2) ダイアログで選ばれたフォルダは、スキャン対象ならホームドライブのルート以外（`sanitize_allow_dir`）、ピック先ならルート・ホーム・システム領域等以外（`is_acceptable_share_directory`）であればそのまま許可する（allowlist は外付け/NAS を壊すため採らない）。(3) `get_setting` は任意キーを読める（機密は保存していない）。WebView が `select_and_scan` を連打してもダイアログの二重表示はフラグで弾く（`dialogInProgress`）が、閉じるたびに次のダイアログを出し続けることはでき、ユーザーが閉じれば止まる（ダイアログの連続表示）。ダイアログ表示前にスキャン実行中なら `scanInProgress` で弾く（ガードはダイアログを閉じた時点で解放し、スキャン中の二重実行は `ScanGuard` が弾く）。`reset_all_data` はダイアログ表示中でもブロックされないが、選択後に初期化済みの状態へスキャンが入るだけでデータは壊れないので許容する。(4) OS 権限で動く本体プロセスが侵害された場合は対象外。詳細は「Rustモジュール構成 > commands」の 1・11・12・28・29 と CHANGELOG の #87・#92・#93

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
  - `cross-platform`（windows-latest / macos-latest）: `cargo clippy --all-targets -- -D warnings` / `cargo test`。`#[cfg(windows)]`/`#[cfg(target_os = "macos")]` 配下のコード・実機限定テストは ubuntu だけでは一度もコンパイルされないため（#63 で発覚した Windows 固有バグの反省）。Windows では `tauri::test::mock_app` 系 integration test が `src-tauri/build.rs` のマニフェスト埋め込みワークアラウンドを必要とする（tauri-apps/tauri#13419 未修正の既知バグ。詳細は architecture.md）
  - `npm run e2e` は CI に含めない（実ブラウザ/実ファイル前提のため手動実行）
  - 両ジョブとも `env.CARGO_BUILD_JOBS: 4` でリポルート `.cargo/config.toml` の `jobs=1`（ローカルのメモリ制約回避用）を上書きし、CIランナーでは既定に近い並列度でビルドする（#69レビュー）。ローカル開発時の `jobs=1` はそのまま維持
- **Audit**: `.github/workflows/audit.yml`（ci.yml とは別ファイル）— `rustsec/audit-check` で `src-tauri` の Rust 依存関係を検査。`src-tauri/Cargo.toml`/`Cargo.lock` を変更する push/PR と、毎週月曜03:00 UTC の schedule（新規登録された既知脆弱性の検出用）でのみ実行し、無関係な変更で毎回は回さない
  - **ignore 方針**: 直せない/直す価値のない advisory（例: 上流未対応の unmaintained warning）が出た場合は、`rustsec/audit-check` の `ignore` 入力に advisory ID を追加し、なぜ ignore するか・いつ見直すかを同じ行にコメントで残す。安易な ignore 追加はせず、まず `cargo update` での解消を優先する
- **Release**: `.github/workflows/release.yml` — 手動 dispatch。`validate` ジョブで (1) dispatch 元ブランチが `main` であること (2) `version` 入力が `vX.Y.Z`（プレリリース識別子任意）の形式であること (3) 同名タグが未使用であること (4) 入力 version と `tauri.conf.json`/`Cargo.toml`/`package.json` の version 一致 (5) CHANGELOG.md に対応する `[version]` 節が存在すること (6) `npm test`/`cargo test` の通過、を順にチェックし、いずれか失敗で fail。通過後に3-OS matrix（macOS/Linux/Windows）で `tauri-action` がビルドし、release note は CHANGELOG.md の該当節へのリンク。**成果物は署名なし**（macOS Gatekeeper/Windows SmartScreen の回避手順は README の「未署名アプリの警告について」に記載）。Windows は `--bundles nsis`（`setup.exe`）のみ、macOS は universal（`.dmg`）、Linux は AppImage/deb/rpm を生成する。`tag v*` の push では起動しない（`workflow_dispatch` のみ。タグは `tauri-action` がリリース作成時に作る）
  - **リリース手順**: 1. `tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json` の version を揃えて更新 2. CHANGELOG.md の `[Unreleased]` を `[X.Y.Z] - YYYY-MM-DD` に改名し、新しい空の `[Unreleased]` を上に用意 3. これらを含む PR を作成し main にマージ 4. GitHub Actions の `Release Build` を `workflow_dispatch` で実行し、`version` に `vX.Y.Z` を入力（main ブランチから実行すること） 5. `validate` → `build` の通過を確認し、GitHub Releases に3プラットフォーム分の成果物が揃ったことを確認する
- **Pre-commit**: Husky（`.husky/pre-commit`）で `npx lint-staged`（`eslint --fix` + `prettier` for TS/JS、`prettier` for JSON/CSS/MD）と `cd src-tauri && cargo fmt` を実行
- **CHANGELOG.md**: Keep a Changelog 形式。v1.1.0 以降の変更を記録。**コード変更を伴う PR は自分の変更を `[Unreleased]` セクションに追記する**（#70 以降の運用）

## TODO: 仕様変更・機能追加

実装済みの項目は `[x]`。履歴は CHANGELOG.md と各 Issue を正本とし、ここには「実装との対応」と未実装だけを残す。

### 🔧 バグ修正

- [x] **keepawake設定の修正**: `.sleep(false)`（ノートPC蓋閉じ時のスリープは許可、ディスプレイスリープは抑制）
- [x] **表示回数の2重カウント問題**: 表示回数を加算するのは `get_next_image` が新規に進めた画像でファイルが実在する場合のみ。「前へ」（`get_previous_image`）は加算しない（#62）

### 📍 GPS/位置情報機能

- [x] **EXIF GPS座標の取得**: kamadak-exifでGPS情報（緯度・経度）を抽出
- [x] **地図表示**: GPSがある写真だけ、オーバーレイバー左端に OpenStreetMap タイルの小さなサムネイルを表示し、クリックで Google Maps を開く（CSP の `img-src` で `https://tile.openstreetmap.org` を許可）。Leaflet / Google Maps API は使っていない

### 📤 ピック機能（SNS用候補選別）

- [x] **ファイルコピー機能**: オーバーレイのピックボタン（手のアイコン）でコピー
- [x] **デフォルトコピー先**: `Pictures/sss-picked`フォルダ
- [x] **フォルダ自動作成**: コピー先フォルダが存在しない場合は自動作成
- [x] **視覚的フィードバック**: コピー完了時にステータスメッセージ＋「取り消す」トースト
- [x] **設定画面でカスタマイズ**: オプションタブでコピー先フォルダパスを変更可能
- [x] **ピック一覧**: 設定のピックタブ（サムネイル・削除）。「…」メニューの「ピックを見る」から直接開ける

### 🚫 除外機能（ignore_rulesテーブル連携）

- [x] **オーバーレイUIの「…」メニューに「除外」を追加**
- [x] **除外時に3つの選択肢を表示**:
  1. **撮影日付で除外**: EXIF `DateTimeOriginal`優先で撮影日を抽出し、`rule_type="date"`のルールとして`ignore_rules`に追加。`exif_cache`で既に該当日と分かっている画像は即座にプレイリストから外す
  2. **ファイルを除外**: `globset::escape`したファイルパスを`rule_type="glob"`で`ignore_rules`に追加
  3. **フォルダを除外**: `globset::escape`した親フォルダパス+`/**`（サブフォルダ含め再帰的）を`rule_type="glob"`で`ignore_rules`に追加
- [x] **即座にプレイリストから削除**: ファイル除外は即座、日付除外は`exif_cache`既知分のみ即座。それ以外（ディレクトリ除外・未取得の日付）は次回スキャンで反映
- [x] **視覚的フィードバック**: 除外完了時にステータスメッセージ＋「取り消す」トースト（失敗時はエラーメッセージも表示）
- [x] **除外ルール管理画面**: 設定の「除外ルール」タブで一覧・解除・手動追加

### 🖼️ 画像回転の設定

- [x] **EXIF Orientationの適用をON/OFF切り替え可能に**（`apply_exif_rotation`）
- [x] **設定画面（オプションタブ）に「EXIF回転情報に従って画像を自動回転」チェックボックス**
- [x] **デフォルトはON**
- [x] **OFFの場合**: EXIF Orientationを無視（バックエンドが格納画素のままのキャッシュへ差し替える。「コア機能 2. スライドショー」参照）

### 🎨 オーバーレイUI（Issue #6 → #66 で刷新）

- [x] **デフォルト非表示**: マウス移動でフェードイン、3秒アイドルでフェードアウト（右上ボタン列・カーソルも同時）
- [x] **レイアウト**: 画面下中央に浮かぶ角丸のガラス調バー1本（左=情報・中央=前へ/⏸▶/次へ・右=ピック/「…」）。旧「4列×2行グリッド」は廃止
- [x] **スライドショー制御**: オーバーレイの操作バーに hover 中は一時停止、離れると再開
- [x] **…サブメニュー**: ファイルマネージャーで開く・ピックを見る・除外（3粒度）。設定とウィンドウモード切替は右上のボタン列へ移動済み

### 📊 設定画面と統計機能

- [x] **スキャン結果表示**: スキャン直後に新規/削除/総数/処理時間/読み取りエラーを表示。設定画面を閉じると `ScanSection` がアンマウントされ結果は消える（再度開いても古い情報は出ない）
- [x] **統計グラフ**: 表示回数の分布ヒストグラム（表示済み/平均/最少〜最多のタイル・「均等」バッジ・表ビュー、#67）。当初案の「写真ごとの棒グラフ（パス順の横軸）」は10万枚規模で成立しないため、表示回数ごとのファイル数に集計する方式にした
- [x] **表示回数のリセット**: 統計タブの「表示回数をリセット」ボタン（`reset_all_display_counts`）
- [ ] **「フォルダ変更時に表示回数を自動リセットする」設定**: 未実装（現状はフォルダを切り替えても表示回数は保持される）

### 🎬 動画対応

- [x] 動画ファイル形式の判定（mp4, webm, ogv, m4v）
- [x] 動画プレーヤーコンポーネント（`<video>` タグ、object-fit: contain）
- [x] 動画の自動再生と停止制御（`ended` で次送り）
- [x] 動画の長さに応じた表示時間調整（表示間隔タイマーでなく再生終了イベント。最大再生時間の上限設定、#68）
- [x] 動画の音声ON/OFF設定（#68）
- [ ] 動画メタデータの取得（再生時間、コーデック、解像度など）
- [ ] ffmpeg同梱による旧フォーマット変換再生（#45: avi, mkv, flv, wmv等）

### ⚙️ その他の機能拡張

- [x] 日本語/英語の多言語対応（#80）
- [x] ウィンドウ状態の記憶（#78）
- [x] 起動時の自動差分スキャン（前回フォルダを復元して即表示し、バックグラウンドでスキャン、#62）
- [ ] リモートフォルダ対応（ネットワークドライブ、NAS）。OSにマウント済みのドライブは動作する

### 📱 Tauri 2アップグレードとモバイル対応

- [x] **Tauri 2へのアップグレード**（完了、下記「Tauri 2への移行」参照）
- [ ] **Android対応**: Tauri 2のAndroidサポートを活用（タブレット最適化）
- [ ] **iOS対応**（オプション）: iPad向けの最適化
- [ ] **タッチ操作の実装**: スワイプで前後移動・ダブルタップで一時停止/再生など（現状の写真上のクリック/ホイール操作は #78 でデスクトップ向けに実装済み）
- [ ] **モバイルUI最適化**: 画面サイズに応じたレイアウト、大きなタップエリア、縦横両対応

---

## Tauri 2への移行（2025-11-05 完了）

### 主要な変更点

#### 1. プラグインシステムへの移行

Tauri v1のallowlist機能が、v2では新しいプラグインシステムとパーミッションモデルに置き換わりました：

- `tauri-plugin-dialog`: ファイル選択ダイアログ
- `tauri-plugin-opener`: URLを開く（`tauri-plugin-shell`の`open`はv2で非推奨のため移行、#59）
- `tauri-plugin-single-instance`: 単一インスタンス管理
- `tauri-plugin-process`: アプリ終了（フロントの `exit(0)`）
- `tauri-plugin-window-state`: ウィンドウ状態の保存/復元（#78）

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
- rusqlite v0.31 → v0.32（その後 #69 で 0.40 へ更新）
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

- **元ファイルの削除・移動機能なし**: 誤操作防止のため、アプリから写真・動画の原本を削除/移動する機能は実装しない（削除できるのはピック先フォルダ内のコピーだけ。ピック/除外の「取り消し」も原本には触れない）
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
