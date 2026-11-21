/**
 * Fox Schema (@foxschema/features)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Product features built on the @foxschema/sql dialect engine: access and
 * users, DBA utilities, backup, Lokee Weave schema history, SQL editor helpers,
 * command mode and the capability table. Pure like @foxschema/sql — no Node
 * built-ins, no drivers — so the web app can use it too.
 */

// Lokee Weave — content-addressed schema versioning for Compare Schema.
export {
  applyChanges,
  canonicalizeObject,
  canonicalizeSchema,
  diffAgainstIndex,
  hashObject,
  hashObjects,
  rootHash,
  stableStringify,
  weave,
  classifyReversal,
  parseTypeText,
  planReversal,
  collapseObjectHistory,
  windowByTime,
  windowGraph,
  DEFAULT_WINDOW_ITEMS,
  MAX_WINDOW_ITEMS,
  databaseIdentity,
  databaseIdentityText,
  changeKindsByOwner,
  classifyChildChange,
  mergeBody,
  roundTrips,
  shapeKey,
  splitBody,
  CHANGE_KIND_LABEL,
  CHANGE_KIND_ORDER,
  CHANGE_KIND_TITLE,
  assembleBlueprint,
  blueprintChildCounts,
  countSourceLines,
  isLokeeContainerType,
  isLokeeTableLikeType,
  objectKeyKind,
  objectKeyOwner,
  pickOwnerContainer,
  hydrateTableSchemas,
  buildRevertMigration,
  migrationFromCompare,
  lokeeColumnChangeSubtitle,
  lokeeColumnSubtitle,
  lokeeTypeLabel,
  renderLokeeObjectScript,
} from './modules/lokee-weave/index.js';
export type {
  CanonicalObject,
  ChangeOperation,
  Digest,
  LatestIndex,
  LokeeObjectType,
  ObjectChange,
  ReversalPlan,
  ReversalRisk,
  ReversalVerdict,
  HashOptions,
  WeaveCapture,
  WeaveObject,
  GraphNode,
  GraphResult,
  HistoryWindow,
  ObjectHistoryPoint,
  TimePoint,
  WindowResult,
  DatabaseIdentityInput,
  ObjectBlueprint,
  StoredWeaveObject,
  RevertMigration,
  ChildChange,
  ObjectChangeKind,
  SplitBody,
} from './modules/lokee-weave/index.js';
export {
  dialectSupportsIndexFragmentation,
  buildIndexFragmentationQuery,
  buildIndexFragmentationCustomTemplate,
  buildIndexDefragSql,
  indexMaintenanceVerb,
  buildIndexDropSql,
  buildIndexUsageQueries,
  mergeIndexUsageRows,
  normalizeIndexFragmentationRows,
  normalizeIndexLastUsed,
  fragmentationSeverity,
  splitSchemaTable,
  isSafeIndexFragmentationCustomSql,
} from './modules/utilities/index-fragmentation.js';
export type {
  IndexFragmentationSupport,
  IndexFragmentationQuery,
  IndexFragmentationRow,
  IndexFragmentationMode,
  IndexFragmentationSeverity,
  IndexUsageQuery,
} from './modules/utilities/index-fragmentation.js';
export {
  dialectSupportsTableInsight,
  buildTableInsightQuery,
  normalizeTableInsightRows,
  parseSqliteStat1,
  tableInsightDialectIds,
} from './modules/utilities/table-insight.js';
export type {
  TableInsightMode,
  TableInsightSupport,
  TableInsightQuery,
  TableInsightColumn,
  TableInsightResult,
  TableInsightTarget,
} from './modules/utilities/table-insight.js';
export {
  columnReferenceLines,
  planColumnChange,
  lossyConversion,
  DEFAULT_COLUMN_CHANGE_BATCH,
  COLUMN_CHANGE_PHASES,
} from './modules/utilities/column-change.js';
export { resolveColumnChange, columnChangeLargeTable } from './modules/utilities/column-change.registry.js';
export { planTypeDrop, userTypesOf } from './modules/utilities/type-drop.js';
export { resolveTypeDrop, dialectSupportsTypeDrop } from './modules/utilities/type-drop.registry.js';
export type {
  TypeColumnUse,
  TypeDropImpact,
  TypeDropInput,
  TypeDropPlan,
  UserTypeKind,
} from './modules/utilities/type-drop.types.js';
export type {
  ColumnChange,
  ColumnChangeInput,
  ColumnChangeImpact,
  ColumnChangeMode,
  ColumnChangePlan,
  ColumnChangeStep,
  ColumnChangePhase,
  ColumnChangeProgressSql,
  ColumnDependent,
  ColumnReferenceLine,
  InboundForeignKey,
} from './modules/utilities/column-change.types.js';
export {
  parseTopLevelOrderBy,
  findTopLevelOrderByIndex,
  uniqueKeyCoversOrder,
  uniqueKeysFromTable,
  isSafeSeekColumn,
} from './modules/sql-editor/sql-order-by.js';
export type { OrderByTerm, ParsedOrderBy } from './modules/sql-editor/sql-order-by.js';
export {
  dialectSupportsDbaUtility,
  buildDbaUtilityQuery,
  normalizeConnectionPoolRows,
  normalizeUserSessionRows,
  normalizeSystemInfoRows,
  normalizeObjectSizeRows,
  formatBytes,
  formatPct,
  formatRowCount,
  groupObjectSizes,
  filterTableSizeGroups,
  indexTableSizeGroups,
  lookupTableSizeGroup,
  lookupIndexSizeRow,
} from './modules/utilities/dba-utilities.js';
export { dbaPrivilegeRemedy } from './modules/utilities/dba-utility-remedy.js';
export {
  redactSqlText,
  TRACE_MAX_EVENTS,
  TRACE_MAX_MS,
  TRACE_MAX_TEXT_CHARS,
  traceText,
  type TraceEvent,
  type TraceMode,
} from './modules/utilities/sql-trace.js';
export {
  BACKUP_SCOPES,
  backupSupport,
  defaultBackupSettings,
  normalizeBackupSettings,
  backupFileName,
  parseTableList,
  buildBackupCommands,
  backupHistoryQuery,
  normalizeBackupHistory,
} from './modules/utilities/backup.js';
export type {
  BackupHistoryEntry,
} from './modules/utilities/backup.js';
export type {
  BackupCommands,
  BackupConnection,
  BackupDialect,
  BackupFolder,
  BackupFormatOption,
  BackupRequest,
  BackupRunsOn,
  BackupScope,
  BackupSettings,
} from './modules/utilities/backup.js';
export type {
  DbaProbeMode,
  DbaUtilityKind,
  DbaUtilitySupport,
  DbaUtilityQuery,
  ConnectionPoolInfo,
  UserSessionRow,
  SystemInfoMetric,
  ObjectSizeRow,
  TableSizeGroup,
  TableSizeLookup,
} from './modules/utilities/dba-utilities.js';
export {
  dialectSupportsSessionLocks,
  buildLockWaitProbeQuery,
  normalizeLockWaitRows,
  buildBlockingChains,
  buildSessionControlSql,
} from './modules/utilities/session-locks.js';
export type {
  SessionControlAction,
  SessionLocksSupport,
  LockWaitProbeQuery,
  LockWaitRow,
  BlockingChain,
} from './modules/utilities/session-locks.js';
export {
  dialectSupportsTableMaintenance,
  buildTableHealthProbeQuery,
  normalizeTableHealthRows,
  buildTableMaintenanceSql,
} from './modules/utilities/table-maintenance.js';
export type {
  TableMaintenanceAction,
  TableMaintenanceSupport,
  TableHealthProbeQuery,
  TableHealthRow,
} from './modules/utilities/table-maintenance.js';
export {
  dialectSupportsDbAccess,
  buildDbAccessPrincipalQueries,
  buildDbAccessPrivilegeQueries,
  normalizeDbPrincipals,
  principalsFromPrivileges,
  normalizeDbPrivileges,
  privilegesForPrincipal,
  groupDbPrincipals,
  formatDbGrantee,
  buildGrantRevokeSql,
  reconcileDbAccess,
  impliedFixedRolePrivileges,
  principalKey,
  DB_OBJECT_PRIVILEGES,
} from './modules/access/db-access.js';
export {
  isAllPrivilegeSet,
  groupPrivileges,
  privilegeTargetLabel,
  findAllowAll,
  findAllowAllByName,
  describeAllowAll,
  allPrivilegeTargets,
} from './modules/access/privilege-groups.js';
export type {
  PrivilegeGroup,
  AllowAll,
  AllowAllKind,
  AllPrivilegeTarget,
} from './modules/access/privilege-groups.js';
export type {
  DbAccessProbeMode,
  DbAccessSupport,
  DbAccessQuery,
  DbPrincipalKind,
  DbPrincipal,
  DbPrivilegeObjectType,
  DbPrivilege,
  DbAccessGrantArgs,
} from './modules/access/db-access.js';
export {
  parseFoxScript,
  compileFoxScriptPlan,
  foxScriptExecutableTexts,
} from './modules/sql-editor/foxscript-ast.js';
export type {
  FoxScriptBlock,
  FoxScriptCodeBlock,
  FoxScriptSqlBlock,
  FoxScriptDocument,
  FoxScriptDiagnostic,
  FoxScriptExecutionPlan,
  FoxScriptPlanStep,
  FoxScriptRange,
  FoxScriptBlockKind,
} from './modules/sql-editor/foxscript-ast.js';
export type {
  CodeCellLast,
  CodeCellVars,
  CodeCellOk,
  CodeCellErr,
  CodeCellResult,
} from './modules/sql-editor/code-cell-types.js';
export { isCodeCellLast, isCodeCellVars, CODE_CELL_KIND_LABEL } from './modules/sql-editor/code-cell-types.js';
export {
  dialectFeatures,
  supportsDialectFeature,
  dialectFeatureReason,
  knownDialects,
  DIALECT_FEATURES,
} from './modules/capabilities/dialect-features.js';
export { schemaCompareBlocker, schemaCompareSupport } from './modules/capabilities/schema-compare.js';
export type {
  DialectFeature,
  DialectFeatureSupport,
  FeatureSupport,
} from './modules/capabilities/dialect-features.js';
export {
  CODE_CELL_ALLOWED_PACKAGES,
  parseCodeCellImports,
  resolveCodeCellImportBindings,
  prepareCodeCellImports,
  assertCodeCellSandboxSafe,
  neutralizeCodeCellHostBreakouts,
  normalizeCodeCellReturn,
  cloneCodeCellLast,
  runCodeCellBody,
} from './modules/sql-editor/code-cell-exec.js';
export type {
  CodeCellAllowedPackage,
  CodeCellImportSpec,
  RunCodeCellBodyArgs,
} from './modules/sql-editor/code-cell-exec.js';
export { autoAliasSelectColumns, type AliasedSelect } from './modules/sql-editor/select-alias.js';
export {
  canCreateAccountSomehow,
  userCreateModes,
  type UserCreateMode,
  type UserCreateModeOption,
  type UserCreateModes,
} from './modules/access/user-create-mode.js';
export {
  attributeResultColumns,
  collapsedColumnsFor,
  fromClauseEntries,
  rowKeyFor,
  splitSelectItems,
  tablesInOrigins,
  type AttributeOptions,
  type CollapsedColumns,
  type ColumnOrigin,
  type FromEntry,
  type OriginConfidence,
  type RowKeyValue,
} from './modules/sql-editor/column-origin.js';
export {
  ACCESS_PERMISSIONS,
  ACCESS_PRESETS,
  PERMISSION_DESCRIPTORS,
  PERMISSION_RISK,
  accessCapabilities,
  accessFamily,
  availablePermissions,
  describePermission,
  highestRisk,
  permissionsForPreset,
  presetForPermissions,
  supportsAccessBuilder,
  type AccessCapabilities,
  type AccessPermission,
  type AccessPreset,
  type AccessPrincipal,
  type AccessScope,
  type PermissionDescriptor,
  type PermissionRequest,
  type PermissionRisk,
  type AccessDesiredState,
} from './modules/access/intent.js';
export {
  GRID_COLUMNS,
  cellSupport,
  compileObjectGrid,
  compileGridChanges,
  gridObjectKey,
  heldGridPermissions,
  splitHeldPrivileges,
  describeHeldPrivilege,
  expandToInstance,
  accessStatementPlace,
  qualifyDatabaseSql,
  gridColumnsFor,
  prunedPermissions,
  type CellSupport,
  type CompileGridOptions,
  type GridChanges,
  type GridObjectKind,
  type GridRow,
} from './modules/access/object-grid.js';
export {
  PASSWORD_PLACEHOLDER,
  buildUserSql,
  userManagementSupport,
  buildDb2OsUserInstructions,
  generateDb2OsPassword,
  validateDb2OsPassword,
  DB2_OS_PASSWORD_LENGTH,
  DB2_DOCKER_CONTAINER,
  DB2_DOCKER_DATABASE,
  type GeneratedUserSql,
  type PrincipalType,
  DEFAULT_DB2_RUN_MODE,
  type Db2RunMode,
  type UserAction,
  type UserAlteration,
  type UserManagementSupport,
  type UserRequest,
  type UserSqlDialect,
} from './modules/access/user-sql.js';
export { resolveUserSql, USER_SQL_MAP } from './modules/access/user-sql.registry.js';
export {
  buildAccessSql,
  invertAccessRequest,
  type AccessWarningLevel,
  type GeneratedPermissionSql,
  type GeneratedStatement,
  type PermissionWarning,
  type AccessSqlDialect,
  ACCESS_SQL_MAP,
  resolveAccessSql,
} from './modules/access/access-sql.js';
export {
  permissionsForPrivilege,
  resolveEffectiveAccess,
  resolveRoleChain,
  type AccessSource,
  type AccessSourceKind,
  type EffectiveAccess,
  type EffectiveEntry,
  type EffectiveObject,
  buildAccessReport,
  principalsWithAccessTo,
  type AccessFinding,
  type AccessReport,
  type PrincipalAccessRow,
} from './modules/access/effective.js';
export {
  diffAccessDesired,
  buildAccessReconciliationSql,
  type AccessDiffEntry,
  type AccessDiffResult,
  type AccessDiffStatus,
} from './modules/access/access-diff.js';

// Command mode — the shell command that runs a statement through the engine's
// own client, for users who prefer to run it themselves.
export { buildCliCommand, renderCliCommand } from './modules/command-mode/build-command.js';
export { cliFor, supportsCommandMode, CLI_MAP } from './modules/command-mode/cli.registry.js';
export { shellQuote, heredoc } from './modules/command-mode/shell.js';
export { formatCommand } from './modules/command-mode/format.js';
export type { CommandFormat, FormatOptions, FormattedCommand } from './modules/command-mode/format.js';
export type {
  CliTarget,
  CliDialect,
  GeneratedCommand,
} from './modules/command-mode/cli.types.js';

// OS-account steps that pair with a database account, where the engine can
// actually authenticate against the operating system.
export { osAccountSteps } from './modules/access/os-account.registry.js';
export type {
  OsAccountContext,
  OsAccountSteps,
  OsRunMode,
} from './modules/access/os-account.types.js';
