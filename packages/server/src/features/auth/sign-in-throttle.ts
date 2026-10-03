/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Failed sign-ins per account.
 *
 * The per-address limiter on the sign-in route stops one client guessing fast;
 * it does nothing against many clients guessing one account slowly. This
 * counts failures per email, in two ways:
 *
 *   from one address  after `MAX_FAILURES` the email is refused to THAT
 *                     address until the window passes, whatever the password;
 *   from everywhere   after `MAX_EMAIL_FAILURES` the email is refused to all.
 *
 * Counted per email alone, five wrong passwords from anyone locked the account
 * for everyone, so one client could keep an admin out indefinitely. Now a
 * guesser locks only themselves, and it takes many addresses to lock the
 * account itself.
 *
 * It counts emails with no account the same way, so the lockout message tells
 * a guesser nothing about which emails exist. In memory, per process: a
 * restart clears it, which costs an attacker a restart they cannot cause.
 */

/** Failures one address may make on one email inside the window. */
export const MAX_FAILURES = 5;
/** Failures from every address together before the email is refused to all. */
export const MAX_EMAIL_FAILURES = 50;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Bound on tracked emails, so a flood of made-up addresses cannot grow memory without limit. */
const MAX_TRACKED = 10_000;
/** Bound on addresses tracked per email, for the same reason. */
const MAX_ADDRESSES = 1_000;

interface Entry {
  failures: number;
  /** When the first counted failure happened; the window runs from here. */
  since: number;
}

interface Account {
  total: Entry;
  byAddress: Map<string, Entry>;
}

const accounts = new Map<string, Account>();

function key(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

const expired = (entry: Entry | undefined, now: number) => !entry || now - entry.since > LOCKOUT_MS;

/** How long `entry` keeps refusing, given the failures it may hold. */
function waitOf(entry: Entry | undefined, max: number, now: number): number {
  if (!entry || expired(entry, now) || entry.failures < max) return 0;
  return Math.max(0, entry.since + LOCKOUT_MS - now);
}

/** Add a failure to `map[k]`, starting a new window when the last one ran out. */
function bump<K>(map: Map<K, Entry>, k: K, now: number, bound: number): void {
  const entry = map.get(k);
  if (entry && !expired(entry, now)) {
    entry.failures += 1;
    return;
  }
  map.delete(k);
  if (map.size >= bound) {
    // Oldest first: Map keeps insertion order.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(k, { failures: 1, since: now });
}

/** Milliseconds until `email` may try again from `address`, or 0 when it may now. */
export function lockedFor(email: string, address = '', now = Date.now()): number {
  const account = accounts.get(key(email));
  if (!account) return 0;
  return Math.max(
    waitOf(account.byAddress.get(address), MAX_FAILURES, now),
    waitOf(account.total, MAX_EMAIL_FAILURES, now)
  );
}

export function recordFailure(email: string, address = '', now = Date.now()): void {
  const k = key(email);
  let account = accounts.get(k);
  if (!account) {
    if (accounts.size >= MAX_TRACKED) {
      const oldest = accounts.keys().next().value;
      if (oldest !== undefined) accounts.delete(oldest);
    }
    account = { total: { failures: 0, since: now }, byAddress: new Map() };
    accounts.set(k, account);
  }
  if (expired(account.total, now)) account.total = { failures: 0, since: now };
  account.total.failures += 1;
  bump(account.byAddress, address, now, MAX_ADDRESSES);
}

/** A correct password, or a reset, clears the count from every address. */
export function clearFailures(email: string): void {
  accounts.delete(key(email));
}

/** Between tests. */
export function resetSignInThrottle(): void {
  accounts.clear();
}
