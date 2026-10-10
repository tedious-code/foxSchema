/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbObjectType, TableSchema } from '@/shared/lib/types';

const { loadSchemaMock } = vi.hoisted(() => ({
  loadSchemaMock: vi.fn(),
}));

vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/schemaApi')>();
  return { ...actual, loadSchema: loadSchemaMock };
});

import { useSqlEditorStore } from './useSqlEditorStore';
import { useSyncStore } from '@/features/compare';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function schemaObject(name: string, objectType: DbObjectType): TableSchema {
  return {
    name,
    objectType,
    columns: [],
    indices: [],
    foreignKeys: [],
  };
}

describe('SQL Editor scoped schema cache', () => {
  beforeEach(() => {
    loadSchemaMock.mockReset();
    useSyncStore.setState({
      connections: [
        {
          id: 'schema-race',
          name: 'Test database',
          dialect: 'postgres',
          database: 'app',
          schema: 'public',
          hasPassword: true,
        },
      ],
    } as never);
    useSqlEditorStore.setState({
      schemaCache: {},
      pendingPassword: null,
      sessionPasswords: {},
    });
  });

  it('keeps both scopes when the slower concurrent load finishes last', async () => {
    const warm = deferred<{ tables: TableSchema[] }>();
    const routines = deferred<{ tables: TableSchema[] }>();
    loadSchemaMock.mockImplementation(
      (_ref: unknown, scope: DbObjectType[]) =>
        (scope.includes('TABLE') ? warm.promise : routines.promise)
    );

    const warmLoad = useSqlEditorStore
      .getState()
      .ensureSchema('schema-race', { scope: ['TABLE', 'VIEW', 'MQT'] });
    const routineLoad = useSqlEditorStore
      .getState()
      .ensureSchema('schema-race', { scope: ['PROCEDURE', 'FUNCTION'] });

    warm.resolve({ tables: [schemaObject('ORDERS', 'TABLE')] });
    await warmLoad;
    routines.resolve({ tables: [schemaObject('REFRESH_ORDERS', 'PROCEDURE')] });
    await routineLoad;

    const cached = useSqlEditorStore.getState().schemaCache['schema-race'];
    expect(cached?.tables?.map((table) => table.name).sort()).toEqual([
      'ORDERS',
      'REFRESH_ORDERS',
    ]);
    expect(new Set(cached?.scope)).toEqual(
      new Set(['TABLE', 'VIEW', 'MQT', 'PROCEDURE', 'FUNCTION'])
    );
  });
});
