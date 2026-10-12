/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin routes: every one sits behind its admin permission, and each refuses
 * the changes that would lock the install out of its own admin account.
 */
import { describe, expect, it, vi } from 'vitest';

// The /policy routes read and write the metadata store itself.
process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);
delete process.env.FOX_ADMIN_POLICY;

import { PERMISSION_META, type AppRole, type Permission } from '@foxschema/shared';
import type { AuthedRequest, HttpMethod, Middleware } from '../../platform/http/types';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { RbacModule } from '../../platform/authorization/rbac.service';
import { AuthModule } from '../../platform/identity/auth.service';
import type { AuthMailer } from '../../platform/identity/auth-mail';
import { AdminPolicyError } from '../../platform/authorization/admin-policy.service';
import { createAdminRoutes } from './admin.routes';

interface User {
  id: string;
  email: string;
  role: AppRole;
  active: boolean;
  passwordSet: boolean;
}

const user = (id: string, role: AppRole, extra: Partial<User> = {}): User => ({
  id,
  email: `${id}@example.test`,
  role,
  active: true,
  passwordSet: true,
  ...extra,
});

const ISSUED = { code: 'C0DE-1234', email: 'new@example.test', expiresAt: '2030-01-01T00:00:00.000Z' };

function admin(users: User[] = [user('admin-1', 'admin')]) {
  const rbac = {
    listUsers: vi.fn(async () => users),
    setUserRole: vi.fn(async (_id: string, _role: AppRole) => undefined),
    setUserActive: vi.fn(async (_id: string, _active: boolean) => undefined),
    transferAdmin: vi.fn(async (_from: string, _to: string, _demoteTo: AppRole) => undefined),
    listRolePermissionMatrix: vi.fn(async () => ({})),
    setRolePermissions: vi.fn(async (_role: AppRole, permissions: unknown[]) => permissions),
  };
  const auth = {
    createUser: vi.fn(async (email: string, _password: string, role: AppRole) => ({ id: 'new', email, role })),
    inviteUser: vi.fn(async (email: string, role: AppRole) => ({ user: { id: 'new', email, role }, invite: ISSUED })),
    adminSetPassword: vi.fn(async (_id: string, _password: string) => undefined),
    issueCode: vi.fn(async (_id: string, _purpose: string) => ISSUED),
  };
  const mailer = {
    send: vi.fn(async (): Promise<'email' | 'log'> => 'email'),
    link: vi.fn(async (purpose: string, code: string) => `https://fox.example.test/${purpose}?code=${code}`),
  };
  const router = createAdminRoutes(
    rbac as unknown as RbacModule,
    auth as unknown as AuthModule,
    mailer as unknown as AuthMailer
  );
  /** Run one route's handler as `caller` (by default the signed-in admin). */
  const call = async (
    method: HttpMethod,
    path: string,
    req: { params?: Record<string, string>; body?: unknown } = {},
    caller: Partial<AuthedRequest> = { userId: 'admin-1', appRole: 'admin' }
  ) => {
    const { reply, sent } = fakeReply();
    await routeHandler(router, method, path)({ ...caller, params: {}, ...req } as unknown as AuthedRequest, reply);
    return sent;
  };
  return { rbac, auth, mailer, router, call };
}

/** What a route's guards answer `caller`, or 'passed' when they let it through. */
async function guardsAnswer(middlewares: unknown[], caller: Partial<AuthedRequest>) {
  const { reply, sent } = fakeReply();
  for (const middleware of middlewares as Middleware[]) {
    let passed = false;
    await middleware(caller as AuthedRequest, reply, () => (passed = true));
    if (!passed) return sent;
  }
  return 'passed' as const;
}

describe('admin route guards', () => {
  const routes = admin().router.flatten();
  const expected = (path: string): Permission => (path.startsWith('/role-permissions') ? 'admin.roles' : 'admin.users');

  it('puts every route behind admin.users, or admin.roles for the permission matrix', async () => {
    expect(routes.length).toBeGreaterThan(0);
    const viewer = { userId: 'v-1', appRole: 'viewer' as const, permissions: new Set<Permission>() };
    for (const route of routes) {
      const sent = await guardsAnswer(route.middlewares, viewer);
      expect(sent, `${route.method} ${route.path}`).not.toBe('passed');
      if (sent === 'passed') continue;
      expect(sent.status, `${route.method} ${route.path}`).toBe(403);
      expect(sent.body.missing, `${route.method} ${route.path}`).toEqual([expected(route.path)]);
    }
  });

  it('lets a non-admin through with exactly that permission', async () => {
    for (const route of routes) {
      const holder = { userId: 'o-1', appRole: 'owner' as const, permissions: new Set([expected(route.path)]) };
      expect(await guardsAnswer(route.middlewares, holder), `${route.method} ${route.path}`).toBe('passed');
    }
  });

  it('answers a caller who is not signed in with 401', async () => {
    for (const route of routes) {
      const sent = await guardsAnswer(route.middlewares, {});
      expect(sent !== 'passed' && sent.status, `${route.method} ${route.path}`).toBe(401);
    }
  });
});

describe('POST /users', () => {
  it('invites without a password, and hands the admin the code and link', async () => {
    const { auth, call } = admin();
    const sent = await call('POST', '/users', { body: { email: 'new@example.test', role: 'editor' } });
    expect(auth.inviteUser).toHaveBeenCalledWith('new@example.test', 'editor');
    expect(auth.createUser).not.toHaveBeenCalled();
    expect(sent.body.invite).toMatchObject({
      code: ISSUED.code,
      link: `https://fox.example.test/invite?code=${ISSUED.code}`,
      expiresAt: ISSUED.expiresAt,
      delivery: 'email',
    });
  });

  it('treats an empty password as an invite', async () => {
    const { auth, call } = admin();
    await call('POST', '/users', { body: { email: 'new@example.test', password: '' } });
    expect(auth.inviteUser).toHaveBeenCalledWith('new@example.test', 'viewer');
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('creates the account directly when the admin sets a starting password', async () => {
    const { auth, call } = admin();
    const sent = await call('POST', '/users', { body: { email: 'new@example.test', password: 'starting-pw', role: 'owner' } });
    expect(auth.createUser).toHaveBeenCalledWith('new@example.test', 'starting-pw', 'owner');
    expect(sent.body.invite).toBeUndefined();
  });

  it('still returns the code when the email does not go out', async () => {
    const { mailer, call } = admin();
    mailer.send.mockRejectedValueOnce(new Error('SMTP refused the connection'));
    const sent = await call('POST', '/users', { body: { email: 'new@example.test' } });
    expect(sent.body.invite).toMatchObject({ code: ISSUED.code, delivery: 'failed', deliveryError: 'SMTP refused the connection' });
  });

  it('refuses an unknown role and a missing email, creating nothing', async () => {
    const { auth, call } = admin();
    expect((await call('POST', '/users', { body: { email: 'new@example.test', role: 'superuser' } })).status).toBe(400);
    expect((await call('POST', '/users', { body: { role: 'viewer' } })).status).toBe(400);
    expect(auth.inviteUser).not.toHaveBeenCalled();
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('answers 409 for an address already in use', async () => {
    const { auth, call } = admin();
    auth.inviteUser.mockRejectedValueOnce(new Error('A user with that email already exists'));
    const sent = await call('POST', '/users', { body: { email: 'admin-1@example.test' } });
    expect(sent.status).toBe(409);
  });
});

describe('PUT /users/:id/role', () => {
  it('refuses to let the last active admin demote themselves', async () => {
    // Another admin exists but is deactivated: it cannot take over.
    const { rbac, call } = admin([user('admin-1', 'admin'), user('admin-2', 'admin', { active: false })]);
    const sent = await call('PUT', '/users/:id/role', { params: { id: 'admin-1' }, body: { role: 'owner' } });
    expect(sent.status).toBe(400);
    expect(rbac.setUserRole).not.toHaveBeenCalled();
  });

  it('lets an admin step down while another active admin remains', async () => {
    const { rbac, call } = admin([user('admin-1', 'admin'), user('admin-2', 'admin')]);
    const sent = await call('PUT', '/users/:id/role', { params: { id: 'admin-1' }, body: { role: 'owner' } });
    expect(sent.body).toEqual({ ok: true, userId: 'admin-1', role: 'owner' });
    expect(rbac.setUserRole).toHaveBeenCalledWith('admin-1', 'owner');
  });

  it('answers 409 when the admin policy refuses, and 404 for an unknown account', async () => {
    const { rbac, call } = admin();
    rbac.setUserRole.mockRejectedValueOnce(new AdminPolicyError('This install allows one admin.'));
    expect((await call('PUT', '/users/:id/role', { params: { id: 'v-1' }, body: { role: 'admin' } })).status).toBe(409);
    rbac.setUserRole.mockRejectedValueOnce(new Error('User not found'));
    expect((await call('PUT', '/users/:id/role', { params: { id: 'nobody' }, body: { role: 'editor' } })).status).toBe(404);
  });

  it('refuses a role that does not exist', async () => {
    const { rbac, call } = admin();
    expect((await call('PUT', '/users/:id/role', { params: { id: 'v-1' }, body: { role: 'root' } })).status).toBe(400);
    expect(rbac.setUserRole).not.toHaveBeenCalled();
  });
});

describe('PUT /users/:id/active', () => {
  it('refuses to deactivate the caller’s own account', async () => {
    const { rbac, call } = admin();
    const sent = await call('PUT', '/users/:id/active', { params: { id: 'admin-1' }, body: { active: false } });
    expect(sent.status).toBe(400);
    expect(rbac.setUserActive).not.toHaveBeenCalled();
  });

  it('wants a real boolean', async () => {
    const { rbac, call } = admin();
    expect((await call('PUT', '/users/:id/active', { params: { id: 'v-1' }, body: { active: 'false' } })).status).toBe(400);
    expect(rbac.setUserActive).not.toHaveBeenCalled();
  });

  it('deactivates someone else', async () => {
    const { rbac, call } = admin();
    const sent = await call('PUT', '/users/:id/active', { params: { id: 'v-1' }, body: { active: false } });
    expect(sent.body).toEqual({ ok: true, userId: 'v-1', active: false });
    expect(rbac.setUserActive).toHaveBeenCalledWith('v-1', false);
  });
});

describe('POST /users/:id/transfer-admin', () => {
  it('is for the admin alone, even to an owner granted admin.users', async () => {
    const { rbac, call } = admin();
    const owner = { userId: 'o-1', appRole: 'owner' as const, permissions: new Set<Permission>(['admin.users']) };
    const sent = await call('POST', '/users/:id/transfer-admin', { params: { id: 'o-1' } }, owner);
    expect(sent.status).toBe(403);
    expect(rbac.transferAdmin).not.toHaveBeenCalled();
  });

  it('demotes the old admin to owner unless told otherwise, never to admin', async () => {
    const { rbac, call } = admin();
    await call('POST', '/users/:id/transfer-admin', { params: { id: 'o-1' } });
    expect(rbac.transferAdmin).toHaveBeenCalledWith('admin-1', 'o-1', 'owner');
    const sent = await call('POST', '/users/:id/transfer-admin', { params: { id: 'o-1' }, body: { demoteTo: 'admin' } });
    expect(sent.status).toBe(400);
    expect(rbac.transferAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('POST /users/:id/code', () => {
  it('issues a reset once a password is set, and a fresh invite before', async () => {
    const { auth, call } = admin([user('admin-1', 'admin'), user('set', 'editor'), user('pending', 'editor', { passwordSet: false })]);
    expect((await call('POST', '/users/:id/code', { params: { id: 'set' } })).body.purpose).toBe('reset');
    expect((await call('POST', '/users/:id/code', { params: { id: 'pending' } })).body.purpose).toBe('invite');
    expect(auth.issueCode.mock.calls).toEqual([
      ['set', 'reset'],
      ['pending', 'invite'],
    ]);
  });

  it('issues nothing for an unknown or deactivated account', async () => {
    const { auth, call } = admin([user('admin-1', 'admin'), user('off', 'editor', { active: false })]);
    expect((await call('POST', '/users/:id/code', { params: { id: 'nobody' } })).status).toBe(404);
    expect((await call('POST', '/users/:id/code', { params: { id: 'off' } })).status).toBe(400);
    expect(auth.issueCode).not.toHaveBeenCalled();
  });
});

describe('PUT /users/:id/password', () => {
  it('wants text, and answers 404 for an unknown account', async () => {
    const { auth, call } = admin();
    expect((await call('PUT', '/users/:id/password', { params: { id: 'v-1' }, body: {} })).status).toBe(400);
    expect(auth.adminSetPassword).not.toHaveBeenCalled();
    auth.adminSetPassword.mockRejectedValueOnce(new Error('User not found'));
    expect((await call('PUT', '/users/:id/password', { params: { id: 'nobody' }, body: { password: 'next-pw' } })).status).toBe(404);
  });
});

describe('PUT /role-permissions/:role', () => {
  it('wants a known role and an array, and saves what the service accepts', async () => {
    const { rbac, call } = admin();
    expect((await call('PUT', '/role-permissions/:role', { params: { role: 'root' }, body: { permissions: [] } })).status).toBe(400);
    expect((await call('PUT', '/role-permissions/:role', { params: { role: 'editor' }, body: { permissions: 'all' } })).status).toBe(400);
    expect(rbac.setRolePermissions).not.toHaveBeenCalled();
    const sent = await call('PUT', '/role-permissions/:role', { params: { role: 'editor' }, body: { permissions: ['schema.browse'] } });
    expect(sent.body).toEqual({ role: 'editor', permissions: ['schema.browse'] });
  });
});

describe('GET /users and GET /role-permissions', () => {
  it('answer with what the service lists, the matrix with its catalog', async () => {
    const { rbac, call } = admin();
    expect((await call('GET', '/users')).body).toEqual({ users: await rbac.listUsers() });
    rbac.listRolePermissionMatrix.mockResolvedValueOnce({ editor: ['schema.browse'] });
    expect((await call('GET', '/role-permissions')).body).toEqual({
      matrix: { editor: ['schema.browse'] },
      catalog: PERMISSION_META,
    });
  });
});

describe('/policy', () => {
  it('refuses one admin while two are active, and lists them', async () => {
    const { call } = admin();
    await call('PUT', '/policy', { body: { adminPolicy: 'several' } });
    const accounts = new AuthModule();
    await accounts.createUser('policy-a@example.test', 'correct-horse-9', 'admin');
    const second = await accounts.createUser('policy-b@example.test', 'correct-horse-9', 'admin');
    expect((await call('PUT', '/policy', { body: { adminPolicy: 'one' } })).status).toBe(409);
    const read = (await call('GET', '/policy')).body;
    expect(read.adminPolicy).toBe('several');
    expect(read.activeAdmins).toEqual(expect.arrayContaining(['policy-a@example.test', 'policy-b@example.test']));
    // One active admin again, so the next test may switch to `one`.
    await new RbacModule().setUserActive(second.id, false);
  });

  it('saves each setting it is sent, leaving the others, and reads back what was saved', async () => {
    const { call } = admin();
    const put = async (body: unknown) => expect((await call('PUT', '/policy', { body })).body).toEqual({ ok: true });
    const read = async () => (await call('GET', '/policy')).body;

    await put({ adminPolicy: 'several', membersCanCreateWorkspaces: true, ownersCanInviteNew: true });
    expect(await read()).toMatchObject({ adminPolicy: 'several', source: 'app', membersCanCreateWorkspaces: true, ownersCanInviteNew: true });
    await put({ membersCanCreateWorkspaces: false });
    expect(await read()).toMatchObject({ adminPolicy: 'several', membersCanCreateWorkspaces: false, ownersCanInviteNew: true });
    await put({ adminPolicy: 'one', ownersCanInviteNew: false });
    expect(await read()).toMatchObject({ adminPolicy: 'one', membersCanCreateWorkspaces: false, ownersCanInviteNew: false });
  });

  it('refuses a body with nothing to change, an unknown policy, or a flag that is not a boolean', async () => {
    const { call } = admin();
    expect((await call('PUT', '/policy', { body: {} })).status).toBe(400);
    expect((await call('PUT', '/policy', { body: { adminPolicy: 'many' } })).status).toBe(400);
    expect((await call('PUT', '/policy', { body: { membersCanCreateWorkspaces: 'on' } })).status).toBe(400);
    expect((await call('PUT', '/policy', { body: { ownersCanInviteNew: 1 } })).status).toBe(400);
  });
});
