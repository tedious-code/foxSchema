/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL editor pieces other features compose: the schema tree, the write
 * confirmation, file imports and the clone-table SQL behind them.
 *
 * Heavier than `index.ts`; import this only from code that is itself
 * loaded on demand.
 */
export { SchemaTreePanel } from './components/SchemaTreePanel';
export { WriteConfirmDialog } from './components/WriteConfirmDialog';
export { FileImportsPanel } from './components/FileImportsPanel';
export {
  dialectFkConstraintSupport,
  dialectIndexSupport,
  executableSqlStatements,
  findInboundForeignKeyTables,
  generateCloneTableSql,
} from './lib/tableBlueprintSql';
