// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The editor store loads the theme store, which reads the colour scheme.
window.matchMedia ??= ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const saved = (version: number, recentQueries: unknown[]) =>
  localStorage.setItem('foxschema-sql-editor', JSON.stringify({ version, state: { recentQueries } }));

const query = { id: 'r1', sql: 'SELECT 1', title: 'Ping', selectedConnectionIds: [], ranAt: 1 };

describe('recent queries for the shell', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('reads the saved list without loading the SQL editor store', async () => {
    saved(8, [query]);
    const { useRecentQueries } = await import('./recentQueries');
    expect(useRecentQueries.getState().recentQueries).toEqual([query]);
  });

  it('ignores a snapshot from an older version, which the editor store migrates', async () => {
    saved(7, [{ sql: 'SELECT 1' }]);
    const { useRecentQueries } = await import('./recentQueries');
    expect(useRecentQueries.getState().recentQueries).toEqual([]);
  });

  it('follows the editor store once it loads, and opens queries through it', async () => {
    const { useRecentQueries, openRecentQuery } = await import('./recentQueries');
    const { useSqlEditorStore } = await import('./useSqlEditorStore');
    useSqlEditorStore.setState({ recentQueries: [query] });
    expect(useRecentQueries.getState().recentQueries).toEqual([query]);

    const open = vi.spyOn(useSqlEditorStore.getState(), 'openRecentQuery');
    await openRecentQuery('r1');
    expect(open).toHaveBeenCalledWith('r1');
  });
});
