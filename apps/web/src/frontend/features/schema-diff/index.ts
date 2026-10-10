/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The schema-diff feature's public API: the diff briefing and the object-type
 * metadata.
 *
 * Imported by the top toolbar, which is on every first page load, so it
 * carries nothing heavy. The diff renderers are in `ui.ts`.
 */
export { diffBriefing, type DiffBriefing } from './lib/diffBriefing';
export { DiffBriefingChips, DiffBriefingTicks } from './components/DiffBriefingChips';
export { TYPE_META, TYPE_ORDER } from './components/objectTypeMeta';
