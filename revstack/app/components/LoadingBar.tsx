import { useEffect, useRef, useState } from "react";
import loadingBarStyles from "~/styles/loadingBar.module.css";

const SHOW_DELAY_MS = 120;
const COMPLETE_DURATION_MS = 450;

type LoadingBarProps = {
  isLoading: boolean;
};

/**
 * Loading bar that:
 * - Does not show for navigations < 120ms (avoids flicker)
 * - Eases in when showing
 * - Animates to completion before fading out (no snap disappear)
 */
export function LoadingBar({ isLoading }: LoadingBarProps) {
  const [visible, setVisible] = useState(false);
  const [completing, setCompleting] = useState(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLoading) {
      showTimerRef.current = setTimeout(() => {
        setVisible(true);
        setCompleting(false);
        showTimerRef.current = null;
      }, SHOW_DELAY_MS);
      return () => {
        if (showTimerRef.current) {
          clearTimeout(showTimerRef.current);
          showTimerRef.current = null;
        }
      };
    }

    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
      setVisible(false);
      return;
    }

    if (visible) {
      setCompleting(true);
      completeTimerRef.current = setTimeout(() => {
        setVisible(false);
        setCompleting(false);
        completeTimerRef.current = null;
      }, COMPLETE_DURATION_MS);
      return () => {
        if (completeTimerRef.current) {
          clearTimeout(completeTimerRef.current);
          completeTimerRef.current = null;
        }
      };
    }
  }, [isLoading, visible]);

  if (!visible && !completing) return null;

  return (
    <div
      className={`${loadingBarStyles.loadingBar} ${completing ? loadingBarStyles.completing : ""}`}
      role="progressbar"
      aria-hidden="true"
    >
      <div className={loadingBarStyles.progress} />
    </div>
  );
}
