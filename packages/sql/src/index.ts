/**
 * @foxschema/sql — dialect knowledge, pure and runtime-neutral.
 *
 * SQL generation, schema compare, statement splitting, type mapping, and the
 * per-dialect definitions they read. No Node built-ins, no drivers, no I/O, and
 * no runtime dependencies, so this is safe to import from a browser bundle, a
 * worker, or an edge runtime.
 *
 * Executing any of it against a real database is @foxschema/db's job.
 */

export * from './interfaces/schema.interface.js';
export type {
  ConnectionOptions,
  SchemaProvider,
  RoleLoadResult,
  DriverInfo,
  SavedConnection,
  ProviderConnectionSettings,
  DriverAdapter,
  PositionalRows,
} from './interfaces/schema-provider.interface.js';
export * from './interfaces/diff.types.interface.js';
export type { MigrationEvent } from './interfaces/migration.types.js';

export { CompareModule } from './modules/schema-diff/compare.module.js';
export { SqlGeneratorModule } from './modules/migrations/sql-generator.module.js';
export type { MigrationStep, SchemaMapping } from './modules/migrations/sql-generator.module.js';
export { findDropDependencies } from './modules/migrations/dependency-scan.js';
export type { DropDependency, DropDependencyOptions } from './modules/migrations/dependency-scan.js';
export { parseSqlSubset, subsetValue } from './modules/sql-editor/sql-subset.js';
export type {
  SubsetIntent,
  SubsetParse,
  SubsetValue,
  SubsetColumnEq,
} from './modules/sql-editor/sql-subset.js';
export { identityInsertSupport, identityInsertFor } from './modules/dialect/identity-insert.js';
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
export type {
  IdentityInsertKind,
  IdentityInsertSupport,
} from './modules/dialect/identity-insert.js';
export { dialectSupportsFk } from './modules/dialect/fk-support.js';
export type { FkFeatureSupport } from './modules/dialect/fk-support.js';
export { dialectSupportsIndex } from './modules/dialect/index-support.js';
export type { IndexFeatureSupport } from './modules/dialect/index-support.js';
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
  lookupTableSizeGroup,
  lookupIndexSizeRow,
} from './modules/utilities/dba-utilities.js';
export { dbaPrivilegeRemedy } from './modules/utilities/dba-utility-remedy.js';
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
} from './modules/utilities/dba-utilities.js';
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
export { findMissingFkTargets, findNarrowingTypeChanges, extractReviewNotices, validateMigrationPlan } from './modules/migrations/migration-validation.js';
export type { ValidationIssue, ValidationSeverity, ValidationCode } from './modules/migrations/migration-validation.js';
export { CROSS_DIALECT_READINESS } from './modules/dialect/cross-dialect-readiness.js';
export type { ObjectTypeReadiness, ReadinessLevel } from './modules/dialect/cross-dialect-readiness.js';
export { buildBrowseResult } from './modules/schema-diff/browse.js';
export {
  applyColumnSelection,
  applySelectionToDiff,
  applyTriggerSelection,
  blockedColumns,
  columnExclusionBlock,
  supportsColumnSelection,
  type ExclusionBlock,
  type ExclusionContext,
} from './modules/schema-diff/column-selection.js';
export {
  splitSqlStatements,
  checkStatement,
  isWriteStatement,
  requiresWritePermission,
  sqlStatementCategory,
  sqlStatementCategories,
  firstKeyword,
  extractTableAliases,
  countReferencedTables,
  referencedTableNames,
  collectMultiTableWriteWarnings,
  statementVerb,
  isMutatingDmlStatement,
  isInsertWriteStatement,
  isPageableStatement,
  dmlLacksWhere,
  parseCodeCell,
  findCodeFences,
  stripJsStringsAndComments,
  stripCodeFenceMarkers,
  codeCellHasReturn,
  stripFullLineSqlComments,
  isCodeCellKind,
  isNodeCodeCellKind,
  codeCellNeedsTs,
  nodeCodeCellWireKind,
} from './modules/sql-text/sql-splitter.js';
export type {
  SplitStatement,
  StatementStatus,
  StatementKind,
  SqlStatementCategory,
  CodeCellKind,
  BrowserCodeCellKind,
  NodeCodeCellKind,
  TsCodeCellKind,
  CodeFenceRange,
  MultiTableWriteWarning,
} from './modules/sql-text/sql-splitter.js';
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
export type { SqlDialect, CanonicalType, CanonicalBase, RenderedType } from './modules/dialect/sql-dialect.interface.js';
export { resolveDialect, tryResolveDialect, DIALECT_MAP } from './modules/dialect/registry.js';
export {
  dialectFeatures,
  supportsDialectFeature,
  dialectFeatureReason,
  knownDialects,
  DIALECT_FEATURES,
  schemaCompareBlocker,
} from './modules/capabilities/dialect-features.js';
export type {
  DialectFeature,
  DialectFeatureSupport,
  FeatureSupport,
} from './modules/capabilities/dialect-features.js';
export {
  sqlTag,
  renderSqlQuery,
  isSqlQuery,
  makeSqlQuery,
  placeholderStyleFor,
  renderPlaceholder,
  quoteSqlIdentifier,
  quoteIdentifierIfNeeded,
  qualifiedNameParts,
  quoteQualifiedName,
  isTsqlDialect,
} from './modules/sql-text/sql-template.js';
export { maxInsertRows } from './modules/sql-text/insert-limits.js';
export type { SqlQuery, SqlTag, RenderedSql, SqlPlaceholderStyle } from './modules/sql-text/sql-template.js';
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

export { buildConnectionString, withConnectionString, DEFAULT_PORTS } from './cores/connection-string.js';
export {
  normalizeAuthMethod,
  resolveAuthMethod,
  authMethodsForDialect,
  dialectOffersAuthMethods,
  connectionNeedsSecret,
  parseWindowsAccount,
  assertWindowsAccount,
  passwordFieldLabel,
  unsupportedAuthMethodMessage,
  type ConnectionAuthMethod,
  type AuthMethodChoice,
} from './cores/connection-auth.js';
export {
  PROVIDER_SETTINGS,
  getProviderSettings,
  isFileDialect,
  dialectFamily,
  DIALECTS,
  type Dialect,
} from './providers/provider-settings.js';
// Row-shaping helpers. The providers in @foxschema/db call these to turn raw
// catalog rows into TableSchema; before the split they reached in by relative
// path, so only a few were listed here.
export {
  resolveFkReferencedColumns,
  normalizeForeignKeyInfo,
  normalizeTableSchemas,
  dbSchemaToTableSchemas,
  rolesToTableSchemas,
  groupRoleRows,
  roleSkippedWarning,
  groupForeignKeyRows,
} from './cores/schema-to-tables.js';
export type { FkRow } from './cores/schema-to-tables.js';

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
  expandToInstance,
  accessStatementPlace,
  qualifyDatabaseSql,
  gridColumnsFor,
  prunedPermissions,
  type CellSupport,
  type CompileGridOptions,
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

export { nonSecretFingerprint } from './cores/fingerprint.js';
export { errorMessage } from './cores/error-message.js';
export { escapeRegExp } from './cores/escape-regexp.js';
export { odbcEscape, db2CaLooksLikePem } from './providers/db2/db2.connection.js';
export { IBM_DB_VERSION } from './providers/db2/db2.settings.js';
