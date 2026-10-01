import { useState, useEffect, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import type { OverlayUIHandle } from './components/OverlayUI';
import { Settings } from './components/Settings';
import type { TabType } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { useMouseIdle } from './hooks/useMouseIdle';
import {
  getPlaylistInfo,
  getLastDirectoryPath,
  restorePlaylist,
  rescanLastDirectory,
  getSetting,
  getOsLocale,
  undoDisplayCount,
} from './lib/tauri';
import { runStartupSequence } from './lib/startup';
import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';
import { X, Settings as SettingsIcon, Minimize2, Maximize2, Keyboard } from 'lucide-react';
import logoBg from './assets/logo-bg.webp';
import { useT, useLocale, initLocale, resolveStartupDirectoryError } from './lib/i18n';
import {
  clampDisplayInterval,
  DEFAULT_DISPLAY_INTERVAL,
  DEFAULT_VIDEO_AUDIO_ENABLED,
  DEFAULT_VIDEO_MAX_DURATION_SEC,
  idleFadeClassName,
  normalizeVideoMaxDuration,
} from './constants';
import {
  isTypingTarget,
  isFocusVisible,
  hasModifierKey,
  createButtonFocusGuard,
} from './lib/keyboardShortcuts';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { createClickDebouncer, createWheelNavigator } from './lib/photoGestures';

function App() {
  const t = useT();
  const locale = useLocale();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<TabType>('scan');
  const [settingsKey, setSettingsKey] = useState(0);
  // #66レビュー3巡目should: useFocusTrapへ「マウスクリックで開かれたか」を
  // 伝えるための状態（詳細はuseFocusTrap.tsのJSDoc参照）。
  const [settingsOpenedViaMouse, setSettingsOpenedViaMouse] = useState(false);
  const [shortcutsOpenedViaMouse, setShortcutsOpenedViaMouse] = useState(false);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  // #82レビュー2巡目 nit: initLocale完了前は、モジュール読込時点の暫定推定
  // （navigator.language等）でロケールが確定していることがあり、直後に
  // OSロケール優先の結果へ切り替わって表示言語が一瞬反転して見えることがある。
  // ローディング文言はinitLocale完了（localeReady=true）まで出さないことで防ぐ。
  const [localeReady, setLocaleReady] = useState(false);
  const [displayInterval, setDisplayInterval] = useState<number>(DEFAULT_DISPLAY_INTERVAL);
  // #68: 動画の音声ON/OFFと最大再生時間（秒。0=無制限）。永続化は設定画面が担い、
  // ここは起動時の復元値と設定画面からの変更通知を受けてSlideshowへ渡すだけ。
  const [videoAudioEnabled, setVideoAudioEnabled] = useState<boolean>(DEFAULT_VIDEO_AUDIO_ENABLED);
  const [videoMaxDurationSec, setVideoMaxDurationSec] = useState<number>(
    DEFAULT_VIDEO_MAX_DURATION_SEC,
  );
  const [initStatus, setInitStatus] = useState<string>(''); // 初期化状態メッセージ
  const [realtimeProgress, setRealtimeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [isOverlayHovered, setIsOverlayHovered] = useState(false); // オーバーレイにマウスオーバー中か
  const [isPausedByUser, setIsPausedByUser] = useState(false); // ユーザーが明示的に一時停止したか
  const [isFullscreen, setIsFullscreen] = useState(true); // フルスクリーン状態（起動時の設定値に合わせた初期値）
  // #66 問題4: ショートカット一覧（`?`キー、または右上のヘルプボタン）の開閉状態。
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  // #65: ディレクトリが一度でも設定されたことがあるか。「本当に未設定」（ようこそ画面）と
  // 「設定済みだが今アクセスできない/スキャン失敗/空」を区別するために使う。
  const [hasDirectory, setHasDirectory] = useState(false);
  // #65: 起動時自動スキャンで前回ディレクトリが拒否された場合の理由（本文コメント由来）。
  // #82レビューshould1: 表示文言に確定させた文字列でなく、raw（バックエンドの
  // エラーコード or 任意の文字列）とディレクトリパスを保持する。表示のたびに
  // `resolveStartupDirectoryError`で現在のロケールへ解決することで、エラー表示中に
  // 言語を切り替えても新旧の言語が混在しない（前の言語のまま固まらない）。
  const [directoryError, setDirectoryError] = useState<{ raw: string; directory: string } | null>(
    null,
  );
  // #103: ウィンドウモード切替の失敗通知（権限不足等で setFullscreen が拒否されても無反応にしない）
  const [windowModeError, setWindowModeError] = useState<{ text: string; seq: number } | null>(
    null,
  );
  const initRef = useRef(false); // 初期化が1回だけ実行されるようにする
  const overlayRef = useRef<OverlayUIHandle>(null);
  const { isIdle, setIsHovering, resetIdle } = useMouseIdle(3000);
  // #78: 写真上のクリック（一時停止/再開）とホイール（前/次）の判定器。状態を持つので
  // 再レンダーをまたいで同じインスタンスを使い続ける。
  const acceptPhotoClick = useRef(createClickDebouncer()).current;
  const navigateByWheel = useRef(createWheelNavigator()).current;
  // #66レビュー3巡目nit: 右上ピル内の各ボタンへ個別に付ける
  // onMouseDownガード（詳細はOverlayUI.tsxの同種のrefと同じ理由）。
  const pillContainerRef = useRef<HTMLDivElement>(null);
  const guardPillButtonMouseDown = useMemo(() => createButtonFocusGuard(pillContainerRef), []);

  // #65 問題4: isPlaying はこのフックの内部状態ではなく、ここで導出した派生値にする。
  // 設定画面を開いている/オーバーレイにホバー中/ユーザーが明示的に一時停止した、の
  // いずれかであれば止まる。initialize()やスキャン完了処理が何を呼ぼうと、この式が
  // 変わらない限り再生は始まらない（「設定画面で再スキャンすると裏で進む」の根絶）。
  const isPlaying = isInitialized && !isPausedByUser && !isOverlayHovered && !isSettingsOpen;

  const {
    currentImage,
    displayToken,
    isLoading,
    notice,
    progressPercent,
    progressDurationMs,
    loadNextImage,
    loadPreviousImage,
    continueInLastDirection,
    initialize,
    handleMediaReady,
  } = useSlideshow(displayInterval, isPlaying);

  // プレイリスト情報を更新
  const updatePlaylistInfo = async () => {
    try {
      const info = await getPlaylistInfo();
      if (info) {
        const [position, total, canGoBackValue] = info;
        setCurrentPosition(position);
        setTotalImages(total);
        setCanGoBack(canGoBackValue);
      }
    } catch (err) {
      console.error('Failed to get playlist info:', err);
    }
  };

  // #80: ロケール変更（起動時の初期化含む）に追従してhtml lang属性とウィンドウ
  // タイトルを更新する。切替の即時反映（ウィンドウタイトル・lang属性込み）を保証する。
  useEffect(() => {
    document.documentElement.lang = locale;
    getCurrentWindow()
      .setTitle(t('windowTitle'))
      .catch((err) => console.error('Failed to set window title:', err));
  }, [locale, t]);

  // フルスクリーン状態をOSの実態と同期
  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();
    // 初期値を実態から取得
    win
      .isFullscreen()
      .then((v) => {
        if (!cancelled) setIsFullscreen(v);
      })
      .catch(() => {});
    // OSによるフルスクリーン変化を検知して同期
    // （Tauri v2 にフルスクリーン専用イベントがないため onResized で近似）
    let cleanup: (() => void) | null = null;
    const listenerPromise = win
      .onResized(() => {
        win
          .isFullscreen()
          .then((v) => {
            if (!cancelled) setIsFullscreen(v);
          })
          .catch(() => {});
      })
      .then((fn) => {
        cleanup = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // 非同期登録が完了してからクリーンアップ（Strict Mode での漏れを防ぐ）
      listenerPromise.finally(() => cleanup?.());
    };
  }, []);

  // 初期化（React Strict Modeで2回実行されるのを防ぐ）
  useEffect(() => {
    if (initRef.current) {
      return; // 既に初期化済み
    }

    // 最初に画面描画を完了させるため、初期化処理を次のイベントループで実行
    const timeoutId = setTimeout(() => {
      initRef.current = true; // 初期化開始をマーク

      // #80: 起動シーケンスより先に言語設定を確定させる（以降の initStatus 表示・
      // 案内画面が最初から正しい言語になるようにするため）。
      // #82レビューmust: `initLocale` 自体が内部で例外を吸収し必ずresolveする
      // （getSetting/getOsLocaleの失敗はどちらも'auto'または既存の解決結果への
      // フォールバックで飲み込まれる）ため、ここに`.catch()`は不要。以前は無く、
      // getSettingがrejectすると起動シーケンスが一生呼ばれず起動画面のまま
      // 止まっていた（テスト担当が発見）。
      void initLocale(getSetting, getOsLocale).then(() => {
        // #82レビュー2巡目 nit: ここでロケールが確定した後にローディング文言を
        // 表示し始める（それまでは何も出さず、暫定推定からの反転を見せない）。
        setLocaleReady(true);
        // #62レビューS1: 起動時の初期化シーケンス（前回状態の復元→可能なら即表示、
        // スキャンはバックグラウンド）は React から切り離した純粋関数に委譲する
        // （src/lib/startup.ts。単体テストしやすくするため）。
        runStartupSequence({
          getSetting,
          getLastDirectoryPath,
          restorePlaylist,
          rescanLastDirectory,
          initialize,
          listenScanProgress: (cb) =>
            listen<{ current: number; total: number }>('scan-progress', (event) =>
              cb(event.payload),
            ),
          setInitStatus,
          setRealtimeProgress,
          setIsInitialized,
          setDisplayInterval: (ms) => setDisplayInterval(clampDisplayInterval(ms)),
          setVideoAudioEnabled,
          setVideoMaxDurationSec: (sec) => setVideoMaxDurationSec(normalizeVideoMaxDuration(sec)),
          updatePlaylistInfo,
          setHasDirectory,
          onDirectoryError: (err, directory) => {
            // #82レビューshould1: ここでは文言に確定させず、raw文字列のまま
            // 保持する（表示側で毎レンダー`resolveStartupDirectoryError`にかける）。
            const raw = err instanceof Error ? err.message : String(err);
            setDirectoryError({ raw, directory });
          },
        });
      });
    }, 0);

    // クリーンアップ関数
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画像が変わったらプレイリスト情報を更新。復帰できたので古いディレクトリエラーは消す。
  useEffect(() => {
    if (currentImage) {
      updatePlaylistInfo();
      setDirectoryError(null);
    }
  }, [currentImage]);

  const handlePrevious = async () => {
    await loadPreviousImage();
  };

  const handleNext = async () => {
    await loadNextImage();
  };

  // #65 問題5: 除外成功で即座に次へ進み、プレイリスト情報（位置/総数）も
  // 最新化する（除外済みの画像を表示し続けない）。
  // #65レビューnit: updatePlaylistInfoはここで明示的に呼ばない。loadNextImage が
  // currentImage を更新すれば、下の「画像が変わったら」effectが自動的に呼ぶため
  // （ここでも呼ぶと同じ呼び出しが重複していた）。除外の結果emptyPlaylistになった
  // 場合はcurrentImageがnullのままなのでeffect側は呼ばないが、表示するものが無い
  // 以上position/totalの更新は不要。
  const handleExcluded = async () => {
    await loadNextImage();
  };

  // #65 問題8: `<img>`/`<video>` のonErrorはバックエンドが既に加算した表示回数を
  // 取り消してから即座に次へ進む（「どちらにしたか」は取り消しAPI方式。理由は
  // `undo_display_count` のdocコメント参照）。
  // #65レビュー質問決定: 「前へ」で戻っている途中にonErrorになった場合は
  // loadPreviousImageでさらに戻る、前進中（既定含む）は次へ進む
  // （continueInLastDirectionが直近の方向を引き継ぐ）。
  // #65レビュー2巡目nit: undoDisplayCountの完了を待ってからcontinueInLastDirection
  // を呼ぶ（順序確定）。並行に発火すると、continueInLastDirectionが先に次の
  // get_next_imageを完了させてバックエンドのAppState.last_incremented_displayを
  // 次のpathへ進めてしまい、その後に届くundo_display_count(古いpath)が
  // パス不一致で無視されてしまう競合を避けるため。
  const handleMediaError = (path: string) => {
    void (async () => {
      try {
        await undoDisplayCount(path);
      } catch (err) {
        console.error('Failed to undo display count:', err);
      }
      await continueInLastDirection();
    })();
  };

  // #78: 除外の取り消し後。画像がプレイリストへ戻ったので位置/総数を更新する。
  // 除外で表示するものが無くなっていた（currentImageがnull）場合は表示を再開する。
  const handleExcludeUndone = async () => {
    if (!currentImage) {
      await loadNextImage();
    } else {
      await updatePlaylistInfo();
    }
  };

  // #78: 写真上のマウス操作。写真領域（Slideshow）にだけ付けるため、オーバーレイ・
  // 右上ピル・モーダル（写真の兄弟要素）の操作とは干渉しない。
  const handlePhotoClick = (e: React.MouseEvent) => {
    if (isSettingsOpen || isShortcutsOpen) return;
    if (!acceptPhotoClick(e.timeStamp)) return;
    // 操作の結果（⏸/▶）が見えるよう、オーバーレイを起こす。
    resetIdle();
    setIsPausedByUser((prev) => !prev);
  };

  const handlePhotoWheel = (e: React.WheelEvent) => {
    if (isSettingsOpen || isShortcutsOpen) return;
    // ピンチズーム（ctrl+wheel）等は対象外。
    if (e.ctrlKey || e.metaKey) return;
    const direction = navigateByWheel(e.deltaX, e.deltaY, e.deltaMode, e.timeStamp);
    if (direction === 'next') {
      void handleNext();
    } else if (direction === 'previous' && canGoBack) {
      void handlePrevious();
    }
  };

  const handleToggleWindowMode = async () => {
    try {
      const win = getCurrentWindow();
      const next = !isFullscreen;
      await win.setFullscreen(next);
      // ウィンドウモード時はタイトルバーを表示してウィンドウを掴めるようにする
      // フルスクリーン時は decorations を非表示に戻す
      await win.setDecorations(!next);
      setIsFullscreen(next);
      setWindowModeError(null);
    } catch (err) {
      console.error('Failed to toggle window mode:', err);
      setWindowModeError((prev) => ({
        text: t('windowModeToggleFailed'),
        seq: (prev?.seq ?? 0) + 1,
      }));
      // 片方だけ成功した場合に表示とOSの実態がずれないよう、実態から再同期する
      try {
        const win = getCurrentWindow();
        const actual = await win.isFullscreen();
        setIsFullscreen(actual);
        // setFullscreen だけ成功した部分失敗に備え、装飾も実態に合わせる（失敗は握りつぶす）
        await win.setDecorations(!actual).catch((decErr) => {
          console.error('Failed to re-sync window decorations:', decErr);
        });
      } catch (syncErr) {
        // 実態も取れなければ現状維持
        console.error('Failed to re-sync window mode:', syncErr);
      }
    }
  };

  // #103: 失敗通知は数秒で自動的に消す
  useEffect(() => {
    if (!windowModeError) return;
    const timer = setTimeout(() => setWindowModeError(null), 5000);
    return () => clearTimeout(timer);
  }, [windowModeError]);

  // #66レビューmust1: キーボードハンドラが参照する値
  // （handlePrevious/handleNext/handleToggleWindowMode と、canGoBack/isSettingsOpen/
  // isShortcutsOpen）を「最新のref」として保持する。以前はこれらの一部だけを
  // effectのdeps配列に入れていたため、depsに無い値（handleToggleWindowMode、
  // ひいてはその中で読むisFullscreen）が初回レンダー時点の値に固定されたまま
  // 更新されず、Fキーが1回しか正しく切り替わらない不具合があった（実ブラウザで
  // 再現確認済み）。ここで全てをrefにまとめ、キーボードリスナー自体は1回だけ
  // 登録する（deps=[]）ことで、この種のstale closure問題を構造的に無くす。
  const keydownHandlersRef = useRef({
    canGoBack,
    isSettingsOpen,
    isShortcutsOpen,
    handlePrevious,
    handleNext,
    handleToggleWindowMode,
  });
  // #66レビュー2巡目must2: 以前はこの代入を`useEffect(() => {...})`（deps無し、
  // 毎レンダー後に走るpassive effect）で行っていたが、passive effectはReactの
  // コミット後に非同期に（他の作業を挟んで）flushされるため、ある種のテスト
  // 環境や高負荷なタイミングでは、実際のレンダー結果とrefの内容が一瞬ズレる
  // 余地があった（CI限定のflakyの一因）。レンダー本体で直接代入すれば、
  // このrefは常に「今まさにコミットされようとしているレンダー」の値と完全に
  // 同期する（読み取り専用の同期用refであり、代入そのものが画面表示に影響
  // しないため、レンダー中の副作用としても安全）。
  keydownHandlersRef.current = {
    canGoBack,
    isSettingsOpen,
    isShortcutsOpen,
    handlePrevious,
    handleNext,
    handleToggleWindowMode,
  };

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // #65: キーリピート(押しっぱなし)による多重発火を無視する（問題3関連）。
      if (e.repeat) return;
      // #66レビューmust2: meta/ctrl/altのいずれかを伴う場合は無視する
      // （Cmd+F/Ctrl+F等、OS/ブラウザ標準のショートカットとの衝突を避ける。
      // 実ブラウザで「Cmd+FがOSのフルスクリーンAPIも呼んでしまう」ことを確認）。
      if (hasModifierKey(e)) return;

      const h = keydownHandlersRef.current;

      // ESCキー（#66 問題1）: 設定を開いている間は「閉じる」、それ以外は終了。
      // 自由テキストを打ち込める入力欄にフォーカスがある間はモーダルを閉じたり
      // アプリを終了したりせず、代わりにフォーカスを外す（#66レビューshould:
      // 編集を取り消す一般的なESCの挙動に寄せる。checkbox/range/number等の
      // 非テキスト系inputはこの対象外＝通常通りモーダルを閉じる）。
      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (h.isSettingsOpen) {
          setIsSettingsOpen(false);
          return;
        }
        if (h.isShortcutsOpen) {
          setIsShortcutsOpen(false);
          return;
        }
        // #66レビューshould: オーバーレイの「…」メニュー（除外サブメニュー含む）が
        // 開いている間のESCは、それを閉じるだけにする。
        if (overlayRef.current?.isMenuOpen()) {
          overlayRef.current.closeMenu();
          return;
        }
        try {
          await invoke('exit_app');
        } catch (err) {
          console.error('Failed to exit app:', err);
        }
        return;
      }

      // 以降のショートカットは、設定モーダルを開いている間は入力欄との衝突を
      // 避けるため無効化する（矢印キーの既存挙動と同じ方針）。
      if (h.isSettingsOpen) return;

      // 左矢印キーで前の画像へ
      if (e.key === 'ArrowLeft' && h.canGoBack) {
        e.preventDefault();
        await h.handlePrevious();
        return;
      }

      // 右矢印キーで次の画像へ
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        h.handleNext();
        return;
      }

      // #66 問題4: `?` でショートカット一覧の表示を切り替える。
      if (e.key === '?') {
        e.preventDefault();
        // #66レビュー3巡目should: キーボードで開いた場合として扱う
        // （useFocusTrapが閉じるボタンへ正しくフォーカスリングを出す）。
        setShortcutsOpenedViaMouse(false);
        setIsShortcutsOpen((prev) => !prev);
        return;
      }

      if (h.isShortcutsOpen) return;

      // #66 問題4: Space で一時停止/再開をトグルする。
      // #66レビューmust2(b)→2巡目must1: 以前は`e.target === document.body`のみを
      // 見ていたが、実ブラウザ(Chromium/WebView2)では「前へ/次へ」等のボタンを
      // マウスでクリックした後もそのボタンにフォーカスが残り続け、target が
      // bodyではなくなる。その状態でSpaceを押すと、このガードに阻まれてアプリの
      // 一時停止が発火しないばかりか、フォーカスが残ったボタン自身がネイティブな
      // クリック相当の挙動（＝そのボタンを再度押す）を引き起こしていた。
      // 一度は`:focus-visible`をフォーカス獲得の瞬間にスナップショットする方式
      // （focusVisibleAtFocusTimeRef）で対処したが、根本原因である「マウス
      // クリックでボタンにフォーカスが残ること」自体を、操作バー・右上ピルの
      // コンテナに`onMouseDown={e => e.preventDefault()}`を付けて無くしたため
      // （2巡目must1案a）、マウスクリック後は`document.activeElement`が
      // 元々フォーカスされていた要素（通常はbody）のまま変わらなくなり、
      // このスナップショット機構は不要になった。単純に、今
      // `document.activeElement`が実際にキーボードで`:focus-visible`な状態か
      // をその場で判定するだけでよい（Tabで意図的にボタンへフォーカスして
      // いる場合は、そのボタンへネイティブなSpace起動を譲る）。
      if (e.key === ' ' && !isTypingTarget(e.target)) {
        const activeElement = document.activeElement;
        const isKeyboardFocused =
          !!activeElement && activeElement !== document.body && isFocusVisible(activeElement);
        if (!isKeyboardFocused) {
          e.preventDefault();
          setIsPausedByUser((prev) => !prev);
        }
        return;
      }

      // #66 問題4: F / F11 でフルスクリーンとウィンドウモードを切り替える。
      if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
        e.preventDefault();
        await h.handleToggleWindowMode();
        return;
      }
    };

    // captureフェーズで最優先でキャッチ。#66レビューmust1: ハンドラ内部は
    // 全てkeydownHandlersRef経由で最新値を読むため、このeffect自体はマウント時に
    // 1度だけ登録すればよい（isFullscreen等の変化のたびに張り直す必要が無い）。
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  // #66レビュー3巡目should: 設定モーダルを開いた操作がマウスクリックだったか
  // どうかをuseFocusTrapへ伝える（詳細はuseFocusTrap.tsのJSDoc参照）。
  const openSettings = (tab: TabType = 'scan', viaMouse = false) => {
    setSettingsInitialTab(tab);
    setSettingsKey((k) => k + 1);
    setIsSettingsOpen(true);
    setSettingsOpenedViaMouse(viaMouse);
  };

  // `event.detail`は実際のマウスクリックでは1以上（連続クリック数）、
  // キーボードでのEnter/Space起動によるclickイベントでは0になる
  // （ブラウザ標準の挙動、#66レビュー3巡目should）。
  const handleSettings = (e: React.MouseEvent) => openSettings('scan', e.detail > 0);
  const handleOpenPickTab = (viaMouse: boolean) => openSettings('pick', viaMouse);

  const handleOverlayMouseEnter = () => {
    setIsOverlayHovered(true);
    setIsHovering(true);
  };

  const handleOverlayMouseLeave = () => {
    setIsOverlayHovered(false);
    setIsHovering(false);
  };

  const handleTogglePause = () => {
    // タッチデバイス対応：タップで一時停止/再生をトグル
    setIsPausedByUser(!isPausedByUser);
  };

  const handleScanComplete = async () => {
    // 手動スキャンなのでディレクトリは確定済み。
    setHasDirectory(true);
    setDirectoryError(null);
    await initialize();
    setIsInitialized(true);
    // 設定画面は閉じない（ユーザーが結果を確認できるように）
    await updatePlaylistInfo();
  };

  const handleIntervalChange = (newInterval: number) => {
    setDisplayInterval(clampDisplayInterval(newInterval));
  };

  const handleVideoMaxDurationChange = (sec: number) => {
    setVideoMaxDurationSec(normalizeVideoMaxDuration(sec));
  };

  // #65: 「ようこそ」画面は本当に未設定（ディレクトリが一度も設定されていない）の
  // 時だけ出す。設定済みだが空/接続不可/読込失敗の場合は専用の案内にする
  // （問題1: 消えたファイル1枚でようこそ画面に落ちる、の根絶）。
  const emptyStateContent = (() => {
    if (!hasDirectory) {
      return { title: t('welcomeTitle'), subtitle: t('welcomeSubtitle') };
    }
    if (notice?.kind === 'emptyPlaylist') {
      return { title: t('emptyPlaylistTitle'), subtitle: t('emptyPlaylistSubtitle') };
    }
    if (notice?.kind === 'rootUnavailable') {
      return { title: t('rootUnavailable'), subtitle: '' };
    }
    if (notice?.kind === 'loadFailedGaveUp') {
      return { title: t('loadFailedGaveUp'), subtitle: '' };
    }
    if (notice?.kind === 'error') {
      return { title: t('genericErrorTitle'), subtitle: notice.message };
    }
    // #65レビュー修正: restorePlaylist失敗→前景rescanLastDirectory自体が失敗した場合、
    // initialize()（＝useSlideshowの最初のgetNextImage）が一度も呼ばれないため
    // notice はずっと null のまま。旧実装はこの分岐が無く emptyStateContent が
    // null になり、案内画面自体が描画されず directoryError も表示されなかった
    // （テスト担当が発見）。hasDirectory は既に true（前回ディレクトリはあった）
    // なので「ようこそ」ではなく専用の案内にする。
    if (directoryError) {
      return {
        title: t('directoryUnreachableTitle'),
        subtitle: t('directoryUnreachableSubtitle'),
      };
    }
    return null; // 読込中（初回表示待ち）。ローディング画面はisInitializedの分岐が別途担当。
  })();

  // #82レビューshould1: `directoryError`はraw文字列のまま保持しているため、
  // 表示文言への変換はレンダーのたびにここで行う（setState時点で固定しない）。
  // こうすることで、エラー表示中に設定画面から言語を切り替えても、次の
  // レンダーで新しい言語の文言に更新される（新旧言語が混在したまま固まらない）。
  const directoryErrorMessage = directoryError
    ? resolveStartupDirectoryError(directoryError.raw, directoryError.directory)
    : null;

  // #65レビュー修正: 復元成功後のバックグラウンドスキャン失敗は、既に最初の画像を
  // 表示できている（currentImage != null）ため上の全画面案内は出さない。写真を
  // 邪魔しない控えめな通知（下部トースト、数秒で自動的に消える）で理由を出す。
  // notice（rootUnavailable/loadFailedGaveUp/error）優先度を最優先にし、無ければ
  // directoryError を出す（同時に出て重なるのを防ぐ）。
  // #65レビューS3: 鑑賞中に invoke の reject（error通知）が起きた場合も同じ
  // トーストで見せる（useSlideshow側が表示間隔ごとに自動再試行する）。
  const bottomNotice: string | null =
    notice?.kind === 'rootUnavailable'
      ? t('rootUnavailable')
      : notice?.kind === 'loadFailedGaveUp'
        ? t('loadFailedGaveUp')
        : notice?.kind === 'error'
          ? notice.message
          : directoryErrorMessage;

  // directoryError による下部トーストだけは数秒で自動的に消す（notice由来の通知は
  // 次の正常な画像取得時にnoticeがnullへ戻るため対象外。上の全画面案内側は
  // currentImageが無い間は自動で消さず、ユーザーが設定を開いて解決するまで残す）。
  useEffect(() => {
    if (!directoryError || !currentImage) return;
    const timer = window.setTimeout(() => setDirectoryError(null), 6000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryError]);

  // 初期化前（起動シーケンス自体が終わっていない）
  if (!isInitialized && !isSettingsOpen) {
    return (
      <div className="w-screen h-screen bg-black overflow-hidden relative">
        {/* 背景ロゴ */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <img src={logoBg} alt="SSS Logo" className="w-1/3 h-auto opacity-2" />
        </div>

        {/* 終了ボタン（右上）。#66視覚刷新: 通常表示中の右上ピルと統一 */}
        <div className="fixed top-4 right-4 z-50">
          <div className="flex items-center bg-black/50 backdrop-blur-md rounded-full border border-white/10 p-1 shadow-2xl">
            <button
              onClick={() => exit(0)}
              className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
              title={t('exitTooltip')}
              aria-label={t('exitTooltip')}
            >
              <X size={16} />
              <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
                {t('exitTooltip')}
              </span>
            </button>
          </div>
        </div>

        <div className="w-screen h-screen flex items-center justify-center relative z-10">
          <div className="text-white/50 text-center">
            {/* #82レビュー2巡目 nit: localeReady（initLocale完了）までは文言を出さない。
                非表示中もレイアウト高さを保つため空のnon-breaking spaceを置く。 */}
            <div className="text-lg mb-4">
              {localeReady ? initStatus || t('loadingPlaylist') : ' '}
            </div>

            {/* リアルタイム進捗表示 */}
            {realtimeProgress && (
              <div className="text-2xl font-mono text-white/40 mb-4">
                {realtimeProgress.current.toLocaleString()} /{' '}
                {realtimeProgress.total.toLocaleString()}
              </div>
            )}

            <div className="text-white/25 text-xs">{localeReady ? t('pleaseWait') : ' '}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      // #66 問題3: idle（3秒間マウス非操作）中はカーソルも隠す。写真が主役の
      // 鑑賞アプリなので、操作UIだけでなくカーソル自体も消して邪魔しない。
      // 設定モーダル・ショートカット一覧を開いている間はUIを操作中なので対象外
      // にする（#66レビューshould: ショートカット一覧を読んでいる間にカーソルが
      // 消えるのは不自然）。
      className={`w-screen h-screen bg-black overflow-hidden${
        isIdle && !isSettingsOpen && !isShortcutsOpen ? ' cursor-none' : ''
      }`}
    >
      {/* スライドショー。#78: 写真上のクリック=一時停止/再開、ホイール/横スワイプ=前/次。
          `display: contents` のラッパーはレイアウトに影響せず、写真領域だけでイベントを拾う。 */}
      <div className="contents" onClick={handlePhotoClick} onWheel={handlePhotoWheel}>
        <Slideshow
          image={currentImage}
          displayToken={displayToken}
          isPlaying={isPlaying}
          videoAudioEnabled={videoAudioEnabled}
          videoMaxDurationSec={videoMaxDurationSec}
          onMediaReady={handleMediaReady}
          onAdvance={loadNextImage}
          onMediaError={handleMediaError}
        />
      </div>

      {windowModeError && (
        <div
          role="alert"
          // 下部のトースト・操作バー・その他メニューと重ならないよう、画面上部中央に出す（右上のボタン列を避けて幅を制限）
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-black/80 backdrop-blur-sm text-white/70 text-xs px-4 py-2 rounded-full border border-white/10 whitespace-nowrap truncate max-w-[calc(100vw-12rem)]"
        >
          {windowModeError.text}
        </div>
      )}

      {/* 右上の常設ボタン（終了・ショートカット・ウィンドウモード・設定）。
          #66視覚刷新: 枠線付き四角ボタン4つの並びから、枠線なしアイコンを1つの
          ガラス調ピル（DESIGN.md「Icon Pill Group」）にまとめた。idle時は
          オーバーレイ同様にフェードアウトする（実際にキーボードでフォーカスして
          いる間は例外的に可視のまま。キーボードでTab移動して見えなくなるのを
          防ぐ）。#66レビューshould: マウスでホバーしている間もidleタイマーを
          止める（オーバーレイと同じ挙動。再生の自動一時停止は伴わない）。
          #66レビュー2巡目must1（案a）: OverlayUIの操作バーと同じ理由で、
          マウスクリックがこのピル内のボタンへフォーカスを残さないように
          `onMouseDown`でpreventDefaultする（Tabでのキーボード操作には影響
          しない）。#66レビュー3巡目nit: OverlayUIと同じ理由で、この
          preventDefaultはコンテナではなく各ボタンへ個別に付ける
          （`guardPillButtonMouseDown`）。 */}
      <div
        ref={pillContainerRef}
        className={`fixed top-4 right-4 z-50 ${idleFadeClassName(isIdle)}`}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <div className="flex items-center gap-0.5 bg-black/50 backdrop-blur-md rounded-full border border-white/10 p-1 shadow-2xl">
          <button
            onClick={(e) => {
              // #66レビュー3巡目should: マウスクリック(detail>0)かキーボードの
              // Enter/Space起動(detail===0)かをuseFocusTrapへ伝える。
              setShortcutsOpenedViaMouse(e.detail > 0);
              setIsShortcutsOpen(true);
            }}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={t('shortcutsButtonTooltip')}
            aria-label={t('shortcutsButtonTooltip')}
          >
            <Keyboard size={16} />
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {t('shortcutsButtonTooltip')}
            </span>
          </button>

          <button
            onClick={handleToggleWindowMode}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={isFullscreen ? t('switchToWindowMode') : t('switchToFullscreen')}
            aria-label={isFullscreen ? t('switchToWindowMode') : t('switchToFullscreen')}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {isFullscreen ? t('windowModeLabel') : t('fullscreenLabel')}
            </span>
          </button>

          <button
            onClick={handleSettings}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={t('settingsTitle')}
            aria-label={t('settingsTitle')}
          >
            <SettingsIcon size={16} />
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {t('settingsTitle')}
            </span>
          </button>

          <button
            onClick={() => exit(0)}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={t('exitTooltip')}
            aria-label={t('exitTooltip')}
          >
            <X size={16} />
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {t('exitTooltip')}
            </span>
          </button>
        </div>
      </div>

      {/* 画像がない場合の案内画面（ようこそ/空/接続不可/読込失敗）。#65問題1・5・9
          #66視覚刷新: 角丸のガラスカードに統一し、ようこそ画面だけロゴマーク・
          プライマリボタン・ショートカットヒントを添える。 */}
      {!currentImage && !isLoading && !isSettingsOpen && emptyStateContent && (
        <div className="fixed inset-0 flex items-center justify-center z-40 px-6">
          {/* #66レビューshould: max-w-smは日本語の説明文（特に長い方の文言）が
              不自然な位置で折り返っていた。max-w-mdに広げ、`text-balance`
              （Tailwind `text-wrap: balance`）で行の折返し位置を均等にする。 */}
          <div className="text-center max-w-md w-full bg-black/30 backdrop-blur-md border border-white/10 rounded-2xl px-8 py-10">
            {!hasDirectory && (
              <img src={logoBg} alt="" aria-hidden="true" className="w-14 h-14 mx-auto mb-5" />
            )}
            <div className="text-white/85 text-xl font-medium mb-2">{emptyStateContent.title}</div>
            {emptyStateContent.subtitle && (
              <div className="text-white/50 text-sm mb-6 text-balance">
                {emptyStateContent.subtitle}
              </div>
            )}
            {directoryErrorMessage && (
              <div
                className="text-red-400/80 font-mono text-xs mb-6 truncate max-w-full mx-auto"
                title={directoryErrorMessage}
              >
                {directoryErrorMessage}
              </div>
            )}
            <button
              onClick={handleSettings}
              className="flex items-center justify-center gap-2 px-6 py-2.5 bg-white/90 hover:bg-white text-black font-medium rounded-lg transition-colors mx-auto text-sm"
            >
              <SettingsIcon size={16} />
              {hasDirectory ? t('openSettings') : t('selectFolder')}
            </button>
            {!hasDirectory && (
              <button
                type="button"
                onClick={(e) => {
                  // 右上のショートカットボタンと同じ経路（#100）。クリック(detail>0)か
                  // キーボードのEnter/Space起動(detail===0)かをuseFocusTrapへ伝える。
                  setShortcutsOpenedViaMouse(e.detail > 0);
                  setIsShortcutsOpen(true);
                }}
                aria-keyshortcuts="?"
                className="group mx-auto -mb-1 mt-5 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs text-white/50 transition-colors hover:text-white/80 focus-visible:text-white/80"
              >
                <span
                  className="rounded border border-white/10 bg-white/8 px-1.5 py-0.5 font-mono transition-colors group-hover:bg-white/15 group-focus-visible:bg-white/15"
                  aria-hidden="true"
                >
                  ?
                </span>
                <span>{t('shortcutsHintWelcome')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 控えめな通知（鑑賞中の画像は維持したまま）: フォルダ接続不可・連続読込失敗・
          復元後のバックグラウンドスキャン失敗（#65レビュー修正） */}
      {currentImage && bottomNotice && (
        <div
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 bg-black/80 backdrop-blur-sm text-white/70 text-xs px-4 py-2 rounded-full border border-white/10 max-w-[90vw] truncate"
          title={bottomNotice}
        >
          {bottomNotice}
        </div>
      )}

      {/* オーバーレイUI（プログレスラインは常時表示、バー/ステータスはidleで
          フェード。#66レビューshould: idle中に一時停止していても手がかりを
          残すため、フェードの制御はOverlayUI内部に持たせisIdleを直接渡す）。 */}
      <OverlayUI
        ref={overlayRef}
        image={currentImage}
        canGoBack={canGoBack}
        currentPosition={currentPosition}
        totalImages={totalImages}
        progress={progressPercent}
        progressDurationMs={progressDurationMs}
        isPausedByUser={isPausedByUser}
        isIdle={isIdle}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onOpenPickTab={handleOpenPickTab}
        onMouseEnter={handleOverlayMouseEnter}
        onMouseLeave={handleOverlayMouseLeave}
        onTogglePause={handleTogglePause}
        onExcluded={handleExcluded}
        onExcludeUndone={handleExcludeUndone}
      />

      {/* ショートカット一覧（#66 問題4） */}
      <ShortcutsOverlay
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
        openedViaMouse={shortcutsOpenedViaMouse}
      />

      {/* 設定画面 */}
      <Settings
        key={settingsKey}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onScanComplete={handleScanComplete}
        onIntervalChange={handleIntervalChange}
        onVideoAudioChange={setVideoAudioEnabled}
        onVideoMaxDurationChange={handleVideoMaxDurationChange}
        initialTab={settingsInitialTab}
        openedViaMouse={settingsOpenedViaMouse}
      />
    </div>
  );
}

export default App;
