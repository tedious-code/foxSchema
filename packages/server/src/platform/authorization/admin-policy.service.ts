/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How many admins this install allows: one, or several.
 *
 * With `one`, no path may make a second active admin while one exists —
 * adding an account as admin, promoting one, or reactivating an old admin.
 * Handing the role over is `RbacModule.transferAdmin`, which swaps both
 * accounts in one statement. First-run setup and the CLI's owner account
 * only ever create the first admin, so they are not gated.
 *
 * `FOX_ADMIN_POLICY=one|several` on the server wins over the stored value,
 * like the sign-in settings. With neither, an install behaves as it did
 * before this setting existed (several) until `backfillAdminPolicy` records
 * the default at startup.
 */
import type { MetadataStore } from '../../database/stores/types';
import type { SettingSource } from '../identity/sign-in-settings.service';

export type AdminPolicyValue = 'one' | 'several';

export const ADMIN_POLICY_KEY = 'auth.admin_policy';

/** A change the admin policy refuses — routes answer it with 409 Conflict. */
export class AdminPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminPolicyError';
  }
}

export function isAdminPolicyValue(value: unknown): value is AdminPolicyValue {
  return value === 'one' || value === 'several';
}

const ACTIVE_ADMIN = `app_role = 'admin' AND (active IS NULL OR active != 0)`;

function envPolicy(): AdminPolicyValue | null {
  const raw = (process.env.FOX_ADMIN_POLICY ?? '').trim().toLowerCase();
  return isAdminPolicyValue(raw) ? raw : null;
}

async function storedPolicy(store: MetadataStore): Promise<AdminPolicyValue | null> {
  const row = await store.get<{ value: string | null }>('SELECT "value" FROM app_settings WHERE "key" = ?', [
    ADMIN_POLICY_KEY,
  ]);
  return isAdminPolicyValue(row?.value) ? row.value : null;
}

export async function readAdminPolicy(
  store: MetadataStore
): Promise<{ value: AdminPolicyValue; source: SettingSource | null }> {
  const fromEnv = envPolicy();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const stored = await storedPolicy(store);
  return stored ? { value: stored, source: 'app' } : { value: 'several', source: null };
}

/** Emails of the active admins, oldest first; `exceptUserId` left out. */
export async function activeAdminEmails(store: MetadataStore, exceptUserId = ''): Promise<string[]> {
  const rows = await store.all<{ email: string }>(
    `SELECT email FROM users WHERE ${ACTIVE_ADMIN} AND id != ? ORDER BY created_at ASC`,
    [exceptUserId]
  );
  return rows.map((r) => r.email);
}

/**
 * Throw when the policy is `one` and an active admin other than
 * `exceptUserId` exists. Call it before anything that would leave
 * `exceptUserId` (or a new account) as an active admin.
 */
export async function assertAdminSlotFree(store: MetadataStore, exceptUserId = ''): Promise<void> {
  if ((await readAdminPolicy(store)).value === 'several') return;
  const others = await activeAdminEmails(store, exceptUserId);
  if (others.length > 0) {
    throw new AdminPolicyError(`This install allows one admin, and ${others[0]} is it. Transfer the admin role instead.`);
  }
}

/**
 * Store the policy. Switching to `one` is refused while more than one admin
 * is active: an install that says "one" while it has three would be a lie
 * nobody notices until the next promotion fails.
 */
export async function writeAdminPolicy(store: MetadataStore, value: AdminPolicyValue): Promise<void> {
  if (envPolicy()) throw new Error('The admin policy is set by FOX_ADMIN_POLICY on the server.');
  if (value === 'one') {
    const admins = await activeAdminEmails(store);
    if (admins.length > 1) {
      throw new AdminPolicyError(
        `This install has ${admins.length} active admins (${admins.join(', ')}). Make all but one of them non-admins first.`
      );
    }
  }
  await store.upsert(
    'app_settings',
    ['key'],
    { key: ADMIN_POLICY_KEY, value, updated_at: new Date().toISOString() },
    ['value', 'updated_at']
  );
}

/**
 * Record the default once: `one` for an install with at most one active admin
 * (a new install has none), `several` for one that already has more, so an
 * upgrade never locks anybody out of a role they hold.
 */
export async function backfillAdminPolicy(store: MetadataStore): Promise<void> {
  const row = await store.get<{ value: string | null }>('SELECT "value" FROM app_settings WHERE "key" = ?', [
    ADMIN_POLICY_KEY,
  ]);
  if (row) return;
  const admins = await activeAdminEmails(store);
  await store.upsert(
    'app_settings',
    ['key'],
    { key: ADMIN_POLICY_KEY, value: admins.length > 1 ? 'several' : 'one', updated_at: new Date().toISOString() },
    ['value', 'updated_at']
  );
}
