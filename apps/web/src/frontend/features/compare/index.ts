/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Compare feature's public API: its state.
 *
 * Nearly every feature reads the connection pair and the compare result, so
 * this entry holds only the store and its helpers. The toolbar and the
 * workspace are separate entries (`toolbar.ts`, `view.ts`): they import
 * other features, and keeping them out of this module keeps those features
 * free to import it back without a cycle.
 */
export { useSyncStore } from './state/useSyncStore';
export { buildRef } from './state/syncHelpers';
