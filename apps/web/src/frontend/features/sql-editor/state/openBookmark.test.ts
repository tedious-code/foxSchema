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

const bookmark = (id: string, selectedConnectionIds: string[]) => ({
  id,
  title: id,
  sql: 'SELECT 1',
  selectedConnectionIds,
  updatedAt: 1,
});

async function store(shareDestinations: boolean) {
  const { useSqlEditorStore } = await import('./useSqlEditorStore');
  const first = useSqlEditorStore.getState().tabs[0]!;
  useSqlEditorStore.setState({
    shareDestinations,
    sharedConnectionIds: ['pg'],
    tabs: [{ ...first, selectedConnectionIds: ['pg'] }],
    activeTabId: first.id,
    bookmarks: [bookmark('sample', []), bookmark('mine', ['mysql'])],
  });
  return useSqlEditorStore;
}

describe('openBookmark and the checked Destinations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it.each([true, false])('keeps them for a bookmark saved without any (shared: %s)', async (shared) => {
    const s = await store(shared);
    s.getState().openBookmark('sample');
    expect(s.getState().activeConnectionIds()).toEqual(['pg']);
    // Opening it again reuses the tab and still keeps them.
    s.getState().openBookmark('sample');
    expect(s.getState().activeConnectionIds()).toEqual(['pg']);
  });

  it.each([true, false])('uses the bookmark’s own when it has some (shared: %s)', async (shared) => {
    const s = await store(shared);
    s.getState().openBookmark('mine');
    expect(s.getState().activeConnectionIds()).toEqual(['mysql']);
  });
});
