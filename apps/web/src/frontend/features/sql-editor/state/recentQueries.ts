/**
 * The SQL editor's recent queries, for the shell: Home and the command palette.
 *
 * The editor store owns and saves them, but it is a large module that only the
 * SQL editor needs, and the shell is on every first page. Until the editor
 * store loads, this reads the list from its saved snapshot; once it loads, it
 * keeps this copy in step. Opening a query or a connection loads the editor
 * store on the click.
 */
import { create } from 'zustand';
import { editorStorageKey, SQL_EDITOR_PERSIST_KEY } from '@/shared/lib/editorWorkspaceStorage';
import type { RecentQuery } from './useSqlEditorStore';

export { SQL_EDITOR_PERSIST_KEY };

/** Where and in which shape the editor store saves itself (its `persist` options). */
export const SQL_EDITOR_PERSIST_VERSION = 8;

function savedRecentQueries(): RecentQuery[] {
  try {
    const raw = localStorage.getItem(editorStorageKey());
    const saved = raw ? (JSON.parse(raw) as { version?: number; state?: { recentQueries?: unknown } }) : null;
    // An older snapshot is migrated by the editor store when it loads.
    if (saved?.version !== SQL_EDITOR_PERSIST_VERSION) return [];
    const list = saved.state?.recentQueries;
    return Array.isArray(list) ? (list as RecentQuery[]) : [];
  } catch {
    return [];
  }
}

export const useRecentQueries = create<{ recentQueries: RecentQuery[] }>(() => ({
  recentQueries: savedRecentQueries(),
}));

const editorStore = async () => (await import('../state')).useSqlEditorStore.getState();

/** Reopen a recent query as a SQL editor tab. */
export async function openRecentQuery(id: string): Promise<void> {
  (await editorStore()).openRecentQuery(id);
}

/** Make a saved connection a destination of the active SQL editor tab. */
export async function selectEditorConnection(id: string): Promise<void> {
  (await editorStore()).ensureConnectionSelected(id);
}
