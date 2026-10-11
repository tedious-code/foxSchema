/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `POST /schema/load` must not refuse a PostgreSQL connection that has no
 * schema set.
 *
 * This is the endpoint where the `schemaRequired` disagreement actually hurt
 * someone. The browser's copy of the provider registry said PostgreSQL's schema
 * was optional, so the connection form marked the field "(optional)" and saved
 * happily. This route reads the *canonical* registry, which said it was
 * required, so the very next action — browsing that connection — came back
 * `invalid_input` with "PostgreSQL requires a schema". Neither side was
 * obviously wrong on its own; only together.
 *
 * The guard itself is one line. It is worth a test because the line is easy to
 * read as a display concern and is in fact the thing that decides whether a
 * saved connection can be used at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { createSchemaRoutes } from './schema.routes';

/** The `/schema/load` handler, pulled out of the collected route tree. */
function loadHandler(deps: Parameters<typeof createSchemaRoutes>[0]) {
  return routeHandler(createSchemaRoutes(deps), 'POST', '/schema/load');
}

function depsFor(dialect: string, schema: string | undefined) {
  const loadScopedTables = vi.fn().mockResolvedValue({ tables: [{ name: 'users' }], warnings: [] });
  return {
    deps: {
      resolveRef: vi.fn().mockResolvedValue({ dialect, option: { host: 'db' }, schema }),
      connectionModule: {},
      loadScopedTables,
    },
    loadScopedTables,
  };
}

async function callLoad(dialect: string, schema: string | undefined) {
  const { deps, loadScopedTables } = depsFor(dialect, schema);
  const { reply, sent } = fakeReply();
  await loadHandler(deps)({ body: { connectionId: 'c1', scope: ['TABLE'] }, userId: 'u1' } as never, reply as never);
  return { sent, loadScopedTables };
}

describe('POST /schema/load and the schemaRequired guard', () => {
  it('loads a PostgreSQL schema when none is set', async () => {
    const { sent, loadScopedTables } = await callLoad('postgres', undefined);
    expect(loadScopedTables).toHaveBeenCalled();
    expect(sent.body).toEqual({ tables: [{ name: 'users' }] });
  });

  it('loads a PostgreSQL schema when the value is blank rather than absent', async () => {
    // A saved connection round-trips an unset schema as '' as often as undefined.
    const { sent, loadScopedTables } = await callLoad('postgres', '   ');
    expect(loadScopedTables).toHaveBeenCalled();
    expect(sent.body).toEqual({ tables: [{ name: 'users' }] });
  });

  it('still loads normally when a PostgreSQL schema is set', async () => {
    const { loadScopedTables } = await callLoad('postgres', 'reporting');
    expect(loadScopedTables).toHaveBeenCalled();
  });

  it('still refuses an engine that genuinely needs a schema', async () => {
    // The guard is not removed, only corrected for PostgreSQL. Db2 has no
    // usable default, so browsing without one cannot work.
    const { sent, loadScopedTables } = await callLoad('db2', undefined);
    expect(loadScopedTables).not.toHaveBeenCalled();
    expect(JSON.stringify(sent.body)).toContain('requires a schema');
  });
});
