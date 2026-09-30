/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Getting back in, and keeping others out.
 *
 * Reset and invite codes are credentials: each works once, for a while, for
 * one account, and a copy of the database holds none that work. Sign-in locks
 * an email after repeated failures, for emails with and without an account
 * alike, and a wrong email costs the same as a wrong password.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.APP_DB_PATH = ':memory:';

import { AuthModule, SignInLockedError } from './auth.service';
import { getStore } from '../../database/store';
import { MAX_FAILURES, LOCKOUT_MS, lockedFor, resetSignInThrottle } from './sign-in-throttle';
import { hashSecretToken, normalizeAuthCode } from './auth-codes';

const auth = new AuthModule();
const PASSWORD = 'blue-lantern-42';
const NEW_PASSWORD = 'green-river-17';

beforeEach(async () => {
  await auth.getUserByToken('none'); // run migrations
  const store = await getStore();
  await store.run('DELETE FROM auth_codes');
  await store.run('DELETE FROM sessions');
  await store.run('DELETE FROM users');
  resetSignInThrottle();
});

describe('password reset', () => {
  it('sets a new password once, signs in, and ends every other session', async () => {
    await auth.createUser('ana@example.com', PASSWORD, 'editor');
    const { token: stolen } = await auth.login('ana@example.com', PASSWORD);

    const issued = await auth.requestPasswordReset('ANA@example.com');
    expect(issued?.email).toBe('ana@example.com');
    expect(issued?.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await auth.inspectCode(issued!.code.toLowerCase())).toEqual({ email: 'ana@example.com', purpose: 'reset' });

    const { user, token, purpose } = await auth.redeemCode(issued!.code, NEW_PASSWORD);
    expect(purpose).toBe('reset');
    expect(user.role).toBe('editor');
    expect(await auth.getUserByToken(token)).not.toBeNull();
    expect(await auth.getUserByToken(stolen)).toBeNull();

    await expect(auth.login('ana@example.com', PASSWORD)).rejects.toThrow(/Invalid email or password/);
    await expect(auth.login('ana@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
    await expect(auth.redeemCode(issued!.code, 'another-good-one-5')).rejects.toThrow(/wrong or has expired/);
  });

  it('issues nothing for an email with no account, or a deactivated one', async () => {
    expect(await auth.requestPasswordReset('nobody@example.com')).toBeNull();
    const user = await auth.createUser('gone@example.com', PASSWORD, 'viewer');
    await (await getStore()).run('UPDATE users SET active = 0 WHERE id = ?', [user.id]);
    expect(await auth.requestPasswordReset('gone@example.com')).toBeNull();
  });

  it('refuses an expired code, and a weak new password without using the code up', async () => {
    await auth.createUser('ben@example.com', PASSWORD, 'viewer');
    const issued = await auth.requestPasswordReset('ben@example.com');
    await expect(auth.redeemCode(issued!.code, 'password123')).rejects.toThrow(/first ones attackers try/);
    await expect(auth.redeemCode(issued!.code, 'ben-lantern-42x')).resolves.toBeTruthy();

    const later = await auth.requestPasswordReset('ben@example.com');
    await (await getStore()).run('UPDATE auth_codes SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    expect(await auth.inspectCode(later!.code)).toBeNull();
    await expect(auth.redeemCode(later!.code, NEW_PASSWORD)).rejects.toThrow(/wrong or has expired/);
  });

  it('a new code replaces the one before it', async () => {
    await auth.createUser('cy@example.com', PASSWORD, 'viewer');
    const first = await auth.requestPasswordReset('cy@example.com');
    const second = await auth.requestPasswordReset('cy@example.com');
    expect(await auth.inspectCode(first!.code)).toBeNull();
    expect(await auth.inspectCode(second!.code)).not.toBeNull();
  });

  it('stores only hashes: neither codes nor session tokens are in the database', async () => {
    await auth.createUser('di@example.com', PASSWORD, 'viewer');
    const { token } = await auth.login('di@example.com', PASSWORD);
    const issued = await auth.requestPasswordReset('di@example.com');
    const store = await getStore();
    const sessions = await store.all<{ token: string }>('SELECT token FROM sessions');
    const codes = await store.all<{ code_hash: string }>('SELECT code_hash FROM auth_codes');
    expect(sessions.map((s) => s.token)).toEqual([hashSecretToken(token)]);
    expect(codes.map((c) => c.code_hash)).toEqual([hashSecretToken(normalizeAuthCode(issued!.code))]);
    // The stored value is not itself a session.
    expect(await auth.getUserByToken(sessions[0]!.token)).toBeNull();
  });
});

describe('invites', () => {
  it('creates an account nobody can sign in to until the invite is redeemed', async () => {
    const { user, invite } = await auth.inviteUser('Eve@example.com', 'viewer');
    expect(invite.email).toBe('eve@example.com');
    expect(await auth.inspectCode(invite.code)).toEqual({ email: 'eve@example.com', purpose: 'invite' });

    const store = await getStore();
    const row = await store.get<{ password_set: number }>('SELECT password_set FROM users WHERE id = ?', [user.id]);
    expect(row?.password_set).toBe(0);

    const { purpose } = await auth.redeemCode(invite.code, NEW_PASSWORD);
    expect(purpose).toBe('invite');
    await expect(auth.login('eve@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
    const after = await store.get<{ password_set: number }>('SELECT password_set FROM users WHERE id = ?', [user.id]);
    expect(after?.password_set).toBe(1);
  });

  it('refuses an email that already has an account', async () => {
    await auth.createUser('fay@example.com', PASSWORD, 'viewer');
    await expect(auth.inviteUser('fay@example.com', 'viewer')).rejects.toThrow(/already exists/);
  });
});

describe('sign-in lockout', () => {
  it(`locks an email after ${MAX_FAILURES} failures, even for the right password, until the window passes`, async () => {
    await auth.createUser('gil@example.com', PASSWORD, 'viewer');
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(auth.login('gil@example.com', 'wrong-password-1')).rejects.toThrow(/Invalid email or password/);
    }
    await expect(auth.login('gil@example.com', PASSWORD)).rejects.toBeInstanceOf(SignInLockedError);
    expect(lockedFor('gil@example.com', Date.now() + LOCKOUT_MS + 1)).toBe(0);
  });

  it('locks an email with no account the same way, so the lockout reveals nothing', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(auth.login('ghost@example.com', 'wrong-password-1')).rejects.toThrow(/Invalid email or password/);
    }
    const err = await auth.login('ghost@example.com', 'wrong-password-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignInLockedError);
    expect((err as Error).message).toMatch(/Too many failed sign-ins/);
  });

  it('a correct password before the limit clears the count, and so does a reset', async () => {
    await auth.createUser('hal@example.com', PASSWORD, 'viewer');
    for (let i = 0; i < MAX_FAILURES - 1; i++) await auth.login('hal@example.com', 'nope-nope-1').catch(() => {});
    await auth.login('hal@example.com', PASSWORD);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await auth.login('hal@example.com', 'nope-nope-1').catch(() => {});
    await expect(auth.login('hal@example.com', PASSWORD)).resolves.toBeTruthy();

    for (let i = 0; i < MAX_FAILURES; i++) await auth.login('hal@example.com', 'nope-nope-1').catch(() => {});
    const issued = await auth.requestPasswordReset('hal@example.com');
    await auth.redeemCode(issued!.code, NEW_PASSWORD);
    await expect(auth.login('hal@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
  });
});
