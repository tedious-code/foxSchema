import { useEffect, useRef } from 'react';

/**
 * Call `onEscape` when Escape is pressed, while `enabled`. A key another
 * handler already claimed (`preventDefault`, for example an open menu inside
 * the dialog) is left alone, and so is everything while `enabled` is false:
 * a dialog with another layer open on top passes false, so Escape closes only
 * the top one.
 *
 * Registered once per enabled state; callers may pass a fresh function on
 * every render.
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onEscapeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
