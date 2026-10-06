/** Thin re-export facade over `@foxschema/sql` for per-column/trigger deploy selection. */
export {
  applyColumnSelection,
  applySelectionToDiff,
  applyTriggerSelection,
  blockedColumns,
  columnExclusionBlock,
  supportsColumnSelection,
} from '@foxschema/ui-shared';
export type { ExclusionBlock, ExclusionContext } from '@foxschema/ui-shared';
