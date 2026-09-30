// このファイルは e2e/run.js から Playwright の page.addInitScript() で
// ブラウザへ注入される。Tauri IPC (window.__TAURI_INTERNALS__) を薄くモックし、
// vite dev サーバー単体（Tauriランタイム無し）で App.tsx を実ブラウザで動かす。
//
// URL の #hash でシナリオを選ぶ（e2e/run.js が `${BASE_URL}/#<name>` へ遷移する）。
// 各シナリオの意味は run.js のシナリオ定義コメントを参照。
(() => {
  const media = {
    '/p/a.png':
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAAACXBIWXMAAAABAAAAAQBPJcTWAAABLElEQVR4nO3RAQkAIBDAwBfsX1lTiDDuEgy2Zs7QtX8H8JbBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHXQ2XAt20+1S9AAAAAElFTkSuQmCC',
    '/p/b.png':
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAAACXBIWXMAAAABAAAAAQBPJcTWAAABLElEQVR4nO3RAQkAIBDAQAX7R35MIcK4SzDYnkXZ+R3AWwbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRx3AS4PAtzWMJxrAAAAAElFTkSuQmCC',
    '/p/v.webm':
      'data:video/webm;base64,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',
    '/p/broken.png': 'data:image/png;base64,AAAA',
  };

  const sc = (location.hash || '#slides').slice(1);
  const log = (window.__e2eLog = []);

  // #65レビューM2: 1件だけのプレイリストで同じpathが連続で返るケース（'one'）。
  // #65レビューM1: 画像→動画→動画のように退場アニメーションを挟む連続遷移（'i2v_vv'）。
  // #65レビュー2巡目S8: 一時停止中に動画へ移っても再生されない/再開後に再生される
  // ことを検証する（'pausevid'）。壊れた画像でonErrorが実際に発火し、undoが
  // 呼ばれて次へ進むことを検証する（'broken'、'/p/broken.png'はデコード不能な
  // 壊れたPNGバイト列で実ブラウザに本物のonErrorを起こさせる）。
  const seqs = {
    slides: ['/p/a.png', '/p/b.png'],
    // #67: 統計タブ用（背景に写真1枚を出しておく）。
    stats: ['/p/a.png'],
    statsspread: ['/p/a.png'],
    // #67: 一度も表示していないプレイリスト（全件 0 回）の統計タブ。
    statszero: ['/p/a.png'],
    // #67: ピック/履歴タブのサムネイル（静止画+動画の混在）。
    thumbs: ['/p/a.png'],
    i2v_vv: ['/p/a.png', '/p/v.webm', '/p/v2.webm', '/p/a.png'],
    one: ['/p/a.png'],
    toast: ['/p/a.png'],
    unreach: ['/p/a.png'],
    pausevid: ['/p/a.png', '/p/v.webm', '/p/b.png'],
    broken: ['/p/broken.png', '/p/b.png', '/p/a.png'],
    // #65レビュー2巡目S8: 動画のみを連続させ、退場中の古い動画要素が
    // play()で再生し直されないことを画像の待ち時間なしに検証する。
    vv: ['/p/v.webm', '/p/v2.webm'],
    // #65レビュー3巡目M4: 画像→動画の遷移で、新しい要素が必ず
    // opacity<1から始まり約0.5秒でopacity=1になる（フェードインが
    // 消えていない）ことを検証する。
    fade: ['/p/a.png', '/p/v.webm', '/p/b.png'],
    // #68: 動画設定（音声ON/OFF・最大再生時間）。
    // 'vidset' = 設定UIの保存→再読み込みで復元（動画のみ。2秒の動画が回り続ける）。
    // 'vidcap' = 上限30秒+音声ON。動画→画像→画像（上限到達で次へ進むことを見る）。
    // 'vidend' = 上限60秒+音声OFF。動画(2秒)は上限に届かず onEnded で1回だけ進む。
    // 'vidblock' = 音声ON + 音声付き play() が自動再生ポリシーで拒否される状況を模す。
    vidset: ['/p/v.webm', '/p/v2.webm'],
    vidcap: ['/p/v.webm', '/p/a.png', '/p/b.png'],
    vidend: ['/p/v.webm', '/p/a.png', '/p/b.png'],
    vidblock: ['/p/v.webm', '/p/a.png', '/p/b.png'],
  };

  // #68: シナリオごとの保存済み設定の初期値。'vidset' だけは save_setting の結果を
  // sessionStorage に残し、ページ再読み込み（=アプリ再起動）後に復元されることを見る。
  const presets = {
    vidcap: { video_max_duration_sec: '30', video_audio_enabled: 'true' },
    vidend: { video_max_duration_sec: '60', video_audio_enabled: 'false' },
    vidblock: { video_audio_enabled: 'true' },
  };
  const persisted = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('__e2eSettings') || '{}');
    } catch {
      return {};
    }
  })();
  if (sc === 'vidblock') {
    // 実ブラウザは e2e 起動フラグで自動再生が常に許可される。音声付き(muted=false)の
    // play() だけを NotAllowedError で拒否し、WebViewの自動再生ポリシーを再現する。
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.muted) {
        return Promise.reject(new DOMException('blocked by autoplay policy', 'NotAllowedError'));
      }
      return originalPlay.call(this);
    };
  }
  media['/p/v2.webm'] = media['/p/v.webm'];

  let idx = -1;
  let cb = 0;
  const info = (p) => ({
    path: p,
    isVideo: p.endsWith('.webm'),
    optimizedPath: null,
    width: 160,
    height: 120,
    fileSize: 1,
    exif: null,
    displayCount: 1,
    lastDisplayed: null,
  });

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    transformCallback: (f) => {
      const id = ++cb;
      window['_' + id] = f;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (p) => media[p] || 'data:,',
    invoke: async (cmd, args) => {
      log.push([Date.now(), cmd, JSON.stringify(args || {}).slice(0, 160)]);
      switch (cmd) {
        case 'get_setting':
          // 表示間隔は許容最小値(5秒、constants.tsのMIN_DISPLAY_INTERVAL)を使い、
          // ローカル専用e2eの実行時間を現実的に保つ。
          if (args && args.key === 'display_interval') return '5000';
          if (args && args.key in persisted) return persisted[args.key];
          return (presets[sc] && presets[sc][args && args.key]) ?? null;
        case 'save_setting':
          // #68: 'vidset' のみ再読み込みをまたいで保持する（他は記録だけ）。
          if (sc === 'vidset' && args) {
            persisted[args.key] = args.value;
            sessionStorage.setItem('__e2eSettings', JSON.stringify(persisted));
          }
          return null;
        case 'get_last_directory_path':
          return sc === 'welcome' ? null : '/p';
        case 'restore_playlist':
          // 'unreach' は復元失敗→前景scanDirectory待ちの経路を通したいのでfalse。
          return sc !== 'unreach';
        case 'scan_directory':
          if (sc === 'unreach') {
            await new Promise((r) => setTimeout(r, 100));
            // #80: 実際のバックエンドはユーザー向け文言でなくエラーコードで返す
            // （`commands::scan::scan_directory`）。フロントは
            // `resolveScanErrorMessage` でロケールに応じた文言へ変換する。
            throw 'directoryNotFound';
          }
          if (sc === 'toast') {
            // restore成功後、少し遅れて背景スキャンが失敗する（#65レビューS3/S4想定経路）。
            // #80: 既知コードに含まれない任意の文字列（想定外の内部エラー）でも
            // フォールバックでそのまま表示できることを確認する意図で、あえて
            // 未知の文字列のままにする。
            await new Promise((r) => setTimeout(r, 500));
            throw 'NAS connection lost';
          }
          return { totalFiles: (seqs[sc] || seqs.slides).length };
        case 'get_next_image': {
          if (sc === 'empty') return { kind: 'emptyPlaylist' };
          if (sc === 'root') {
            // #65レビューS4/S9: rootUnavailableが自動再試行で回復するまでの経路。
            // 1回目=見つかる(a)、2〜3回目=rootUnavailable、4回目以降=見つかる(b)。
            // 一時停止中はuseSlideshow側が再試行effectを止めているはずなので、
            // このカウンタは「実際にget_next_imageが呼ばれた回数」だけが進む。
            window.__rc = (window.__rc || 0) + 1;
            if (window.__rc >= 2 && window.__rc <= 3) return { kind: 'rootUnavailable' };
            const p = window.__rc === 1 ? '/p/a.png' : '/p/b.png';
            window.__e2eCurrentPath = p;
            return { kind: 'found', data: info(p) };
          }
          const s = seqs[sc] || seqs.slides;
          idx = (idx + 1) % s.length;
          // e2e/run.js が「今どの論理パスが表示されているか」を、DOMのsrc
          // （同じ動画バイト列を使い回しているpath同士は同一srcになり見分けが
          // つかない）に頼らず直接読めるようにする（テスト専用フック）。
          window.__e2eCurrentPath = s[idx];
          return { kind: 'found', data: info(s[idx]) };
        }
        case 'get_previous_image':
          return { kind: 'noHistory' };
        case 'get_playlist_info':
          return [idx + 1, (seqs[sc] || seqs.slides).length, idx > 0];
        case 'undo_display_count':
          return null;
        case 'plugin:event|listen':
          return ++cb;
        case 'plugin:window|is_fullscreen':
          return true;
        // #66: 設定モーダルの各タブ（除外ルール/ピック/履歴/統計グラフ/共有先）を
        // e2e/screenshots.jsで開くと、これらのコマンドが未定義のままdefault(null)を
        // 返し、配列/オブジェクトを期待するコンポーネント側がnullで例外を投げて
        // Reactツリーごとクラッシュしていた（エラーバウンダリが無いため白画面化）。
        // 各タブが単独で開けることを確認するため、空の既定値を返す。
        case 'get_ignore_patterns':
          return [];
        case 'get_picked_images':
          // #67: 'thumbs' = 静止画と動画が混在するピック一覧。
          return sc === 'thumbs' ? ['/p/a.png', '/p/v.webm'] : [];
        case 'get_recent_images':
          return sc === 'thumbs'
            ? [
                { path: '/p/a.png', displayCount: 3, lastDisplayed: '2026-01-01T00:00:00Z' },
                { path: '/p/v.webm', displayCount: 1, lastDisplayed: '2026-01-02T00:00:00Z' },
              ]
            : [];
        case 'get_thumbnail':
          // #67: 設定画面のサムネイルはバックエンドが縮小した JPEG のパスを返す。
          // 'thumbs' では静止画は（縮小済みの代役として）160x120 のモック画像、動画は
          // { kind: 'video' }。それ以外のシナリオは従来どおり全件 video 扱い。
          if (sc === 'thumbs' && args && !String(args.imagePath).endsWith('.webm')) {
            return { kind: 'image', path: args.imagePath };
          }
          return { kind: 'video' };
        case 'get_display_stats':
          // #67: 集計済みのヒストグラム（全件一覧ではない）。
          // 'stats' = 完全平等ランダムが働いた状態（差1以内）、'statsspread' = 偏りのある状態。
          if (sc === 'stats') {
            return {
              files: 12000,
              min: 2,
              max: 3,
              mean: 2.7,
              bins: [
                { count: 2, files: 3600 },
                { count: 3, files: 8400 },
              ],
            };
          }
          if (sc === 'statsspread') {
            return {
              files: 12000,
              min: 0,
              max: 9,
              mean: 3.4,
              bins: [
                { count: 0, files: 900 },
                { count: 1, files: 1800 },
                { count: 2, files: 2700 },
                { count: 3, files: 3100 },
                { count: 4, files: 2000 },
                { count: 5, files: 1100 },
                { count: 6, files: 300 },
                { count: 9, files: 100 },
              ],
            };
          }
          if (sc === 'statszero') {
            // 全件が 0 回（一度も表示していない）。ビンは 0 回の 1 本だけ。
            return { files: 500, min: 0, max: 0, mean: 0, bins: [{ count: 0, files: 500 }] };
          }
          return { files: 0, min: 0, max: 0, mean: 0, bins: [] };
        case 'get_default_share_directory':
          return '/tmp/sss-picked';
        // #66: 情報タブの表示バージョン（getVersion()、@tauri-apps/api/appが
        // 内部で呼ぶコマンド）。未定義のままだとバージョン表示が空欄のままになる。
        case 'plugin:app|version':
          return '0.0.0-e2e';
        default:
          return null;
      }
    },
  };
})();
