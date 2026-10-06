import type { PersistStorage, StorageValue } from 'zustand/middleware';

/**
 * localStorage for a zustand `persist` store whose state changes on every
 * keystroke.
 *
 * `persist` serialises and writes the whole snapshot on each change, on the
 * typing path: the SQL editor's is about 90 kB, and 1 MB for heavy users.
 * This keeps the latest snapshot in memory and writes it `waitMs` after the
 * last change, and at once when the page is hidden or closed, so nothing typed
 * is lost to a closed tab. Reads see the pending snapshot first.
 *
 * Code that reads the saved copy straight from localStorage in the same page
 * (the e2e page objects do) dispatches `pagehide` first to flush it.
 */
const pending = new Map<string, unknown>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Write every pending snapshot now. */
export function flushDeferredStorage(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  for (const [name, value] of pending) {
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch {
      // Full or blocked storage: persist's own storage gives up the same way.
    }
  }
  pending.clear();
}

let listening = false;

function flushWhenLeaving(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pagehide', flushDeferredStorage);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDeferredStorage();
  });
}

export function deferredLocalStorage<S>(waitMs = 400): PersistStorage<S> {
  flushWhenLeaving();
  return {
    getItem: (name) => {
      if (pending.has(name)) return pending.get(name) as StorageValue<S>;
      try {
        const raw = localStorage.getItem(name);
        return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending.set(name, value);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flushDeferredStorage, waitMs);
    },
    removeItem: (name) => {
      pending.delete(name);
      try {
        localStorage.removeItem(name);
      } catch {
        // Nothing to remove from storage that cannot be read.
      }
    },
  };
}
