/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL editor store, for the features that read its connections and
 * schema cache. Heavy: import it only from code that is itself loaded on
 * demand, never from the first screen.
 */
export { useSqlEditorStore } from './state/useSqlEditorStore';
export { scrubRemovedFileConnections } from './lib/fileQueryEditorHelpers';
