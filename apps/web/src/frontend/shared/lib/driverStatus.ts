/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether each dialect's driver is installed, shared by every screen that asks.
 *
 * The credential form, the schema browser and each failed run in the SQL
 * editor show the same Install button. Each used to keep its own answer, so an
 * install from one left the others saying "not installed" — and offering a
 * second npm run into the same node_modules. One store answers them all: an
 * install shows as running everywhere, a second click joins it, and a finished
 * one refreshes every dialect on that package.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { checkDriver, installDriver, invalidateCache } from '@/shared/api/schemaApi';
import type { DriverInfo } from '@/shared/lib/types';

export interface DriverStatus {
  /** What the server said; null until it answers, or when the check failed. */
  info: DriverInfo | null;
  /** The check itself failed (unknown dialect, network), so `info` is not an answer. */
  checkFailed: boolean;
  installing: boolean;
  /** Why the last install did not leave a loading driver; '' when it did. */
  installError: string;
}

const EMPTY: DriverStatus = { info: null, checkFailed: false, installing: false, installError: '' };

let state: Record<string, DriverStatus> = {};
const listeners = new Set<() => void>();
/** In-flight installs by package: MySQL and MariaDB both install mysql2. */
const installs = new Map<string, Promise<boolean>>();

const keyOf = (dialect: string) => dialect.trim().toLowerCase();

function patch(dialect: string, next: Partial<DriverStatus>): void {
  const key = keyOf(dialect);
  state = { ...state, [key]: { ...(state[key] ?? EMPTY), ...next } };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function driverStatusOf(dialect: string): DriverStatus {
  return state[keyOf(dialect)] ?? EMPTY;
}

/** Ask the server. The API layer caches the answer for 30 s unless `force`. */
export async function checkDriverStatus(dialect: string, { force = false } = {}): Promise<void> {
  if (!dialect.trim()) return;
  if (force) invalidateCache(`driver:${dialect}`);
  try {
    const info = await checkDriver(dialect);
    patch(dialect, { info, checkFailed: false });
  } catch {
    patch(dialect, { info: null, checkFailed: true });
  }
}

/**
 * Install the dialect's driver. A call while one is running for the same
 * package — from another banner, or a second click — shares it. Resolves true
 * when the driver loads afterwards; otherwise `installError` says why.
 */
export function installDriverFor(dialect: string): Promise<boolean> {
  const own = keyOf(dialect);
  const pkg = driverStatusOf(dialect).info?.packageName ?? own;
  const running = installs.get(pkg);
  if (running) return running;
  const onPackage = () =>
    Object.keys(state).filter((key) => key === own || state[key]?.info?.packageName === pkg);
  const job = (async () => {
    patch(dialect, { installing: true, installError: '' });
    for (const key of onPackage()) patch(key, { installing: true });
    try {
      await installDriver(dialect);
      // Every dialect on this package changed, not only the one asked about.
      invalidateCache('driver:');
      await Promise.all(onPackage().map((key) => checkDriverStatus(key)));
      const info = driverStatusOf(dialect).info;
      if (info?.installed) return true;
      const packageName = info?.packageName ?? pkg;
      patch(dialect, {
        installError: info?.error
          ? `Driver still not loading: ${info.error}`
          : `Install finished but "${packageName}" still failed to load. Try: ${info?.installCommand ?? `npm install ${packageName}`}`,
      });
      return false;
    } catch (error: unknown) {
      patch(dialect, { installError: error instanceof Error ? error.message : 'Driver install failed' });
      return false;
    } finally {
      for (const key of onPackage()) patch(key, { installing: false });
      installs.delete(pkg);
    }
  })();
  installs.set(pkg, job);
  return job;
}

/**
 * The package a server error names as missing, or null.
 *
 * Matches the server's own message (`Database driver "redis" is not installed
 * for …`, from DriverDetector and the driver loader) — not any text containing
 * "is not installed", which is also SQL Server's Msg 7609 about Full-Text
 * Search and Postgres's wording for a missing extension.
 */
export function missingDriverPackage(message: string | undefined): string | null {
  const found = message ? /Database driver "([^"]+)" is not installed/.exec(message) : null;
  return found ? found[1]! : null;
}

/** The dialect's driver status, re-checked whenever a screen asks for it. */
export function useDriverStatus(dialect: string): DriverStatus {
  const status = useSyncExternalStore(subscribe, () => driverStatusOf(dialect));
  useEffect(() => {
    if (dialect.trim() && !driverStatusOf(dialect).installing) void checkDriverStatus(dialect);
  }, [dialect]);
  return status;
}

/** Forget every answer. Tests only: each one starts from nothing checked. */
export function clearDriverStatus(): void {
  state = {};
  installs.clear();
  listeners.forEach((listener) => listener());
}
