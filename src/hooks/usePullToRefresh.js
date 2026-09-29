import { useRef, useState } from "react";

export const PULL_THRESHOLD = 64;

// 画面最上部から下に引っ張ると onRefresh を実行する
export default function usePullToRefresh(onRefresh) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);

  const handleStart = (e) => {
    startY.current = refreshing || window.scrollY > 0 ? null : e.touches[0].clientY;
  };

  const handleMove = (e) => {
    if (startY.current == null || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    setPullDistance(dy > 0 && window.scrollY <= 0 ? Math.min(96, dy * 0.5) : 0);
  };

  const handleEnd = async () => {
    if (startY.current == null) return;
    const trigger = pullDistance >= PULL_THRESHOLD;
    startY.current = null;
    if (!trigger) {
      setPullDistance(0);
      return;
    }
    setRefreshing(true);
    setPullDistance(PULL_THRESHOLD);
    try {
      await onRefresh?.();
    } finally {
      setRefreshing(false);
      setPullDistance(0);
    }
  };

  return {
    pullDistance,
    refreshing,
    pullHandlers: { onTouchStart: handleStart, onTouchMove: handleMove, onTouchEnd: handleEnd, onTouchCancel: handleEnd },
  };
}