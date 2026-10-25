/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The confirmation ladder in front of Lokee revert and force-migrate.
 *
 * Both routes refuse with a 409 whose `code` the web client narrows on
 * (`lokeeApi.ts`): `blocked` outright, `confirm_lossy` until the reader accepts
 * data loss, and — force-migrate only — `confirm_force` until they also accept
 * writing onto a database the history was not captured from. The plan rides
 * along so the dialog can show what would run. Nothing executes on a refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { createHistoryRoutes, type HistoryRouteDeps } from './history.routes';

function handlerFor(deps: HistoryRouteDeps, path: string) {
  return routeHandler(createHistoryRoutes(deps), 'POST', path);
}

let dbSeq = 0;
function deps(risk: 'safe' | 'lossy' | 'blocked', commitRequired = false) {
  const plan = {
    steps: [{ objectName: 'T', objectType: 'TABLE', action: 'ALTER', statements: ['ALTER TABLE t DROP COLUMN c'] }],
    reversal: { risk },
    version: { number: 3 },
  };
  const execute = vi.fn().mockResolvedValue(undefined);
  const d = {
    lokee: {
      matchDatabaseIdentity: vi.fn().mockResolvedValue('match'),
      planRevert: vi.fn().mockResolvedValue({ ...plan, alreadyAtTarget: false }),
      planForceMigrate: vi.fn().mockResolvedValue({ ...plan, alreadyMatches: false }),
    } as unknown as HistoryRouteDeps['lokee'],
    captureLiveSchema: vi.fn().mockResolvedValue({ changed: false }),
    // A distinct database per call so the target lock never carries over.
    resolveRef: vi.fn().mockImplementation(async () => ({
      dialect: 'postgres',
      option: { host: 'h', database: `db${++dbSeq}` },
      schema: 'public',
    })),
    migrationModule: { execute } as never,
    loadScopedTables: vi.fn().mockResolvedValue({ tables: [] }),
    commitRequired: vi.fn().mockResolvedValue(commitRequired),
  } satisfies HistoryRouteDeps;
  return { d, execute };
}

async function call(path: string, risk: 'safe' | 'lossy' | 'blocked', body: Record<string, unknown>, commitRequired = false) {
  const { d, execute } = deps(risk, commitRequired);
  const { reply, sent } = fakeReply();
  await handlerFor(d, path)(
    { body: { connectionId: 'c', ...body }, params: { id: 'db1' }, userId: 'u1', workspaceId: 'w1' } as never,
    reply as never
  );
  return { sent, execute };
}

const REVERT = '/lokee/databases/:id/revert';
const FORCE = '/lokee/databases/:id/force-migrate';

describe('revert refusals', () => {
  it.each([
    ['blocked', {}, 'blocked'],
    ['lossy', {}, 'confirm_lossy'],
  ] as const)('%s plan without confirmation -> 409 %s', async (risk, extra, code) => {
    const { sent, execute } = await call(REVERT, risk, { toVersionId: 'v1', ...extra });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ ok: false, code, reversal: { risk } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('a blocked plan stays blocked even when data loss is accepted', async () => {
    const { sent } = await call(REVERT, 'blocked', { toVersionId: 'v1', confirmLossy: true });
    expect(sent.body).toMatchObject({ code: 'blocked' });
  });

  it('never asks a revert for confirm_force', async () => {
    const { sent, execute } = await call(REVERT, 'lossy', { toVersionId: 'v1', confirmLossy: true });
    expect(sent.status).not.toBe(409);
    expect(execute).toHaveBeenCalled();
  });
});

describe('force-migrate refusals', () => {
  it('asks for data-loss confirmation before the force confirmation', async () => {
    const { sent } = await call(FORCE, 'lossy', { versionId: 'v1', confirmForce: true });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ ok: false, code: 'confirm_lossy' });
  });

  it('accepting data loss does not stand in for confirm_force', async () => {
    const { sent, execute } = await call(FORCE, 'lossy', { versionId: 'v1', confirmLossy: true });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ ok: false, code: 'confirm_force', version: { number: 3 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('a safe plan still needs confirm_force', async () => {
    const { sent } = await call(FORCE, 'safe', { versionId: 'v1' });
    expect(sent.body).toMatchObject({ code: 'confirm_force' });
  });

  it('runs once both answers are given', async () => {
    const { sent, execute } = await call(FORCE, 'lossy', { versionId: 'v1', confirmLossy: true, confirmForce: true });
    expect(sent.status).not.toBe(409);
    expect(execute).toHaveBeenCalled();
  });
});

describe('when the install requires migrations committed to Git', () => {
  it.each([
    ['revert', REVERT, { toVersionId: 'v1', confirmLossy: true }],
    ['force-migrate', FORCE, { versionId: 'v1', confirmLossy: true, confirmForce: true }],
  ] as const)('refuses %s and runs nothing, whatever was confirmed', async (_name, path, body) => {
    const { sent, execute } = await call(path, 'safe', body, true);
    expect(sent.status).toBe(403);
    expect(JSON.stringify(sent.body)).toMatch(/committed to Git/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('force-migrate onto an engine without a SQL dialect', () => {
  // Redis and MongoDB load as a keyspace sample, and `resolveDialect` answers
  // Db2 for a name it does not know: a plan here would be Db2 DDL for Redis.
  it.each(['/lokee/databases/:id/force-migrate/plan', FORCE])('%s refuses a Redis target before reading it', async (path) => {
    const { d, execute } = deps('safe');
    d.resolveRef.mockResolvedValue({ dialect: 'redis', option: { host: 'h', database: '0' }, schema: '' });
    const { reply, sent } = fakeReply();
    await handlerFor(d, path)(
      {
        body: { connectionId: 'c', versionId: 'v1', confirmLossy: true, confirmForce: true },
        params: { id: 'db1' },
        userId: 'u1',
        workspaceId: 'w1',
      } as never,
      reply as never
    );
    expect(sent.status).toBe(400);
    expect(d.loadScopedTables).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
