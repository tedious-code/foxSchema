/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The session routes the HTTP tests in this folder do not drive: sign-out
 * ends the session on the server as well as in the browser, `/me` answers
 * someone signed out without an error and survives a workspace they left,
 * and signing out elsewhere keeps the session that asked.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppRequest, HttpMethod } from '../../platform/http/types';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { ServiceError } from '../../platform/contracts/actor';
import { SESSION_COOKIE, type AuthModule } from '../../platform/identity/auth.service';
import type { AuthMailer } from '../../platform/identity/auth-mail';
import type { SignupModule } from '../users';
import { createAuthRoutes } from './auth.routes';

const USER = { id: 'u-1', email: 'u-1@example.test', role: 'editor' };
const WORKSPACE = { id: 'personal-u-1', name: 'Personal' };

function routes() {
  const auth = {
    logout: vi.fn(async (_token: string | undefined) => undefined),
    resolveSession: vi.fn(async (token: string | undefined) => (token === 'tok-1' ? { user: USER, launch: false } : null)),
    getUserByToken: vi.fn(async (token: string | undefined) => (token === 'tok-1' ? USER : null)),
    signOutOtherSessions: vi.fn(async (_userId: string, _keep: string) => 2),
    emailVerification: vi.fn(async (_userId: string) => ({ required: false, verified: false })),
    inWorkspace: vi.fn(async (_user: unknown, _id: string | undefined) => ({ workspace: WORKSPACE, permissions: ['schema.browse'] })),
    registrationState: vi.fn(async () => ({})),
  };
  const router = createAuthRoutes(auth as unknown as AuthModule, {} as AuthMailer, {} as SignupModule);
  const call = async (method: HttpMethod, path: string, headers: Record<string, string> = {}) => {
    const { reply, sent } = fakeReply();
    await routeHandler(router, method, path)({ headers, body: {} } as unknown as AppRequest, reply);
    return sent;
  };
  return { auth, call };
}

const signedIn = { cookie: `${SESSION_COOKIE}=tok-1` };

describe('POST /logout', () => {
  it('ends the session the cookie names, then deletes the cookie', async () => {
    const { auth, call } = routes();
    const sent = await call('POST', '/logout', signedIn);
    expect(auth.logout).toHaveBeenCalledWith('tok-1');
    expect(sent.headers['set-cookie']).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(sent.headers['set-cookie']).toContain('Expires=Thu, 01 Jan 1970');
    expect(sent.body).toEqual({ ok: true });
  });

  it('still deletes the cookie when there is no session to end', async () => {
    const { auth, call } = routes();
    const sent = await call('POST', '/logout');
    expect(auth.logout).toHaveBeenCalledWith(undefined);
    expect(sent.headers['set-cookie']).toContain('Expires=Thu, 01 Jan 1970');
  });
});

describe('GET /me', () => {
  it('answers someone signed out with no user, not an error', async () => {
    const { call } = routes();
    const sent = await call('GET', '/me');
    expect(sent.status).toBeUndefined();
    expect(sent.body).toEqual({ user: null });
  });

  it('answers with the default workspace when the remembered one was left', async () => {
    const { auth, call } = routes();
    auth.inWorkspace.mockRejectedValueOnce(new ServiceError('not_found', 'Workspace not found'));
    const sent = await call('GET', '/me', { ...signedIn, 'x-fox-workspace': 'team-gone' });
    expect(auth.inWorkspace.mock.calls.map(([, id]) => id)).toEqual(['team-gone', undefined]);
    expect(sent.body).toMatchObject({ user: { id: 'u-1', permissions: ['schema.browse'] }, workspace: WORKSPACE });
  });

  it('lets any other workspace failure through rather than guessing', async () => {
    const { auth, call } = routes();
    auth.inWorkspace.mockRejectedValueOnce(new Error('metadata database is locked'));
    await expect(call('GET', '/me', signedIn)).rejects.toThrow('metadata database is locked');
  });
});

describe('POST /sign-out-others', () => {
  it('needs a session', async () => {
    const { auth, call } = routes();
    expect((await call('POST', '/sign-out-others')).status).toBe(401);
    expect((await call('POST', '/sign-out-others', { cookie: `${SESSION_COOKIE}=expired` })).status).toBe(401);
    expect(auth.signOutOtherSessions).not.toHaveBeenCalled();
  });

  it('ends the account’s other sessions and keeps the one that asked', async () => {
    const { auth, call } = routes();
    const sent = await call('POST', '/sign-out-others', signedIn);
    expect(auth.signOutOtherSessions).toHaveBeenCalledWith('u-1', 'tok-1');
    expect(sent.body).toEqual({ signedOut: 2 });
  });
});
