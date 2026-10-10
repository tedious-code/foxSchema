/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every grantable object in the database, grouped by the schema that owns it.
 *
 * The permission grid used to start empty, one blank row, and ask the reader to
 * type object names they had to remember. This loads the catalog instead, so
 * the grid opens on the real database and the work is ticking boxes.
 *
 * Grouped by schema, and per-schema, because that is the level grants are
 * written at on every engine that has schemas at all. On MySQL, MariaDB, TiDB
 * and Oracle there is no schema-level GRANT — a MySQL "database" *is* the
 * schema and an Oracle schema *is* a user — so there the list is one group and
 * the grouping costs nothing.
 *
 * Schemas load in parallel but are committed one at a time, so a database with
 * forty schemas paints as it goes rather than after the slowest one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { fetchSchemaList, loadSchema } from '@/shared/api/schemaApi';
import type { DbObjectType, GridObjectKind } from './access';

/** One object the grid can hold a row for. */
export interface SchemaObject {
  schema: string;
  /** Native casing — this reaches SQL, so it is an identifier, not a match key. */
  name: string;
  kind: GridObjectKind;
}

/** The objects of one schema, and whether that schema is still loading. */
export interface SchemaGroup {
  schema: string;
  objects: SchemaObject[];
  status: 'loading' | 'ready' | 'error';
  error?: string;
}

/**
 * Only the kinds a grid row can stand for.
 *
 * The catalog also returns triggers, sequences, types and roles. A trigger has
 * no grantable privilege of its own (it runs with the table's), and the others
 * are scope-level rather than object-level, so asking for them here would draw
 * rows with every cell disabled.
 */
const KIND_OF: Partial<Record<DbObjectType, GridObjectKind>> = {
  TABLE: 'table',
  MQT: 'table',
  VIEW: 'view',
  PROCEDURE: 'procedure',
  FUNCTION: 'function',
};

const WANTED_SCOPE: DbObjectType[] = ['TABLE', 'MQT', 'VIEW', 'PROCEDURE', 'FUNCTION'];

/** Strip a schema qualifier the provider may have baked into the name. */
function bareName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
}

/**
 * The grid rows one schema's catalog answer is worth, in display order.
 *
 * Pure, and exported, because this is where the decisions are: which object
 * types become rows at all, and what an object is called once the provider's
 * qualification is stripped. The hook around it only sequences requests.
 */
export function toSchemaObjects(
  schema: string,
  tables: readonly { name: string; objectType: DbObjectType }[]
): SchemaObject[] {
  return tables
    .flatMap((t): SchemaObject[] => {
      const kind = KIND_OF[t.objectType];
      const name = bareName(t.name).trim();
      return kind && name ? [{ schema, name, kind }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AllSchemaObjects {
  groups: SchemaGroup[];
  /** Flat view, for callers that do not care which schema an object came from. */
  objects: SchemaObject[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Load every schema's grantable objects for one connection.
 *
 * Returns groups in schema order, each carrying its own status so a schema the
 * reader lacks rights on reports that against its own name instead of failing
 * the whole catalog.
 */
export function useAllSchemaObjects(
  connectionId: string,
  enabled: boolean
): AllSchemaObjects {
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const password = connectionId ? sessionPasswords[connectionId] : undefined;

  const [groups, setGroups] = useState<SchemaGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /**
   * Which load is the current one.
   *
   * A catalog read takes as long as the engine takes, and Oracle's is slow.
   * Switch connections while one is in flight and its response lands
   * afterwards, offering one database's objects under another's name — and
   * every tick in this grid becomes a GRANT naming those objects.
   */
  const token = useRef(0);

  const run = useCallback(async () => {
    if (!connectionId || !enabled) {
      setGroups([]);
      setError(null);
      return;
    }
    const mine = ++token.current;
    const superseded = () => token.current !== mine;

    setLoading(true);
    setError(null);
    setGroups([]);
    try {
      const names = await fetchSchemaList({ connectionId, password });
      if (superseded()) return;

      // Engines with no schema concept answer with nothing; the connection's
      // own database is still one group's worth of objects.
      const schemas = names.length ? [...names].sort((a, b) => a.localeCompare(b)) : [''];
      setGroups(schemas.map((schema) => ({ schema, objects: [], status: 'loading' as const })));

      await Promise.all(
        schemas.map(async (schema) => {
          try {
            const res = await loadSchema(
              { connectionId, password, ...(schema ? { schema } : {}) },
              WANTED_SCOPE
            );
            if (superseded()) return;
            const objects = toSchemaObjects(schema, res.tables ?? []);
            // Commit per schema so the grid paints as results arrive rather
            // than after the slowest schema in the database.
            setGroups((prev) =>
              prev.map((g) => (g.schema === schema ? { ...g, objects, status: 'ready' } : g))
            );
          } catch (err) {
            if (superseded()) return;
            const message = err instanceof Error ? err.message : String(err);
            setGroups((prev) =>
              prev.map((g) =>
                g.schema === schema ? { ...g, status: 'error', error: message } : g
              )
            );
          }
        })
      );
    } catch (err) {
      if (superseded()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!superseded()) setLoading(false);
    }
  }, [connectionId, enabled, password]);

  useEffect(() => {
    void run();
  }, [run, nonce]);

  const objects = useMemo(() => groups.flatMap((g) => g.objects), [groups]);

  return {
    groups,
    objects,
    loading,
    error,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}
