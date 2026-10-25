/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Schema history refuses a store with no schema. Redis now has a provider for
 * browsing, so a capture would otherwise store a sampled keyspace as a
 * "version" and diff it against the next sample.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeCaptureLiveSchema } from './live-capture.service';

function capture() {
  const lokee = { capture: vi.fn(async () => ({ versionId: 'v1' })) };
  const loadScopedTables = vi.fn(async () => ({ tables: [], warnings: [] }));
  const run = makeCaptureLiveSchema(lokee as never, loadScopedTables as never);
  return { lokee, loadScopedTables, run };
}

const scope = { userId: 'u', workspaceId: 'w' } as never;

describe('capturing schema history', () => {
  it.each(['redis', 'mongodb'])('refuses %s before reading anything', async (dialect) => {
    const { run, loadScopedTables, lokee } = capture();
    await expect(run(scope, { dialect, option: {}, schema: '0' } as never, 'manual' as never)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/no schema/i),
    });
    expect(loadScopedTables).not.toHaveBeenCalled();
    expect(lokee.capture).not.toHaveBeenCalled();
  });

  it('still captures an SQL engine', async () => {
    const { run, lokee } = capture();
    await run(scope, { dialect: 'postgres', option: { host: 'h' }, schema: 'app' } as never, 'manual' as never);
    expect(lokee.capture).toHaveBeenCalledTimes(1);
  });
});
