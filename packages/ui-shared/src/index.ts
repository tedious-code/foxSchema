/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * @foxschema/ui-shared — the part of Fox Schema's dialect engine the web app may use.
 *
 * The browser needs some dialect knowledge: it generates migration DDL for
 * review before anything runs, builds GRANT/REVOKE and backup commands, splits
 * statements at the caret, and hides controls an engine cannot support. All of
 * it lives in `@foxschema/sql`, which the server, the CLI and the driver layer
 * use too.
 *
 * The web app imports it from here, never from `@foxschema/sql` directly
 * (`apps/web/src/frontend/architecture.test.ts`). That keeps the list of what the
 * frontend depends on short enough to read, and makes the browser taking on a
 * new piece of the engine a visible change to this file rather than one more
 * import somewhere in a feature.
 *
 * Every name is the `@foxschema/sql` export itself, re-exported by reference:
 * nothing is copied or wrapped, so the frontend and the server cannot drift
 * apart (`ui-shared.test.ts`). To use something new in the browser, add it to
 * the group it belongs to below. It must stay browser-safe, which
 * `@foxschema/sql` already guarantees for itself (`packages/sql/src/purity.test.ts`).
 */

// The shared vocabulary: schemas, diffs, connections.
export type {
  ColumnDiff, ColumnInfo, ConnectionOptions, DbObjectType, DiffType, DriverInfo, ForeignKeyDiff,
  ForeignKeyInfo, IndexDiff, IndexInfo, MigrationEvent, PrimaryKeyInfo, ProviderConnectionSettings,
  RoutineParameter, RoutineParameterMode, SavedConnection, SchemaCompareResult, SequenceInfo,
  TableDiff, TableSchema, TriggerDiff, TriggerInfo, UserTypeInfo,
} from '@foxschema/sql';

// Engines: connection settings, the registry, and wire-compatible families.
export {
  DIALECTS, IBM_DB_VERSION, PROVIDER_SETTINGS, dialectFamily, getProviderSettings, isFileDialect,
} from '@foxschema/sql';
export type { Dialect } from '@foxschema/sql';

// Connection strings, sign-in methods, error text, and small helpers.
export {
  DEFAULT_PORTS, assertWindowsAccount, authMethodsForDialect, buildConnectionString,
  connectionNeedsSecret, dialectOffersAuthMethods, errorMessage, escapeRegExp, nonSecretFingerprint,
  normalizeAuthMethod, parseWindowsAccount, passwordFieldLabel, resolveAuthMethod,
  withConnectionString,
} from '@foxschema/sql';
export type { ConnectionAuthMethod } from '@foxschema/sql';

// The dialect contract, its registry, and type mapping.
export {
  CROSS_DIALECT_READINESS, DIALECT_MAP, dialectSupportsFk, dialectSupportsIndex, identityInsertFor,
  identityInsertSupport, resolveDialect,
} from '@foxschema/sql';
export type {
  CanonicalBase, CanonicalType, IndexFeatureSupport, ReadinessLevel, SqlDialect,
} from '@foxschema/sql';

// What each engine supports, and why not when it does not.
export {
  dialectFeatureReason, dialectFeatures, schemaCompareBlocker, supportsDialectFeature,
} from '@foxschema/sql';
export type { DialectFeature, FeatureSupport } from '@foxschema/sql';

// SQL text: splitting statements, classifying them, quoting names, code-cell fences.
export {
  checkStatement, codeCellHasReturn, codeCellNeedsTs, collectMultiTableWriteWarnings,
  countReferencedTables, dmlLacksWhere, extractTableAliases, findCodeFences, firstKeyword,
  isCodeCellKind, isInsertWriteStatement, isMutatingDmlStatement, isNodeCodeCellKind,
  isPageableStatement, isSqlQuery, isWriteStatement, makeSqlQuery, nodeCodeCellWireKind,
  parseCodeCell, placeholderStyleFor, qualifiedNameParts, quoteIdentifierIfNeeded,
  quoteSqlIdentifier, referencedTableNames, renderSqlQuery, requiresWritePermission,
  splitSqlStatements, sqlTag, statementVerb, stripCodeFenceMarkers, stripFullLineSqlComments,
  stripJsStringsAndComments,
} from '@foxschema/sql';
export type {
  BrowserCodeCellKind, CodeCellKind, CodeFenceRange, MultiTableWriteWarning, NodeCodeCellKind,
  RenderedSql, SplitStatement, SqlPlaceholderStyle, SqlQuery, SqlTag, StatementKind,
  StatementStatus, TsCodeCellKind,
} from '@foxschema/sql';

// Comparing two schemas, and browsing one.
export {
  applyColumnSelection, applySelectionToDiff, applyTriggerSelection, blockedColumns,
  buildBrowseResult, columnExclusionBlock, supportsColumnSelection,
} from '@foxschema/sql';
export type { ExclusionBlock, ExclusionContext } from '@foxschema/sql';

// Migration DDL: generating it, checking a plan, keeping secrets out of it.
export {
  SqlGeneratorModule, extractReviewNotices, findDropDependencies, findLeftoverSecrets,
  findMissingFkTargets, findNarrowingTypeChanges, scrubSecrets, validateMigrationPlan,
} from '@foxschema/sql';
export type {
  DropDependency, MigrationFileHeader, MigrationStep, SchemaMapping, ValidationCode,
  ValidationIssue, ValidationSeverity,
} from '@foxschema/sql';

// Schema history (Lokee Weave): labels and change kinds.
export {
  CHANGE_KIND_LABEL, CHANGE_KIND_TITLE, isLokeeTableLikeType, lokeeColumnChangeSubtitle,
  lokeeTypeLabel, stableStringify,
} from '@foxschema/sql';
export type {
  LokeeObjectType, ObjectChangeKind, ReversalRisk, StoredWeaveObject,
} from '@foxschema/sql';

// The SQL editor: FoxScript, code cells, SELECT parsing, the SQL subset.
export {
  CODE_CELL_ALLOWED_PACKAGES, CODE_CELL_KIND_LABEL, attributeResultColumns, cloneCodeCellLast,
  collapsedColumnsFor, compileFoxScriptPlan, foxScriptExecutableTexts, isCodeCellLast,
  isCodeCellVars, normalizeCodeCellReturn, parseCodeCellImports, parseFoxScript, parseSqlSubset,
  parseTopLevelOrderBy, prepareCodeCellImports, resolveCodeCellImportBindings, rowKeyFor,
  runCodeCellBody, splitSelectItems, subsetValue, tablesInOrigins, uniqueKeyCoversOrder,
  uniqueKeysFromTable,
} from '@foxschema/sql';
export type {
  CodeCellAllowedPackage, CodeCellErr, CodeCellImportSpec, CodeCellLast, CodeCellOk, CodeCellResult,
  CodeCellVars, FoxScriptBlock, FoxScriptBlockKind, FoxScriptCodeBlock, FoxScriptDiagnostic,
  FoxScriptDocument, FoxScriptExecutionPlan, FoxScriptPlanStep, FoxScriptRange, FoxScriptSqlBlock,
  RunCodeCellBodyArgs,
} from '@foxschema/sql';

// Command mode: a statement wrapped for the engine's own client.
export { buildCliCommand, formatCommand } from '@foxschema/sql';
export type { CliTarget, CommandFormat } from '@foxschema/sql';

// Database access: grants, accounts, effective access.
export {
  ACCESS_PERMISSIONS, ACCESS_PRESETS, DB2_DOCKER_CONTAINER, DB2_OS_PASSWORD_LENGTH,
  DEFAULT_DB2_RUN_MODE, PASSWORD_PLACEHOLDER, PERMISSION_DESCRIPTORS, PERMISSION_RISK,
  accessCapabilities, accessFamily, accessStatementPlace, allPrivilegeTargets, availablePermissions,
  buildAccessReconciliationSql, buildAccessReport, buildAccessSql, buildDb2OsUserInstructions,
  buildGrantRevokeSql, buildUserSql, cellSupport, compileGridChanges, compileObjectGrid,
  describeAllowAll, describeHeldPrivilege, describePermission, dialectSupportsDbAccess,
  diffAccessDesired, expandToInstance, findAllowAll, findAllowAllByName, generateDb2OsPassword,
  gridColumnsFor, gridObjectKey, groupDbPrincipals, groupPrivileges, heldGridPermissions,
  highestRisk, invertAccessRequest, osAccountSteps, permissionsForPreset, permissionsForPrivilege,
  presetForPermissions, principalsWithAccessTo, privilegeTargetLabel, privilegesForPrincipal,
  prunedPermissions, qualifyDatabaseSql, resolveEffectiveAccess, resolveRoleChain,
  splitHeldPrivileges, supportsAccessBuilder, userCreateModes, userManagementSupport,
  validateDb2OsPassword,
} from '@foxschema/sql';
export type {
  AccessCapabilities, AccessDesiredState, AccessDiffEntry, AccessDiffResult, AccessDiffStatus,
  AccessFinding, AccessPermission, AccessPreset, AccessPrincipal, AccessReport, AccessScope,
  AccessSource, AccessSourceKind, AccessWarningLevel, AllowAll, CellSupport, Db2RunMode,
  DbPrincipal, DbPrincipalKind, DbPrivilege, DbPrivilegeObjectType, EffectiveAccess, EffectiveEntry,
  EffectiveObject, GeneratedPermissionSql, GeneratedStatement, GeneratedUserSql, GridChanges,
  GridObjectKind, GridRow, OsAccountSteps, PermissionDescriptor, PermissionRequest, PermissionRisk,
  PermissionWarning, PrincipalAccessRow, PrincipalType, PrivilegeGroup, UserAction, UserAlteration,
  UserCreateMode, UserManagementSupport, UserRequest,
} from '@foxschema/sql';

// DBA utilities: index maintenance, sizes, backup and restore commands.
export {
  backupFileName, backupHistoryQuery, backupSupport, buildBackupCommands, buildIndexDefragSql,
  buildIndexDropSql, buildIndexFragmentationCustomTemplate, defaultBackupSettings,
  dialectSupportsDbaUtility, dialectSupportsIndexFragmentation, formatBytes, formatPct,
  formatRowCount, fragmentationSeverity, groupObjectSizes, indexMaintenanceVerb,
  indexTableSizeGroups, lookupIndexSizeRow, normalizeBackupHistory, parseTableList,
} from '@foxschema/sql';
export type {
  BackupCommands, BackupHistoryEntry, BackupRunsOn, BackupScope, BackupSettings, DbaUtilityKind,
  TableSizeGroup,
} from '@foxschema/sql';
