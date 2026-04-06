import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * マウスが一定時間動かなかったら idle = true になるフック。
 * isHovering が true の間は idle にならない。
 */
export function useMouseIdle(timeoutMs: number = 3000) {
  const [isIdle, setIsIdle] = useState(true); // 初期状態は非表示
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveringRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setIsIdle(true);
    }, timeoutMs);
  }, [clearTimer, timeoutMs]);

  const resetIdle = useCallback(() => {
    setIsIdle(false);
    if (!isHoveringRef.current) {
      startTimer();
    }
  }, [startTimer]);

  const setIsHovering = useCallback(
    (hovering: boolean) => {
      isHoveringRef.current = hovering;
      if (hovering) {
        // ホバー中はタイマーを止めて表示を維持
        clearTimer();
        setIsIdle(false);
      } else {
        // ホバー解除時にタイマー再開
        startTimer();
      }
    },
    [clearTimer, startTimer],
  );

  // マウス移動でリセット
  useEffect(() => {
    const handleMouseMove = () => {
      resetIdle();
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [resetIdle]);

  // クリーンアップ
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { isIdle, setIsHovering, resetIdle };
}
