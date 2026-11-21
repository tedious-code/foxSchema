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
export {
  buildMigrationFile,
  findLeftoverSecrets,
  migrationFileName,
  parseMigrationFile,
  scrubSecrets,
  MIGRATION_FILE_VERSION,
} from './modules/migrations/migration-file.js';
export type { BuiltMigrationFile, MigrationFile, MigrationFileHeader } from './modules/migrations/migration-file.js';
export { findDropDependencies } from './modules/migrations/dependency-scan.js';
export type { DropDependency, DropDependencyOptions } from './modules/migrations/dependency-scan.js';
export { isSubsetDialect, pageSubsetSelect, parseSqlSubset, subsetValue } from './modules/query-subset/query-subset.js';
export type {
  SubsetIntent,
  SubsetParse,
  SubsetValue,
  SubsetColumnEq,
} from './modules/query-subset/query-subset.js';
export { identityInsertSupport, identityInsertFor } from './modules/dialect/identity-insert.js';
export type {
  IdentityInsertKind,
  IdentityInsertSupport,
} from './modules/dialect/identity-insert.js';
export { dialectSupportsFk } from './modules/dialect/fk-support.js';
export type { FkFeatureSupport } from './modules/dialect/fk-support.js';
export { dialectSupportsIndex } from './modules/dialect/index-support.js';
export type { IndexFeatureSupport } from './modules/dialect/index-support.js';
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
  isTransactionControl,
  requiresWritePermission,
  sqlStatementCategory,
  sqlStatementCategories,
  sqlStatementCount,
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
export type { SqlDialect, CanonicalType, CanonicalBase, RenderedType } from './modules/dialect/sql-dialect.interface.js';
export { parseClickHouseKeyList } from './providers/clickHouse/clickhouse.sql-dialect.js';
export { resolveDialect, tryResolveDialect, DIALECT_MAP } from './modules/dialect/registry.js';
export { SQL_DIALECT_KEYS, hasSqlDialect, type SqlDialectKey } from './modules/dialect/sql-dialect-keys.js';
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
  sqlLiteral,
  inlineSqlParams,
} from './modules/sql-text/sql-template.js';
export { maxInsertRows } from './modules/sql-text/insert-limits.js';
export type { SqlQuery, SqlTag, RenderedSql, RenderSqlOptions, SqlPlaceholderStyle } from './modules/sql-text/sql-template.js';

export { buildConnectionString, withConnectionString, DEFAULT_PORTS } from './cores/connection-string.js';
export {
  normalizeAuthMethod,
  resolveAuthMethod,
  storedAuthMethod,
  authMethodsForDialect,
  dialectOffersAuthMethods,
  connectionNeedsSecret,
  needsSessionPassword,
  type SecretGateConnection,
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
  dialectHasTransactions,
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

export { splitTopLevel } from './modules/sql-text/split-top-level.js';

export { nonSecretFingerprint } from './cores/fingerprint.js';
export { errorMessage } from './cores/error-message.js';
export { escapeRegExp } from './cores/escape-regexp.js';
export { assertSafeSqliteSql } from './modules/sql-text/sqlite-sql-guard.js';
export { odbcEscape, db2CaLooksLikePem } from './providers/db2/db2.connection.js';
export { IBM_DB_VERSION } from './providers/db2/db2.settings.js';

// Core helpers @foxschema/features builds on. Real exports, not an internal
// subpath: a subpath "documented as unstable" is still importable, so it
// becomes API anyway.
export { isKnownEngine } from './modules/dialect/known-engine.js';
export { PASSWORD_PLACEHOLDER } from './modules/sql-text/password-placeholder.js';
export { normalizeDefinitionText } from './modules/schema-diff/definition-text.js';
