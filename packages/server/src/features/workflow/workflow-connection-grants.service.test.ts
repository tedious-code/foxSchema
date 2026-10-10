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

import { AuthModule, type AuthUser } from '../auth/auth.service';
import type { WorkspaceScope } from '../../platform/http/scope';
import { ConnectionStore } from '../connections/connection-store.service';
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
});
