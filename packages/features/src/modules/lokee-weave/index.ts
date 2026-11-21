/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — content-addressed schema versioning for Compare Schema.
 *
 * Read the whole schema, hash everything, write only what changed.
 *
 * This module is the pure half: canonicalisation, hashing, root hashing and
 * delta computation. Persistence (object store, version rows, latest-state
 * index, checkpoints) lives on the Node side, because this package must stay
 * loadable in a browser bundle.
 */
export {
  canonicalizeObject,
  canonicalizeSchema,
  type CanonicalObject,
  type LokeeObjectType,
} from './canonical.js';
export {
  applyChanges,
  diffAgainstIndex,
  hashObject,
  hashObjects,
  rootHash,
  weave,
  type ChangeOperation,
  type Digest,
  type LatestIndex,
  type ObjectChange,
  type HashOptions,
  type WeaveCapture,
  type WeaveObject,
} from './weave.js';
export { stableStringify } from './stable-stringify.js';
export {
  mergeBody,
  roundTrips,
  shapeKey,
  splitBody,
  type SplitBody,
} from './shape.js';
export {
  changeKindsByOwner,
  classifyChildChange,
  CHANGE_KIND_LABEL,
  CHANGE_KIND_ORDER,
  CHANGE_KIND_TITLE,
  type ChildChange,
  type ObjectChangeKind,
} from './change-kinds.js';
export {
  databaseIdentity,
  databaseIdentityText,
  type DatabaseIdentityInput,
} from './identity.js';
export {
  classifyReversal,
  parseTypeText,
  planReversal,
  type ReversalPlan,
  type ReversalRisk,
  type ReversalVerdict,
} from './reversal.js';
export {
  collapseObjectHistory,
  windowByTime,
  windowGraph,
  DEFAULT_WINDOW_ITEMS,
  MAX_WINDOW_ITEMS,
  type GraphNode,
  type GraphResult,
  type HistoryWindow,
  type ObjectHistoryPoint,
  type TimePoint,
  type WindowResult,
} from './history.js';
export {
  assembleBlueprint,
  blueprintChildCounts,
  countSourceLines,
  isLokeeContainerType,
  isLokeeTableLikeType,
  objectKeyKind,
  objectKeyOwner,
  pickOwnerContainer,
  type ObjectBlueprint,
  type StoredWeaveObject,
} from './blueprint.js';
export {
  lokeeColumnChangeSubtitle,
  lokeeColumnSubtitle,
  lokeeTypeLabel,
  renderLokeeObjectScript,
} from './script.js';
export { hydrateTableSchemas } from './hydrate.js';
export { buildRevertMigration,
  migrationFromCompare, type RevertMigration } from './revert-sql.js';
