import type { ConnectionOptions, Dialect } from '@/shared/lib/provider-settings';
import type { DbObjectType, SchemaCompareResult, TableDiff } from '@/shared/lib/types';
import type { SavedConnectionSummary } from '@/shared/api/authApi';
import type { MigrationStep } from '@foxschema/ui-shared';

/** A committed migration Execute will run: the file at that commit, not the live plan. */
export interface CommittedMigrationRef {
  repoId: string;
  branch?: string;
  commit: string;
  path: string;
}

export interface MigrationProgressItem {
  objectName: string;
  objectType: string;
  action: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  error?: string;
}

export interface ConnectionConfig {
  dialect: Dialect;
  option: ConnectionOptions;
  schema: string;
  /** Set when this side uses a saved server connection — no password held client-side. */
  connectionId?: string;
}

export type FilterStatus = 'ALL' | 'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED';
export type Side = 'source' | 'target';

/**
 * The sync workspace store. Groups, in order: connection management, connection
 * test + schema-list state, the object-scope/compare/browse state, deploy
 * selection + generated SQL, and live migration execution.
 */
export interface SyncState {
  // --- Connections -------------------------------------------------------
  sourceConfig: ConnectionConfig;
  targetConfig: ConnectionConfig;

  connections: SavedConnectionSummary[];
  /** False until the first loadConnections() attempt finishes (refresh race guard). */
  connectionsLoaded: boolean;
  selectedSourceConnectionId: string | null;
  selectedTargetConnectionId: string | null;

  showConnectionModal: boolean;

  loadConnections: () => Promise<void>;
  addConnection: (input: { name?: string; dialect: string; schema?: string; option: ConnectionOptions; savePassword?: boolean }) => Promise<SavedConnectionSummary>;
  updateConnection: (id: string, input: { name?: string; dialect: string; schema?: string; option: ConnectionOptions; savePassword?: boolean }) => Promise<SavedConnectionSummary>;
  removeConnection: (id: string) => Promise<void>;

  setShowConnectionModal: (open: boolean) => void;

  setSelectedSourceConnection: (id: string | null) => void;
  setSelectedTargetConnection: (id: string | null) => void;
  applySavedConnection: (side: Side, id: string, sessionPassword?: string) => void;

  // --- Connection test + schema list ------------------------------------
  isTestingSource: boolean;
  isTestingTarget: boolean;
  sourceConnected: boolean;
  targetConnected: boolean;
  /** Server version string detected at connection time (e.g. "19.3.0" for Oracle 19c). */
  sourceServerVersion: string | undefined;
  targetServerVersion: string | undefined;
  errorMsg: string | null;
  /** Non-fatal notices from the last comparison (e.g. roles skipped — no privilege). */
  warnings: string[];
  dismissWarnings: () => void;

  // Schemas available on each connected database (loaded after a successful test)
  sourceSchemaList: string[];
  targetSchemaList: string[];
  loadSchemaList: (side: Side) => Promise<void>;
  setSchema: (side: Side, schema: string) => void;

  // --- Object scope / compare / browse ----------------------------------
  selectedObjectTypes: DbObjectType[];

  isComparing: boolean;
  compareResult: SchemaCompareResult | null;
  /** Browse mode: compareResult holds one loaded schema (no diff) for search/inspection. */
  browseMode: boolean;
  browseSide: Side | null;
  isBrowsing: boolean;
  browseSchema: (side: Side) => Promise<void>;
  selectedTable: TableDiff | null;
  generatedSql: string | null;
  migrationExecuted: boolean;
  /** Additive mode: generate ADD/MODIFY only — never DROP anything in the target. */
  nonDestructive: boolean;
  setNonDestructive: (v: boolean) => void;
  /**
   * Continue past an object that fails to deploy instead of aborting/rolling back
   * the whole run. On dialects with real transactional DDL (Postgres/DB2/SQL
   * Server/Azure SQL) this uses a per-step SAVEPOINT so the failure doesn't poison
   * the rest of the transaction; on MySQL/MariaDB/Oracle each DDL statement already
   * auto-commits as it runs, so there's nothing extra to do.
   */
  continueOnError: boolean;
  setContinueOnError: (v: boolean) => void;
  filterStatus: FilterStatus;
  searchTerm: string;
  /** Object types the compare-results tree is narrowed to (empty = show every type). Multi-select. */
  typeFilter: DbObjectType[];

  // --- Deploy selection -------------------------------------------------
  // Per-object inclusion in the deployment script (keyed by tableName)
  syncSelection: Record<string, boolean>;
  toggleSyncSelection: (tableName: string) => void;
  setAllSyncSelection: (selected: boolean) => void;
  /** Per-role member opt-out: memberSelection[role][member] === false excludes that member from deploy. */
  memberSelection: Record<string, Record<string, boolean>>;
  toggleMemberSelection: (roleName: string, memberName: string) => void;
  setAllMemberSelection: (roleName: string, selected: boolean) => void;
  /**
   * Per-index opt-IN: indexSelection[table][index] === true includes that index
   * change in the deploy script. Opposite polarity from memberSelection — index
   * changes are excluded by default, so a fresh compare never silently rebuilds
   * indexes the user hasn't reviewed.
   */
  indexSelection: Record<string, Record<string, boolean>>;
  toggleIndexSelection: (tableName: string, indexName: string) => void;
  setAllIndexSelection: (tableName: string, selected: boolean) => void;
  /**
   * Per-column opt-OUT: columnSelection[table][column] === false leaves that
   * column out of the migration. Same polarity as memberSelection — a fresh
   * compare migrates every changed column, exactly as it did before this
   * existed, and unticking is the deliberate act.
   *
   * A column the primary key, an included index or a foreign key names cannot
   * be dropped whatever this says; see column-selection.ts.
   */
  columnSelection: Record<string, Record<string, boolean>>;
  toggleColumnSelection: (tableName: string, columnName: string) => void;
  setAllColumnSelection: (tableName: string, selected: boolean) => void;
  /** Per-trigger opt-OUT. Triggers depend on nothing else in the script. */
  triggerSelection: Record<string, Record<string, boolean>>;
  toggleTriggerSelection: (tableName: string, triggerName: string) => void;
  setAllTriggerSelection: (tableName: string, selected: boolean) => void;

  // --- Live migration execution -----------------------------------------
  isMigrating: boolean;
  migrationProgress: MigrationProgressItem[];
  snapshotDdl: string | null;
  migrationError: string | null;
  migrationRolledBack: boolean;
  /**
   * The current plan, committed to Git. Tied to the plan it was made from
   * (`planKey`): change the selection and the commit no longer describes it,
   * so Execute stops using it.
   */
  committedMigration: (CommittedMigrationRef & { planKey: string }) | null;
  clearMigrationProgress: () => void;
  /** Deselect a failed object and re-run the migration with the remaining selection. */
  skipObjectAndRetry: (objectName: string) => Promise<void>;

  setSourceConfig: (cfg: Partial<ConnectionConfig>) => void;
  setTargetConfig: (cfg: Partial<ConnectionConfig>) => void;
  swapSourceTarget: () => void;
  toggleObjectTypeFilter: (type: DbObjectType) => void;
  setFilterStatus: (status: FilterStatus) => void;
  setSearchTerm: (term: string) => void;
  toggleTypeFilter: (type: DbObjectType) => void;
  clearTypeFilter: () => void;
  setSelectedTable: (table: TableDiff | null) => void;

  testSourceConnection: () => Promise<void>;
  testTargetConnection: () => Promise<void>;
  runSchemaComparison: () => Promise<void>;
  applyMigration: () => Promise<void>;
  /** The plan Execute would run now — the same one the SQL tab previews. */
  currentMigrationPlan: () => MigrationStep[];
  /** Remember that the current plan was committed (or forget it). */
  setCommittedMigration: (ref: CommittedMigrationRef | null) => void;
  /** Whether `committedMigration` still describes the current plan. */
  commitMatchesPlan: () => boolean;
  /** Run a committed migration (for example a teammate's, from the Git view) against the target. */
  runCommittedMigration: (ref: CommittedMigrationRef, steps: MigrationStep[]) => Promise<boolean>;
  resetSync: () => void;
}
