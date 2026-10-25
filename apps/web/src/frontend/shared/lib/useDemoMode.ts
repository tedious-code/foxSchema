/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether this install is a demo. Asked once per page load: it changes only
 * when an admin flips it, and the banner it drives can wait for a reload.
 */
import { useEffect, useState } from 'react';
import { apiDemoMode, type DemoModeInfo } from '@/shared/api/authApi';

let pending: Promise<DemoModeInfo> | null = null;

/** The install's demo mode; a failed request reads as "not a demo" and is asked again next time. */
export function loadDemoMode(): Promise<DemoModeInfo> {
  // Through a promise so a throw of any kind lands in the catch: the page
  // must render whether or not the server can say.
  pending ??= Promise.resolve()
    .then(apiDemoMode)
    .catch(() => {
      pending = null;
      return { on: false };
    });
  return pending;
}

/** Forget the cached answer, after an admin changes it or between tests. */
export function resetDemoMode(): void {
  pending = null;
}

/** Null until known. */
export function useDemoMode(): DemoModeInfo | null {
  const [info, setInfo] = useState<DemoModeInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadDemoMode().then((next) => alive && setInfo(next));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
