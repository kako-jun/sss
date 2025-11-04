import { useState, useEffect, useCallback } from 'react';

/**
 * マウスが一定時間動かなかったかを検出するフック
 * @param idleTimeout アイドル判定時間（ミリ秒）
 * @returns isIdle マウスがアイドル状態か、forceIdle 強制的にアイドル状態にする関数
 */
export function useMouseIdle(idleTimeout: number = 3000) {
  const [isIdle, setIsIdle] = useState(true);

  const resetIdle = useCallback(() => {
    setIsIdle(false);
  }, []);

  const forceIdle = useCallback(() => {
    setIsIdle(true);
  }, []);

  useEffect(() => {
    let timeoutId: number | undefined;

    const handleMouseMove = () => {
      setIsIdle(false);

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      timeoutId = window.setTimeout(() => {
        setIsIdle(true);
      }, idleTimeout);
    };

    const handleMouseClick = () => {
      setIsIdle(false);

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      timeoutId = window.setTimeout(() => {
        setIsIdle(true);
      }, idleTimeout);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('click', handleMouseClick);

    // 初期タイムアウトを設定
    timeoutId = window.setTimeout(() => {
      setIsIdle(true);
    }, idleTimeout);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('click', handleMouseClick);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [idleTimeout]);

  return { isIdle, resetIdle, forceIdle };
}
