import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { buildBrowseResult } from '@/shared/lib/browse';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { schemaCompareBlocker } from '@/shared/lib/dialect-features';
import {
  testConnection as apiTestConnection,
  fetchSchemaList,
  compareSchemas,
  loadSchema,
  executeMigration,
  invalidateCache,
} from '@/shared/api/schemaApi';
import {
  apiListConnections,
  apiCreateConnection,
  apiUpdateConnection,
  apiDeleteConnection,
} from '@/shared/api/authApi';
import type { CommittedMigrationRef, ConnectionConfig, SyncState } from './sync-types';
import type { MigrationStep } from '@foxschema/ui-shared';
import { buildRef, buildMapping, regenerateSql, buildIncludedDiffs, loadSqlGenerator, sqlGenerator } from './sync-helpers';
import { toast } from './toastStore';
import { useUiStore } from './uiStore';
import {
  clearSessionPassword,
  getSessionPassword,
  sessionPasswordMap,
  setSessionPassword,
} from '@/shared/lib/sessionPasswords';

/** Keep SQL Editor's Zustand mirror in sync with the shared session map. */
function mirrorSessionPasswordsToSqlEditor(): void {
  void import('./useSqlEditorStore').then(({ useSqlEditorStore }) => {
    useSqlEditorStore.setState({ sessionPasswords: sessionPasswordMap() });
  });
}

export type { MigrationProgressItem } from './sync-types';

/**
 * The migration plan for the current comparison and selections, built once per
 * change to them. Execute, the commit check and the review notes all ask for it,
 * and the commit check asks on every render: it used to rebuild and serialise
 * the whole plan each time (6 ms at 800 changed objects, so every keystroke in
 * the search box). Keyed on the identity of each input; the store replaces
 * them on every change and never edits one in place.
 */
let planCache: { inputs: readonly unknown[]; plan: MigrationStep[]; key?: string } | null = null;

function cachedPlan(s: SyncState): { plan: MigrationStep[]; key?: string } {
  const inputs = [
    s.compareResult,
    s.syncSelection,
    s.memberSelection,
    s.indexSelection,
    s.columnSelection,
    s.triggerSelection,
    s.sourceConfig,
    s.targetConfig,
    s.nonDestructive,
    s.targetServerVersion,
  ] as const;
  if (planCache && inputs.every((value, i) => value === planCache!.inputs[i])) return planCache;
  planCache = { inputs, plan: buildPlan(s) };
  return planCache;
}

function buildPlan(s: SyncState): MigrationStep[] {
  const { compareResult, targetConfig } = s;
  if (!compareResult) return [];
  // The same diffs the preview was built from. This used to filter the raw
  // tables by object selection alone, so Execute ignored every finer opt-in
  // and opt-out — role members and index opt-ins already, and now columns and
  // triggers. A preview that does not match what runs is the one thing a
  // migration tool must never do.
  const includedDiffs = buildIncludedDiffs(compareResult.tables, {
    selection: s.syncSelection,
    memberSelection: s.memberSelection,
    indexSelection: s.indexSelection,
    columnSelection: s.columnSelection,
    triggerSelection: s.triggerSelection,
  });
  return sqlGenerator().generateMigrationPlan(
    includedDiffs,
    targetConfig.dialect,
    buildMapping(s),
    compareResult.tables
  );
}

/** The plan as text, for telling whether it is still the one committed to Git. */
function planKeyOf(s: SyncState): string {
  const entry = cachedPlan(s);
  return (entry.key ??= JSON.stringify(entry.plan));
}

export const useSyncStore = create<SyncState>()(
  persist(
    (set, get) => {
    /**
     * Run `plan` against the target and report progress into the store.
     * With `git`, the server runs that committed file instead of `plan`
     * (which then only seeds the progress list). True when it succeeded.
     */
    const runPlan = async (
      plan: MigrationStep[],
      git?: CommittedMigrationRef
    ): Promise<boolean> => {
      const { targetConfig, continueOnError } = get();
      set({
        isMigrating: true,
        migrationError: null,
        migrationRolledBack: false,
        snapshotDdl: null,
        migrationProgress: plan.map((s) => ({
          objectName: s.objectName,
          objectType: s.objectType,
          action: s.action,
          status: 'PENDING' as const,
        })),
      });

      let migrationSucceeded = false;
      try {
        await executeMigration(
          buildRef(targetConfig),
          plan,
          (event) => {
            if (event.type === 'snapshot') {
              set({ snapshotDdl: event.ddl });
            } else if (event.type === 'lokee') {
              useUiStore.getState().bumpLokeeEpoch();
              if (event.error) {
                toast({
                  tone: 'warning',
                  title: 'History snapshot failed',
                  body: String(event.error),
                });
              } else if (event.phase === 'after' && event.changed) {
                toast({
                  tone: 'success',
                  title: `History v${event.versionNumber}`,
                  body: `Migration snapshot · ${event.changeCount} object change(s)`,
                });
              }
            } else if (event.type === 'object') {
              set({
                migrationProgress: get().migrationProgress.map((item) =>
                  item.objectName === event.objectName && item.action === event.action
                    ? { ...item, status: event.status, error: event.error }
                    : item
                ),
              });
            } else if (event.type === 'done') {
              migrationSucceeded = event.success && !event.rolledBack;
              set({
                migrationExecuted: event.success,
                migrationError: event.error ?? null,
                migrationRolledBack: event.rolledBack,
              });
            }
          },
          continueOnError,
          git
        );
      } catch (e: any) {
        set({ migrationError: e.message || 'Migration failed' });
      } finally {
        set({ isMigrating: false });
      }
      return migrationSucceeded;
    };

    return {
  // --- Initial States ---
  sourceConfig: {
    dialect: 'postgres',
    option: {
      connectionString: '',
    },
    schema: 'public',
  },
  targetConfig: {
    dialect: 'postgres',
    option: {
      connectionString: '',
    },
    schema: 'public',
  },
  
  connections: [],
  connectionsLoaded: false,
  selectedSourceConnectionId: null,
  selectedTargetConnectionId: null,
  showConnectionModal: false,

  isTestingSource: false,
  isTestingTarget: false,
  sourceConnected: false,
  targetConnected: false,
  sourceServerVersion: undefined,
  targetServerVersion: undefined,
  errorMsg: null,
  warnings: [],
  sourceSchemaList: [],
  targetSchemaList: [],

  selectedObjectTypes: ['TABLE', 'MQT', 'VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'SEQUENCE', 'TYPE', 'ROLE'],
  isComparing: false,
  compareResult: null,
  browseMode: false,
  browseSide: null,
  isBrowsing: false,
  selectedTable: null,
  generatedSql: null,
  migrationExecuted: false,
  nonDestructive: false,
  continueOnError: false,
  filterStatus: 'ALL',
  searchTerm: '',
  typeFilter: [],
  memberSelection: {},
  indexSelection: {},
  columnSelection: {},
  triggerSelection: {},
  syncSelection: {},

  isMigrating: false,
  migrationProgress: [],
  snapshotDdl: null,
  migrationError: null,
  migrationRolledBack: false,
  committedMigration: null,

  // --- Actions ---
  loadConnections: async () => {
    try {
      const list = await apiListConnections();
      // Re-read AFTER the await — a concurrent applySavedConnection during the
      // request must not be wiped by a stale pre-await snapshot.
      const live = get();
      const { selectedSourceConnectionId, selectedTargetConnectionId } = live;
      const patch: Partial<SyncState> = { connections: list, connectionsLoaded: true };
      const retest: Array<'source' | 'target'> = [];

      // Restore persisted source/target picks. Keep in-memory session passwords
      // when the same connection id is still selected — otherwise saving the
      // *other* side (addConnection → loadConnections) would drop the password
      // and leave Compare disabled ("Retry Connection").
      const restore = (side: 'source' | 'target', id: string | null) => {
        if (!id) return;
        const conn = list.find((c) => c.id === id);
        if (!conn) {
          if (side === 'source') patch.selectedSourceConnectionId = null;
          else patch.selectedTargetConnectionId = null;
          return;
        }
        const liveCfg = side === 'source' ? live.sourceConfig : live.targetConfig;
        const fromConfig =
          liveCfg.connectionId === id && liveCfg.option?.password
            ? liveCfg.option.password
            : undefined;
        const sessionPassword = fromConfig || getSessionPassword(id);
        if (sessionPassword) setSessionPassword(id, sessionPassword);
        const config: ConnectionConfig = {
          dialect: conn.dialect as ConnectionConfig['dialect'],
          option: {
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            schema: conn.schema,
            ...(sessionPassword ? { password: sessionPassword } : {}),
          },
          schema: conn.schema ?? '',
          connectionId: id,
        };
        const wasConnected = side === 'source' ? live.sourceConnected : live.targetConnected;
        // A file database has no password to store, so `hasPassword` is false
        // forever. Requiring one here silently dropped SQLite/DuckDB from
        // connected to disconnected on every credential reload — saving any
        // other connection knocked the source offline with no way back but
        // reconnecting by hand.
        const canRetest = !!(
          conn.hasPassword ||
          sessionPassword ||
          !connectionNeedsSecret(conn.dialect, conn.authMethod)
        );
        if (side === 'source') {
          patch.selectedSourceConnectionId = id;
          patch.sourceConfig = config;
          patch.sourceConnected = false;
        } else {
          patch.selectedTargetConnectionId = id;
          patch.targetConfig = config;
          patch.targetConnected = false;
        }
        if (wasConnected && canRetest) retest.push(side);
      };
      restore('source', selectedSourceConnectionId);
      restore('target', selectedTargetConnectionId);
      set(patch);
      mirrorSessionPasswordsToSqlEditor();
      for (const side of retest) {
        void (side === 'source' ? get().testSourceConnection() : get().testTargetConnection());
      }
    } catch (e) {
      console.error('Failed to load saved connections:', e);
      set({ connectionsLoaded: true });
    }
  },

  addConnection: async (input) => {
    // Credentials are encrypted server-side; only metadata returns to the client
    const created = await apiCreateConnection(input);
    await get().loadConnections();
    return created;
  },

  updateConnection: async (id, input) => {
    const updated = await apiUpdateConnection(id, input);
    await get().loadConnections();
    return updated;
  },

  removeConnection: async (id) => {
    await apiDeleteConnection(id);
    clearSessionPassword(id);
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      selectedSourceConnectionId: state.selectedSourceConnectionId === id ? null : state.selectedSourceConnectionId,
      selectedTargetConnectionId: state.selectedTargetConnectionId === id ? null : state.selectedTargetConnectionId,
    }));
    // Drop SQL Editor schema cache + session password mirror for the removed credential.
    const { useSqlEditorStore } = await import('./useSqlEditorStore');
    const cache = useSqlEditorStore.getState().schemaCache;
    const nextCache = cache[id]
      ? (() => {
          const { [id]: _removed, ...rest } = cache;
          return rest;
        })()
      : cache;
    useSqlEditorStore.setState({
      schemaCache: nextCache,
      sessionPasswords: sessionPasswordMap(),
    });
  },

  setShowConnectionModal: (showConnectionModal) => set({ showConnectionModal }),
  setSelectedSourceConnection: (id) => set({ selectedSourceConnectionId: id }),
  setSelectedTargetConnection: (id) => set({ selectedTargetConnectionId: id }),

  applySavedConnection: (side, id, sessionPassword) => {
    const conn = get().connections.find((c) => c.id === id);
    if (!conn) return;
    // Use the saved connection by id — no password is held in the browser, EXCEPT an
    // optional session password (for connections stored without one) kept in-memory only.
    // Prefer the explicit argument, then the shared session map (SQL Editor / prior Sync).
    const password = sessionPassword || getSessionPassword(id);
    if (password) {
      setSessionPassword(id, password);
      mirrorSessionPasswordsToSqlEditor();
    }
    const config: ConnectionConfig = {
      dialect: conn.dialect as ConnectionConfig['dialect'],
      option: {
        host: conn.host,
        port: conn.port,
        database: conn.database,
        username: conn.username,
        schema: conn.schema,
        ...(password ? { password } : {}),
      },
      schema: conn.schema ?? '',
      connectionId: id,
    };
    if (side === 'source') {
      set({ selectedSourceConnectionId: id, sourceConfig: config, sourceConnected: false });
    } else {
      set({ selectedTargetConnectionId: id, targetConfig: config, targetConnected: false });
    }
    // Verify the saved connection right away
    void (side === 'source' ? get().testSourceConnection() : get().testTargetConnection());
  },

  setSourceConfig: (cfg) => {
    set((state) => ({ sourceConfig: { ...state.sourceConfig, ...cfg }, sourceConnected: false }));
  },
  setTargetConfig: (cfg) => {
    set((state) => ({ targetConfig: { ...state.targetConfig, ...cfg }, targetConnected: false }));
  },

  // Flip migration direction: what was the source becomes the target and vice versa
  swapSourceTarget: () => {
    const s = get();
    set({
      sourceConfig: s.targetConfig,
      targetConfig: s.sourceConfig,
      sourceConnected: s.targetConnected,
      targetConnected: s.sourceConnected,
      sourceSchemaList: s.targetSchemaList,
      targetSchemaList: s.sourceSchemaList,
      selectedSourceConnectionId: s.selectedTargetConnectionId,
      selectedTargetConnectionId: s.selectedSourceConnectionId,
      compareResult: null,
      selectedTable: null,
      generatedSql: null,
      syncSelection: {},
      migrationExecuted: false,
      browseMode: false,
      browseSide: null,
    });
  },

  toggleObjectTypeFilter: (type) =>
    set((state) => {
      const active = state.selectedObjectTypes;
      const next = active.includes(type)
        ? active.filter((t) => t !== type)
        : [...active, type];
      return { selectedObjectTypes: next };
    }),
    
  setNonDestructive: (nonDestructive) => {
    set({ nonDestructive });
    // Regenerate the script from the current selection so the preview reflects the mode.
    const s = get();
    if (!s.compareResult) return;
    set({
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  // Execution-mode only — doesn't change the generated SQL, so no regeneration needed.
  setContinueOnError: (continueOnError) => set({ continueOnError }),

  setFilterStatus: (filterStatus) => set({ filterStatus }),
  setSearchTerm: (searchTerm) => set({ searchTerm }),
  toggleTypeFilter: (type) =>
    set((state) => {
      const active = state.typeFilter;
      const next = active.includes(type) ? active.filter((t) => t !== type) : [...active, type];
      return { typeFilter: next };
    }),
  clearTypeFilter: () => set({ typeFilter: [] }),
  setSelectedTable: (selectedTable) => set({ selectedTable }),

  toggleSyncSelection: (tableName) => {
    const s = get();
    if (!s.compareResult) return;
    const nextSelection = { ...s.syncSelection, [tableName]: !s.syncSelection[tableName] };
    set({
      syncSelection: nextSelection,
      generatedSql: regenerateSql(s, {
        selection: nextSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  setAllSyncSelection: (selected) => {
    const s = get();
    if (!s.compareResult) return;
    const nextSelection: Record<string, boolean> = {};
    for (const t of s.compareResult.tables) {
      if (t.status !== 'UNCHANGED') nextSelection[t.tableName] = selected;
    }
    set({
      syncSelection: nextSelection,
      generatedSql: regenerateSql(s, {
        selection: nextSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  toggleMemberSelection: (roleName, memberName) => {
    const s = get();
    if (!s.compareResult) return;
    const roleSel = { ...(s.memberSelection[roleName] ?? {}) };
    // Default included; toggle to false (excluded) and back.
    roleSel[memberName] = roleSel[memberName] === false ? true : false;
    const nextMember = { ...s.memberSelection, [roleName]: roleSel };
    set({
      memberSelection: nextMember,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: nextMember,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  setAllMemberSelection: (roleName, selected) => {
    const s = get();
    if (!s.compareResult) return;
    const role = s.compareResult.tables.find((t) => t.tableName === roleName && t.objectType === 'ROLE');
    if (!role) return;
    const roleSel: Record<string, boolean> = {};
    for (const m of role.columnDiffs) {
      if (m.status !== 'UNCHANGED') roleSel[m.name] = selected;
    }
    const nextMember = { ...s.memberSelection, [roleName]: roleSel };
    set({
      memberSelection: nextMember,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: nextMember,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  toggleColumnSelection: (tableName, columnName) => {
    const s = get();
    if (!s.compareResult) return;
    const tableSel = { ...(s.columnSelection[tableName] ?? {}) };
    // Default included; toggle to false (excluded) and back — same polarity as
    // role members, so a fresh compare migrates everything as it always did.
    tableSel[columnName] = tableSel[columnName] === false ? true : false;
    const nextColumn = { ...s.columnSelection, [tableName]: tableSel };
    set({
      columnSelection: nextColumn,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: nextColumn,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  setAllColumnSelection: (tableName, selected) => {
    const s = get();
    if (!s.compareResult) return;
    const table = s.compareResult.tables.find((t) => t.tableName === tableName);
    if (!table) return;
    const tableSel: Record<string, boolean> = {};
    for (const c of table.columnDiffs) {
      if (c.status !== 'UNCHANGED') tableSel[c.name] = selected;
    }
    const nextColumn = { ...s.columnSelection, [tableName]: tableSel };
    set({
      columnSelection: nextColumn,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: nextColumn,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  toggleTriggerSelection: (tableName, triggerName) => {
    const s = get();
    if (!s.compareResult) return;
    const tableSel = { ...(s.triggerSelection[tableName] ?? {}) };
    tableSel[triggerName] = tableSel[triggerName] === false ? true : false;
    const nextTrigger = { ...s.triggerSelection, [tableName]: tableSel };
    set({
      triggerSelection: nextTrigger,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: nextTrigger,
      }),
      migrationExecuted: false,
    });
  },

  setAllTriggerSelection: (tableName, selected) => {
    const s = get();
    if (!s.compareResult) return;
    const table = s.compareResult.tables.find((t) => t.tableName === tableName);
    if (!table) return;
    const tableSel: Record<string, boolean> = {};
    for (const t of table.triggerDiffs ?? []) {
      if (t.status !== 'UNCHANGED') tableSel[t.name] = selected;
    }
    const nextTrigger = { ...s.triggerSelection, [tableName]: tableSel };
    set({
      triggerSelection: nextTrigger,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: nextTrigger,
      }),
      migrationExecuted: false,
    });
  },

  toggleIndexSelection: (tableName, indexName) => {
    const s = get();
    if (!s.compareResult) return;
    const tableSel = { ...(s.indexSelection[tableName] ?? {}) };
    // Default excluded; toggle to true (included) and back.
    tableSel[indexName] = tableSel[indexName] === true ? false : true;
    const nextIndex = { ...s.indexSelection, [tableName]: tableSel };
    set({
      indexSelection: nextIndex,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: nextIndex,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  setAllIndexSelection: (tableName, selected) => {
    const s = get();
    if (!s.compareResult) return;
    const table = s.compareResult.tables.find((t) => t.tableName === tableName);
    if (!table) return;
    const tableSel: Record<string, boolean> = {};
    for (const i of table.indexDiffs) {
      if (i.status !== 'UNCHANGED') tableSel[i.name] = selected;
    }
    const nextIndex = { ...s.indexSelection, [tableName]: tableSel };
    set({
      indexSelection: nextIndex,
      generatedSql: regenerateSql(s, {
        selection: s.syncSelection,
        memberSelection: s.memberSelection,
        indexSelection: nextIndex,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationExecuted: false,
    });
  },

  loadSchemaList: async (side) => {
    const cfg = side === 'source' ? get().sourceConfig : get().targetConfig;
    try {
      const schemas = await fetchSchemaList(buildRef(cfg));
      // Keep the configured schema if the server has it (case-insensitive), else fall back to the first
      const current = cfg.schema || '';
      const match =
        schemas.find((s) => s === current) ??
        schemas.find((s) => s.toLowerCase() === current.toLowerCase()) ??
        schemas[0] ??
        current;
      if (side === 'source') {
        set({ sourceSchemaList: schemas, sourceConfig: { ...get().sourceConfig, schema: match } });
      } else {
        set({ targetSchemaList: schemas, targetConfig: { ...get().targetConfig, schema: match } });
      }
    } catch (e) {
      console.error(`Failed to load schema list for ${side}:`, e);
    }
  },

  setSchema: (side, schema) => {
    // Schema switch keeps the connection valid — only the comparison scope changes
    if (side === 'source') {
      set({ sourceConfig: { ...get().sourceConfig, schema }, compareResult: null, selectedTable: null, generatedSql: null, syncSelection: {}, browseMode: false, browseSide: null });
    } else {
      set({ targetConfig: { ...get().targetConfig, schema }, compareResult: null, selectedTable: null, generatedSql: null, syncSelection: {}, browseMode: false, browseSide: null });
    }
  },

  testSourceConnection: async () => {
    set({ isTestingSource: true, errorMsg: null });
    try {
      invalidateCache('schemas:');
      const { version } = await apiTestConnection(buildRef(get().sourceConfig));
      set({ sourceConnected: true, isTestingSource: false, sourceServerVersion: version });
      await get().loadSchemaList('source');
    } catch (e: any) {
      set({ errorMsg: e.message || 'Source connection failed', isTestingSource: false, sourceConnected: false, sourceServerVersion: undefined });
    }
  },

  testTargetConnection: async () => {
    set({ isTestingTarget: true, errorMsg: null });
    try {
      invalidateCache('schemas:');
      const { version } = await apiTestConnection(buildRef(get().targetConfig));
      set({ targetConnected: true, isTestingTarget: false, targetServerVersion: version });
      await get().loadSchemaList('target');
    } catch (e: any) {
      set({ errorMsg: e.message || 'Target connection failed', isTestingTarget: false, targetConnected: false, targetServerVersion: undefined });
    }
  },

  browseSchema: async (side) => {
    const cfg = side === 'source' ? get().sourceConfig : get().targetConfig;
    set({ isBrowsing: true, errorMsg: null, warnings: [], compareResult: null, selectedTable: null, generatedSql: null, migrationExecuted: false });
    try {
      // Refresh the schema list so we browse against current server state
      await get().loadSchemaList(side);
      const ref = buildRef(side === 'source' ? get().sourceConfig : get().targetConfig);
      // Selecting objects in Browse regenerates SQL, so the generator comes too.
      const [{ tables, warnings }] = await Promise.all([
        loadSchema(ref, get().selectedObjectTypes),
        loadSqlGenerator(),
      ]);
      const result = buildBrowseResult(tables, side);
      set({
        compareResult: result,
        warnings: warnings ?? [],
        browseMode: true,
        browseSide: side,
        syncSelection: {},
        selectedTable: result.tables[0] || null,
        isBrowsing: false,
      });
      // Browse is a pane, so reading a schema takes you there. Before this the
      // result landed in the Compare workspace, which then showed a comparison
      // layout holding one database and no comparison.
      useUiStore.getState().setSyncPane('browse');
    } catch (e: any) {
      set({ errorMsg: e.message || `Failed to load ${side} schema`, isBrowsing: false });
    }
  },

  runSchemaComparison: async () => {
    // The last line, not the only one. The button is disabled for an engine
    // that cannot be compared, but a selection can outlive the check that
    // produced it and this is the call that reaches the generator — where
    // `resolveDialect` answers Db2 for a name it does not know, so an
    // unguarded run emits Db2 DDL for an engine nobody is using. Same helper
    // as the button, so the two cannot give different answers.
    const blocked = schemaCompareBlocker(get().sourceConfig.dialect, get().targetConfig.dialect);
    if (blocked) {
      set({ errorMsg: blocked });
      return;
    }
    // The mirror of browseSchema: comparing leaves Browse behind, so the pane
    // and the state it renders can never disagree.
    useUiStore.getState().setSyncPane('compare');
    set({ isComparing: true, errorMsg: null, warnings: [], compareResult: null, selectedTable: null, generatedSql: null, migrationExecuted: false, browseMode: false, browseSide: null });
    try {
      // Re-read the available schemas so the comparison runs against current server state
      await Promise.all([
        get().sourceConnected ? get().loadSchemaList('source') : Promise.resolve(),
        get().targetConnected ? get().loadSchemaList('target') : Promise.resolve(),
      ]);

      // Read configs after the refresh — it may have re-resolved the selected schema
      const { sourceConfig, targetConfig, selectedObjectTypes } = get();

      // Load + diff both schemas on the server; only the result comes back. The
      // generator loads alongside, before any path that needs it can run.
      const [diffResult] = await Promise.all([
        compareSchemas(buildRef(sourceConfig), buildRef(targetConfig), selectedObjectTypes),
        loadSqlGenerator(),
      ]);

      // Nothing is auto-selected — the user opts objects into the deployment
      const sql = sqlGenerator().generateMigrationSql([], targetConfig.dialect, buildMapping(get()));

      set({
        compareResult: diffResult,
        warnings: diffResult.warnings ?? [],
        syncSelection: {},
        generatedSql: sql,
        selectedTable: diffResult.tables[0] || null,
        isComparing: false,
      });
    } catch (e: any) {
      set({ errorMsg: e.message || 'Schema comparison encountered an error', isComparing: false });
    }
  },

  dismissWarnings: () => set({ warnings: [] }),

  clearMigrationProgress: () =>
    set({ migrationProgress: [], snapshotDdl: null, migrationError: null, migrationRolledBack: false }),

  skipObjectAndRetry: async (objectName) => {
    const s = get();
    // Deselect the failed object so the regenerated plan excludes it, then re-run.
    const nextSelection = { ...s.syncSelection, [objectName]: false };
    set({
      syncSelection: nextSelection,
      generatedSql: regenerateSql(s, {
        selection: nextSelection,
        memberSelection: s.memberSelection,
        indexSelection: s.indexSelection,
        columnSelection: s.columnSelection,
        triggerSelection: s.triggerSelection,
      }),
      migrationProgress: [],
      migrationError: null,
      migrationRolledBack: false,
      snapshotDdl: null,
      migrationExecuted: false,
    });
    // A committed plan without this object is a different migration: it runs
    // from Git only once that plan is reviewed and committed too.
    const committed = s.committedMigration;
    if (committed) {
      toast({
        tone: 'warning',
        title: `Skipped ${objectName}`,
        body: `The plan no longer matches commit ${committed.commit.slice(0, 7)}. Commit it again, then Execute.`,
      });
      return;
    }
    await get().applyMigration();
  },

  currentMigrationPlan: () => cachedPlan(get()).plan,

  setCommittedMigration: (ref) =>
    set({ committedMigration: ref ? { ...ref, planKey: planKeyOf(get()) } : null }),

  commitMatchesPlan: () => {
    const c = get().committedMigration;
    return !!c && c.planKey === planKeyOf(get());
  },

  applyMigration: async () => {
    const plan = get().currentMigrationPlan();
    if (plan.length === 0) return;
    // Committed and unchanged since: run it from its commit, so what reaches
    // the database is exactly what was reviewed (the server reads the file).
    const c = get().committedMigration;
    const git = c && get().commitMatchesPlan() ? { repoId: c.repoId, branch: c.branch, commit: c.commit, path: c.path } : undefined;
    const ok = await runPlan(plan, git);
    // The committed plan has run; running a teammate's migration from the Git
    // view (runCommittedMigration) leaves it alone.
    if (ok) set({ committedMigration: null });
    // Auto-refresh the comparison so the diff list reflects what was just applied.
    // migrationProgress and migration result state are preserved across the refresh.
    if (ok) await get().runSchemaComparison();
  },

  runCommittedMigration: async (ref, steps) => {
    const ok = await runPlan(steps, ref);
    if (ok && get().compareResult) await get().runSchemaComparison();
    return ok;
  },

  resetSync: () => {
    set({
      compareResult: null,
      selectedTable: null,
      generatedSql: null,
      migrationExecuted: false,
      syncSelection: {},
      browseMode: false,
      browseSide: null,
      committedMigration: null,
    });
  },
    };
    },
    {
      name: 'schema-sync-storage',
      version: 5,
      // Persist object-type scope + selected connection IDs only. Never persist
      // configs/passwords — credentials reload from the server on sign-in.
      partialize: (state) => ({
        selectedObjectTypes: state.selectedObjectTypes,
        nonDestructive: state.nonDestructive,
        selectedSourceConnectionId: state.selectedSourceConnectionId,
        selectedTargetConnectionId: state.selectedTargetConnectionId,
      }),
      migrate: (persisted: any, version) => {
        const ensure = (type: string) => {
          if (Array.isArray(persisted?.selectedObjectTypes) && !persisted.selectedObjectTypes.includes(type)) {
            persisted.selectedObjectTypes = [...persisted.selectedObjectTypes, type];
          }
        };
        // v2 added TRIGGER; v3 added SEQUENCE and TYPE; v4 added MQT and ROLE —
        // enable each once for older persisted settings.
        if (version < 2) ensure('TRIGGER');
        if (version < 3) { ensure('SEQUENCE'); ensure('TYPE'); }
        if (version < 4) { ensure('MQT'); ensure('ROLE'); }
        // v5: selected source/target connection ids (no credentials).
        return persisted;
      },
    }
  )
);