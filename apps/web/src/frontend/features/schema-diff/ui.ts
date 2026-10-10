/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The diff renderers: the object tree, the blueprint, the DDL diff and the
 * detail tabs. Compare, Lokee history and the SQL editor's tree share them.
 *
 * Heavier than `index.ts`; import this only from code that is itself
 * loaded on demand.
 */
export { DetailTabs, type DetailTab } from './components/DetailTabs';
export { SchemaBlueprint } from './components/SchemaBlueprint';
export { DdlDiffLines, buildTableDdlDiffLines, stripSchemaQualifiers } from './components/SchemaDdlDiff';
export { SchemaDiffTree, orderTablesForDisplay } from './components/SchemaDiffTree';
export { DiffBriefingPanel } from './components/DiffBriefingPanel';
