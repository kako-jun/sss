import { Film, ImageOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getThumbnail } from '../../lib/tauri';

type ThumbState =
  | { status: 'idle' }
  | { status: 'image'; src: string }
  | { status: 'video' }
  | { status: 'failed' };

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 設定画面（履歴・ピック済みタブ）の正方形サムネイル（#67）。
 *
 * 原本（5000万画素級）を `<img>` に直接読ませず、バックエンドが縮小・キャッシュした
 * 小さな JPEG を表示する。画面に入ってから初めて要求する（100 件の履歴を開いても
 * 見えている分だけ生成される）。動画は静止画が無いのでアイコンとファイル名で示す。
 */
export function Thumbnail({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // 結果は「どのパスのものか」と一緒に持つ。`path` prop が変わったとき（リスト再利用で
  // キーが変わらない場合など）に、前のパスのサムネイル/動画ラベルを新しいパスの下に
  // 出し続けない（別ファイルの画像を見せる誤表示になる）。
  const [loaded, setLoaded] = useState<{ path: string; state: ThumbState } | null>(null);
  const state: ThumbState = loaded?.path === path ? loaded.state : { status: 'idle' };
  // IntersectionObserver が無い環境（jsdom 等）では最初から読み込む。
  const [visible, setVisible] = useState(() => typeof window.IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getThumbnail(path)
      .then((result) => {
        if (cancelled) return;
        setLoaded({
          path,
          state:
            result.kind === 'image'
              ? { status: 'image', src: convertFileSrc(result.path) }
              : { status: 'video' },
        });
      })
      .catch((err) => {
        console.error('Failed to load thumbnail:', err);
        if (!cancelled) setLoaded({ path, state: { status: 'failed' } });
      });
    return () => {
      cancelled = true;
    };
  }, [path, visible]);

  return (
    <div
      ref={ref}
      className="w-full aspect-square overflow-hidden rounded bg-black/40 flex items-center justify-center"
    >
      {state.status === 'image' && (
        <img src={state.src} alt="" className="w-full h-full object-cover" draggable={false} />
      )}
      {state.status === 'video' && (
        <div className="flex flex-col items-center gap-1 px-2 text-white/50 max-w-full">
          <Film className="w-6 h-6" aria-hidden="true" />
          <span className="text-[10px] leading-tight truncate max-w-full">{baseName(path)}</span>
        </div>
      )}
      {state.status === 'failed' && (
        <ImageOff className="w-5 h-5 text-white/50" aria-hidden="true" />
      )}
    </div>
  );
}
