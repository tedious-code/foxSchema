/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL editor's public API, light enough for the first screen: the
 * recent-queries mirror Home and the command palette read, a cursor helper,
 * and loaders for the editor components.
 *
 * The editor store is `state.ts`: Home and the palette must not load it.
 * Components other features compose are in `ui.ts`; the Monaco setup is in
 * `monaco.ts`.
 *
 * The editors are loaders, not re-exports: re-exporting one pulled Monaco
 * (2.6 MB) into the eager graph of every importer, which turned the `lazy()`
 * calls around it into decoration (Rolldown: INEFFECTIVE_DYNAMIC_IMPORT).
 */
export { openRecentQuery, selectEditorConnection, useRecentQueries } from './state/recentQueries';
export { insertAtCursor } from './lib/sqlEditorBridge';

export const loadSqlEditor = () => import('./components/SqlEditor').then((m) => ({ default: m.SqlEditor }));
export const loadSqlDiffEditor = () => import('./components/SqlEditor').then((m) => ({ default: m.SqlDiffEditor }));
