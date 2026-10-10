import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { fetchDbAccess, fetchSchemaList } from '@/shared/api/schemaApi';
import { findCachedTable, tableNameParts } from '@/shared/lib/tablePreview';
import { connectionDatabaseNames, type DbPrincipal } from './access';

type Conn = {
  id: string;
  dialect?: string;
  database?: string;
  schema?: string;
} | null;

function tableBareName(qualified: string): string {
  const parts = tableNameParts(qualified);
  return parts[parts.length - 1] ?? qualified;
}

function tableSchemaName(qualified: string): string | null {
  const parts = tableNameParts(qualified);
  return parts.length > 1 ? parts[0]! : null;
}

/** Principals, schemas, and table/column names for Access Assistant autocomplete. */
export function useAccessCatalog(connectionId: string, conn: Conn) {
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const cacheEntry = useSqlEditorStore((s) =>
    connectionId ? s.schemaCache[connectionId] : undefined
  );

  const [principals, setPrincipals] = useState<DbPrincipal[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [loadingPrincipals, setLoadingPrincipals] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  /**
   * Which catalog read is the current one.
   *
   * A read takes as long as the engine takes, and Oracle's is slow. Pick a
   * different connection while one is in flight and its response arrives
   * afterwards and repaints the list, so the page offers one database's
   * principals under another database's name. Everything downstream of this
   * hook grants and revokes privileges by the name picked here, so a
   * superseded response is discarded rather than shown.
   *
   * Principals and schemas each have their own token: a principals refresh
   * must not discard an in-flight schema list (and vice versa). On MySQL the
   * schema list *is* the database list for "every database" grants — painting
   * the previous connection's names there fans GRANT onto the wrong databases.
   */
  const principalsToken = useRef(0);
  const schemasToken = useRef(0);

  const loadPrincipals = useCallback(async (opts?: { force?: boolean }) => {
    if (!connectionId) return;
    const token = ++principalsToken.current;
    const superseded = () => principalsToken.current !== token;
    setLoadingPrincipals(true);
    setCatalogError(null);
    try {
      const res = await fetchDbAccess(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        { schema: conn?.schema || undefined, force: opts?.force === true }
      );
      if (superseded()) return;
      setPrincipals(res.principals ?? []);
    } catch (e) {
      if (superseded()) return;
      setCatalogError(e instanceof Error ? e.message : String(e));
      setPrincipals([]);
    } finally {
      if (!superseded()) setLoadingPrincipals(false);
    }
  }, [connectionId, conn?.schema, sessionPasswords]);

  const loadSchemas = useCallback(async () => {
    if (!connectionId) return;
    const token = ++schemasToken.current;
    const superseded = () => schemasToken.current !== token;
    setLoadingSchemas(true);
    try {
      const list = await fetchSchemaList({
        connectionId,
        password: sessionPasswords[connectionId] || undefined,
        schema: conn?.schema || undefined,
      });
      if (superseded()) return;
      const merged = new Set<string>();
      if (conn?.database?.trim()) merged.add(conn.database.trim());
      if (conn?.schema?.trim()) merged.add(conn.schema.trim());
      for (const s of list) if (s.trim()) merged.add(s.trim());
      setSchemas([...merged].sort((a, b) => a.localeCompare(b)));
    } catch {
      if (superseded()) return;
      const fallback = [conn?.schema, conn?.database].filter(Boolean) as string[];
      setSchemas([...new Set(fallback)]);
    } finally {
      if (!superseded()) setLoadingSchemas(false);
    }
  }, [connectionId, conn?.database, conn?.schema, sessionPasswords]);

  const loadTables = useCallback(async () => {
    if (!connectionId) return;
    setLoadingTables(true);
    try {
      await ensureSchema(connectionId, { force: false });
    } finally {
      setLoadingTables(false);
    }
  }, [connectionId, ensureSchema]);

  /**
   * Drop the previous connection's catalog the moment the connection changes.
   *
   * Keyed on `connectionId` alone, and deliberately separate from the loading
   * effect below: the loaders are `useCallback`s whose identity changes with
   * their inputs, so clearing inside that effect assigns a fresh `[]` on every
   * render, which re-renders, which runs the effect again — an infinite loop.
   *
   * Schemas must clear too: until the new list lands, leaving the old names
   * under a MySQL connection makes "every database" expand grants across the
   * previous engine's schema names.
   */
  useEffect(() => {
    principalsToken.current++;
    schemasToken.current++;
    setPrincipals([]);
    setSchemas([]);
    setCatalogError(null);
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId) {
      setSchemas([]);
      return;
    }
    void loadPrincipals();
    void loadSchemas();
    void loadTables();
  }, [connectionId, loadPrincipals, loadSchemas, loadTables]);

  const principalOptions = useMemo(
    () =>
      principals.map((p) => ({
        value: p.name,
        hint: p.kind === 'user' ? 'user' : p.kind === 'role' ? 'role' : p.kind,
      })),
    [principals]
  );

  const schemaOptions = useMemo(
    () => schemas.map((s) => ({ value: s })),
    [schemas]
  );

  const databaseOptions = useMemo(
    () =>
      connectionDatabaseNames({
        dialect: conn?.dialect,
        database: conn?.database,
        schemas,
      }).map((v) => ({ value: v })),
    [conn?.dialect, conn?.database, schemas]
  );

  const allTables = useMemo(() => {
    const tables = cacheEntry?.tables ?? [];
    return tables
      .filter((t) => t.objectType === 'TABLE' || t.objectType === 'MQT')
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b));
  }, [cacheEntry?.tables]);

  const tablesInSchema = useCallback(
    (schemaName: string) => {
      const want = schemaName.trim().toLowerCase();
      if (!want) return allTables.map(tableBareName);
      return allTables
        .filter((t) => {
          const ts = tableSchemaName(t);
          if (ts) return ts.toLowerCase() === want;
          return tableBareName(t).toLowerCase().includes(want) || !ts;
        })
        .map(tableBareName);
    },
    [allTables]
  );

  const columnsInTable = useCallback(
    (schemaName: string, tableName: string) => {
      const tables = cacheEntry?.tables ?? [];
      const qualified = schemaName.trim()
        ? `${schemaName.trim()}.${tableName.trim()}`
        : tableName.trim();
      const t =
        findCachedTable(tables, qualified) ??
        findCachedTable(tables, tableName.trim());
      return (t?.columns ?? []).map((c) => c.name).sort((a, b) => a.localeCompare(b));
    },
    [cacheEntry?.tables]
  );

  return {
    principals,
    principalOptions,
    schemas,
    schemaOptions,
    databaseOptions,
    allTables,
    tablesInSchema,
    columnsInTable,
    loadingPrincipals,
    loadingSchemas,
    loadingTables,
    catalogError,
    loadPrincipals,
    loadSchemas,
    loadTables,
    tablesReady: cacheEntry?.status === 'ready',
  };
}
