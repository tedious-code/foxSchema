/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * First-run setup, now that every install signs in.
 *
 * An install that ran without sign-in kept everything under one local account
 * whose password nobody knows. Setup must hand that account to its owner (so
 * saved connections and history survive), create the first admin on a fresh
 * install, and never open again once anyone can sign in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.APP_DB_PATH = ':memory:';

import { AuthModule } from './auth.service';
import { getStore } from '../../database/store';

const auth = new AuthModule();

async function clearUsers(): Promise<void> {
  const store = await getStore();
  await store.run('DELETE FROM sessions');
  await store.run('DELETE FROM users');
}

/** A row as the old single-user mode created it: random password, never set. */
async function legacyLocalUser(email = 'local@foxschema.app'): Promise<string> {
  const store = await getStore();
  const id = `legacy-${email}`;
  await store.run(
    "INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, 'x', ?, 'admin')",
    [id, email, new Date().toISOString()]
  );
  return id;
}

beforeEach(async () => {
  await auth.getUserByToken('none'); // run migrations
  await clearUsers();
  delete process.env.APP_USER_EMAIL;
  delete process.env.LOCAL_SINGLE_USER;
});
afterEach(() => {
  delete process.env.APP_USER_EMAIL;
  delete process.env.LOCAL_SINGLE_USER;
});

describe('first-run setup', () => {
  it('is required on a fresh install and creates the first admin', async () => {
    expect((await auth.setupState()).setupRequired).toBe(true);
    const { user, token } = await auth.completeSetup('Owner@Example.com', 'correct-horse-9');
    expect(user.email).toBe('owner@example.com');
    expect(user.role).toBe('admin');
    expect((await auth.getUserByToken(token))?.id).toBe(user.id);
    expect((await auth.setupState()).setupRequired).toBe(false);
  });

  it('claims the legacy local account instead of replacing it', async () => {
    const legacyId = await legacyLocalUser();
    expect((await auth.setupState()).setupRequired).toBe(true);
    const { user } = await auth.completeSetup('owner@example.com', 'correct-horse-9');
    // Same row: everything saved under the old local account now belongs to the owner.
    expect(user.id).toBe(legacyId);
    expect(user.email).toBe('owner@example.com');
    const { user: signedIn } = await auth.login('owner@example.com', 'correct-horse-9');
    expect(signedIn.id).toBe(legacyId);
  });

  it('uses the email the install is bound to, whatever is typed', async () => {
    process.env.APP_USER_EMAIL = 'bound@example.com';
    const legacyId = await legacyLocalUser('bound@example.com');
    expect((await auth.setupState()).setupEmail).toBe('bound@example.com');
    const { user } = await auth.completeSetup('someone-else@example.com', 'correct-horse-9');
    expect(user.id).toBe(legacyId);
    expect(user.email).toBe('bound@example.com');
  });

  it('closes for good once any account can sign in', async () => {
    await auth.completeSetup('owner@example.com', 'correct-horse-9');
    await expect(auth.completeSetup('intruder@example.com', 'correct-horse-9')).rejects.toThrow(
      /already complete/
    );
  });

  it('only one of two racing setups succeeds', async () => {
    const results = await Promise.allSettled([
      auth.completeSetup('first@example.com', 'correct-horse-9'),
      auth.completeSetup('second@example.com', 'correct-horse-9'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('never claims an account on a deployment that already ran multi-user', async () => {
    // Real accounts with real passwords exist there; none has signed in since
    // the upgrade, so password_set is still 0 for all of them.
    process.env.LOCAL_SINGLE_USER = 'false';
    await legacyLocalUser('admin@corp.example');
    expect((await auth.setupState()).setupRequired).toBe(false);
    await expect(auth.completeSetup('attacker@example.com', 'correct-horse-9')).rejects.toThrow(
      /already complete/
    );
  });

  it('the CLI and the app resolve the same owner account, before and after setup', async () => {
    const fresh = await auth.ownerAccount();
    expect(fresh.email).toBe('local@foxschema.app');
    const { user } = await auth.completeSetup('owner@example.com', 'correct-horse-9');
    // Setup claimed the account the CLI created, and the CLI still finds it
    // under its new email.
    expect(user.id).toBe(fresh.id);
    expect((await auth.ownerAccount()).id).toBe(fresh.id);
  });

  it('a successful sign-in by an existing account also closes setup', async () => {
    const created = await auth.createUser('existing@example.com', 'correct-horse-9', 'admin');
    const store = await getStore();
    // As after the migration: the flag starts at 0 on rows that predate it.
    await store.run('UPDATE users SET password_set = 0 WHERE id = ?', [created.id]);
    expect((await auth.setupState()).setupRequired).toBe(true);
    await auth.login('existing@example.com', 'correct-horse-9');
    expect((await auth.setupState()).setupRequired).toBe(false);
  });
});
