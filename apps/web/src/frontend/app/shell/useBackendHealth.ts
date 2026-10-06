import { useEffect, useRef, useState } from 'react';
import { getApiBase } from '@/shared/api/apiBase';

export type BackendHealth = 'checking' | 'online' | 'offline';

/** Slow heartbeat while healthy — this only has to notice, not react instantly. */
const OK_INTERVAL_MS = 15_000;
/** Fast retry once down, so the banner clears promptly after a restart. */
const DOWN_INTERVAL_MS = 3_000;
/**
 * A hung backend is as broken as a dead one, and `fetch` to a listening-but-
 * stuck server never rejects on its own. Without this the poll would sit
 * forever on one request and never mark the app offline.
 */
const PROBE_TIMEOUT_MS = 5_000;
/**
 * One slow probe is not an outage — a laptop waking, a dev server rebuilding,
 * or a single dropped packet all produce one failure. Only call it offline
 * after this many consecutive misses.
 */
const FAILURES_BEFORE_OFFLINE = 2;

async function probe(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/health`, {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Polls `/api/health` and reports whether the backend is reachable.
 *
 * The web UI and the API are separate processes. When the API dies the UI keeps
 * rendering its last state and every action fails with a different, confusing
 * message — so the app has to say plainly that the backend is gone.
 */
export function useBackendHealth(): { status: BackendHealth; checkNow: () => void } {
  const [status, setStatus] = useState<BackendHealth>('checking');
  const failures = useRef(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // No probe from a hidden tab; showing it again probes at once (below).
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(tick, OK_INTERVAL_MS);
        return;
      }
      const ac = new AbortController();
      const killer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
      const ok = await probe(ac.signal);
      clearTimeout(killer);
      if (cancelled) return;

      if (ok) {
        failures.current = 0;
        setStatus('online');
      } else {
        failures.current += 1;
        // Stay on the previous status until the streak is long enough to mean
        // something; a single miss should not flash a scary banner.
        if (failures.current >= FAILURES_BEFORE_OFFLINE) setStatus('offline');
      }
      timer = setTimeout(tick, ok ? OK_INTERVAL_MS : DOWN_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nonce]);

  // Re-probe as soon as the tab is looked at again: a laptop that slept through
  // a backend restart should not wait out the remaining interval.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return { status, checkNow: () => setNonce((n) => n + 1) };
}
