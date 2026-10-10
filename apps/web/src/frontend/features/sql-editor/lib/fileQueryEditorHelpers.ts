import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';

/** Drop removed Files: credentials from schema cache + destination checklists. */
export function scrubRemovedFileConnections(removedIds: string[]): void {
  if (!removedIds.length) return;
  const drop = new Set(removedIds);
  const state = useSqlEditorStore.getState();
  const schemaCache = { ...state.schemaCache };
  for (const id of removedIds) delete schemaCache[id];
  useSqlEditorStore.setState({
    schemaCache,
    sharedConnectionIds: state.sharedConnectionIds.filter((id) => !drop.has(id)),
    tabs: state.tabs.map((t) => ({
      ...t,
      selectedConnectionIds: t.selectedConnectionIds.filter((id) => !drop.has(id)),
    })),
  });
}

/** Check only this file DB in Destinations and load a sample SELECT. */
export function selectFileImportInEditor(connectionId: string, tableName: string): void {
  const store = useSqlEditorStore.getState();
  const quote = tableName.replace(/"/g, '""');
  const sampleSql = `SELECT * FROM "${quote}" LIMIT 100;`;
  if (store.shareDestinations) {
    useSqlEditorStore.setState({ sharedConnectionIds: [connectionId] });
  } else {
    store.ensureConnectionSelected(connectionId);
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (tab) {
      useSqlEditorStore.setState({
        tabs: store.tabs.map((t) =>
          t.id === tab.id ? { ...t, selectedConnectionIds: [connectionId] } : t
        ),
      });
    }
  }
  void store.ensureSchema(connectionId);
  store.setSql(sampleSql);
}
