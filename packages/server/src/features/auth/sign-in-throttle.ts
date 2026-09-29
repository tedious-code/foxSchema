/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Failed sign-ins per account.
 *
 * The per-address limiter on the sign-in route stops one client guessing fast;
 * it does nothing against many clients guessing one account slowly. This
 * counts failures per email instead: after `MAX_FAILURES` inside the window
 * the email is refused until the window passes, whatever the password.
 *
 * It counts emails with no account the same way, so the lockout message tells
 * a guesser nothing about which emails exist. In memory, per process: a
 * restart clears it, which costs an attacker a restart they cannot cause.
 */

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Bound on tracked emails, so a flood of made-up addresses cannot grow memory without limit. */
const MAX_TRACKED = 10_000;

interface Entry {
  failures: number;
  /** When the first counted failure happened; the window runs from here. */
  since: number;
}

const entries = new Map<string, Entry>();

function key(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

function current(email: string, now: number): Entry | undefined {
  const entry = entries.get(key(email));
  if (entry && now - entry.since > LOCKOUT_MS) {
    entries.delete(key(email));
    return undefined;
  }
  return entry;
}

/** Milliseconds until `email` may try again, or 0 when it may now. */
export function lockedFor(email: string, now = Date.now()): number {
  const entry = current(email, now);
  if (!entry || entry.failures < MAX_FAILURES) return 0;
  return Math.max(0, entry.since + LOCKOUT_MS - now);
}

export function recordFailure(email: string, now = Date.now()): void {
  const entry = current(email, now);
  if (entry) {
    entry.failures += 1;
    return;
  }
  if (entries.size >= MAX_TRACKED) {
    // Oldest first: Map keeps insertion order.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key(email), { failures: 1, since: now });
}

/** A correct password, or a reset, clears the count. */
export function clearFailures(email: string): void {
  entries.delete(key(email));
}

/** Between tests. */
export function resetSignInThrottle(): void {
  entries.clear();
}
