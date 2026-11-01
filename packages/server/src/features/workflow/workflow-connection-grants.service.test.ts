/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Grants decide which saved connections the workflow engine can decrypt, so
 * the cases that matter are the refusals: someone else's connection, a revoked
 * grant, and a connection that no longer exists.
 */
import { beforeAll, describe, expect, it } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AuthModule, type AuthUser } from '../../platform/identity/auth.service';
import type { WorkspaceScope } from '../../platform/http/scope';
import { ConnectionStore } from '../../platform/connections/connection-store.service';
import { WorkflowConnectionGrants } from './workflow-connection-grants.service';

const auth = new AuthModule();

/** The account's own workspace, which its rows now belong to. */
const scopeFor = async (user: AuthUser): Promise<WorkspaceScope> => ({
  userId: user.id,
  workspaceId: (await auth.inWorkspace(user, undefined)).workspace.id,
});
const connections = new ConnectionStore();
const grants = new WorkflowConnectionGrants(connections);

let alice: WorkspaceScope;
let bob: WorkspaceScope;

const saved = (password?: string) => ({
  name: 'warehouse',
  dialect: 'postgres',
  schema: 'public',
  option: { host: 'db.internal', database: 'dw', username: 'etl', ...(password ? { password } : {}) },
});

beforeAll(async () => {
  alice = await scopeFor(await auth.createUser('grant-alice@example.com', 'correct-horse-9', 'viewer'));
  bob = await scopeFor(await auth.createUser('grant-bob@example.com', 'correct-horse-9', 'viewer'));
});

describe('WorkflowConnectionGrants', () => {
  it('resolves nothing for the engine until the owner grants the connection', async () => {
    const { id } = await connections.create(alice, saved('s3cret'));
    expect(await grants.resolveForEngine(id)).toBeUndefined();

    expect(await grants.grant(alice, id)).toBe('warehouse');
    const resolved = await grants.resolveForEngine(id);
    expect(resolved).toMatchObject({ dialect: 'postgres', schema: 'public' });
    expect(resolved?.option.password).toBe('s3cret');
  });

  it('refuses to grant a connection that belongs to someone else', async () => {
    const { id } = await connections.create(alice, saved('s3cret'));
    expect(await grants.grant(bob, id)).toBeUndefined();
    expect(await grants.resolveForEngine(id)).toBeUndefined();
  });

  it('stops resolving once the grant is revoked', async () => {
    const { id } = await connections.create(alice, saved('s3cret'));
    await grants.grant(alice, id);
    expect(await grants.revoke(alice.userId, id)).toBe(true);
    expect(await grants.resolveForEngine(id)).toBeUndefined();
  });

  it('only lets the owner revoke', async () => {
    const { id } = await connections.create(alice, saved('s3cret'));
    await grants.grant(alice, id);
    expect(await grants.revoke(bob.userId, id)).toBe(false);
    expect(await grants.resolveForEngine(id)).toBeDefined();
  });

  it('stops resolving a granted connection its owner deleted', async () => {
    const { id } = await connections.create(alice, saved('s3cret'));
    await grants.grant(alice, id);
    await connections.remove(alice, id);
    expect(await grants.resolveForEngine(id)).toBeUndefined();
  });

  it('lists the caller’s connections with their grant state and no secrets', async () => {
    const { id: granted } = await connections.create(bob, saved('hidden-pw'));
    const { id: withoutPassword } = await connections.create(bob, saved());
    await grants.grant(bob, granted);

    const listed = await grants.list(bob);
    expect(listed.find((c) => c.id === granted)).toMatchObject({ granted: true, hasPassword: true });
    expect(listed.find((c) => c.id === withoutPassword)).toMatchObject({ granted: false, hasPassword: false });
    expect(JSON.stringify(listed)).not.toContain('hidden-pw');
  });

  // The editor decides from these whether a connection with no saved password
  // can still sign in (a Redis or MongoDB with no user can).
  it('lists the user and sign-in method of each connection, still with no secrets', async () => {
    const { id: directory } = await connections.create(bob, {
      name: 'mainframe',
      dialect: 'db2',
      option: { host: 'db2.internal', database: 'SAMPLE', username: 'etl', authMethod: 'ldap', password: 'dir-pw' },
    });
    const { id: open } = await connections.create(bob, {
      name: 'cache',
      dialect: 'redis',
      option: { host: 'cache.internal', authMethod: 'none' },
    });
    // `requirepass` only: no user, yet a run needs the password it was saved without.
    const { id: requirepass } = await connections.create(bob, {
      name: 'sessions',
      dialect: 'redis',
      option: { host: 'cache.internal', authMethod: 'password' },
    });

    const listed = await grants.list(bob);
    expect(listed.find((c) => c.id === directory)).toMatchObject({
      username: 'etl',
      authMethod: 'ldap',
      hasPassword: true,
    });
    const cache = listed.find((c) => c.id === open);
    expect(cache).toMatchObject({ dialect: 'redis', authMethod: 'none', hasPassword: false });
    expect(cache).not.toHaveProperty('username');
    const sessions = listed.find((c) => c.id === requirepass);
    expect(sessions).toMatchObject({ dialect: 'redis', authMethod: 'password', hasPassword: false });
    expect(sessions).not.toHaveProperty('username');
    expect(JSON.stringify(listed)).not.toContain('dir-pw');
  });
});

describe('who may put a saved connection in a workflow', () => {
  it('a member of the connection’s workspace, and nobody else', async () => {
    const { id: alices } = await connections.create(alice, saved('s3cret'));
    const { id: bobs } = await connections.create(bob, saved('other'));
    // Granted or not makes no difference: the engine is shared by the install,
    // so a grant would otherwise lend Alice's connection to Bob's workflows.
    await grants.grant(alice, alices);

    expect(await grants.notUsableBy(bob.userId, [alices, bobs])).toEqual([alices]);
    expect(await grants.notUsableBy(alice.userId, [alices, bobs])).toEqual([bobs]);
    expect(await grants.notUsableBy(alice.userId, [alices])).toEqual([]);
  });

  it('does not refuse an id no connection has: there is nothing behind it', async () => {
    expect(await grants.notUsableBy(bob.userId, ['no-such-connection'])).toEqual([]);
    expect(await grants.notUsableBy(bob.userId, [])).toEqual([]);
  });
});
