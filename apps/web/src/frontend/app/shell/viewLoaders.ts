/**
 * Where each workspace view's code comes from. App.tsx renders the views
 * lazily from these, and the activity rail calls `prefetchView` when the
 * pointer or keyboard focus reaches a button, so the view's code is usually
 * already loaded by the time the click lands.
 *
 * Calling a loader twice fetches once: the browser keeps each module after its
 * first import, and React.lazy then resolves from that copy.
 */
import type { ActiveView } from '@/app/store/uiStore';

export const loadAccessView = () => import('@/features/access');
export const loadSqlEditorView = () => import('@/features/sql-editor/components/SqlEditorView');
export const loadUtilitiesView = () => import('@/features/utilities');
export const loadSnapshotsView = () => import('@/features/lokee-weave');
export const loadSettingsPanel = () => import('@/app/settings/SettingsPanel');
export const loadWorkflowView = () => import('@/features/workflow');
export const loadSchemaTreePanel = () => import('@/features/sql-editor/components/SchemaTreePanel');
export const loadObjectDetailPanel = () =>
  import('@/features/object-detail/components/ObjectDetailPanel');

const PREFETCH: Partial<Record<ActiveView, () => Promise<unknown>>> = {
  sync: () => Promise.all([loadSchemaTreePanel(), loadObjectDetailPanel()]),
  sqlEditor: loadSqlEditorView,
  access: loadAccessView,
  utilities: loadUtilitiesView,
  snapshots: loadSnapshotsView,
  settings: loadSettingsPanel,
  workflow: loadWorkflowView,
};

/**
 * What a view loads lazily inside itself, worth starting along with it when a
 * click is likely. The SQL editor's pane brings Monaco, the longest wait in
 * the app, which would otherwise start only after the view arrived.
 */
const INSIDE: Partial<Record<ActiveView, () => Promise<unknown>>> = {
  sqlEditor: () => import('@/features/sql-editor/components/SqlEditorPane'),
};

/**
 * Start loading a view's code ahead of a likely click. `inside` also loads what
 * the view loads lazily; startup leaves it out, because Monaco's setup would
 * compete with the first screen. Failures are left to the click.
 */
export function prefetchView(view: ActiveView, { inside = true }: { inside?: boolean } = {}): void {
  void PREFETCH[view]?.().catch(() => undefined);
  if (inside) void INSIDE[view]?.().catch(() => undefined);
}
