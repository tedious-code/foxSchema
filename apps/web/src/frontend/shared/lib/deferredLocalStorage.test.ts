// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferredLocalStorage, flushDeferredStorage } from './deferredLocalStorage';

const value = (sql: string) => ({ state: { sql }, version: 1 });

describe('deferredLocalStorage', () => {
  afterEach(() => {
    flushDeferredStorage();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('writes once after a burst of changes, and reads the pending snapshot meanwhile', () => {
    vi.useFakeTimers();
    const storage = deferredLocalStorage<{ sql: string }>(400);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    for (const sql of ['s', 'se', 'sel', 'select 1']) storage.setItem('editor', value(sql));
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem('editor')).toEqual(value('select 1'));
    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('editor')!)).toEqual(value('select 1'));
    write.mockRestore();
  });

  it('writes at once when the page is hidden or closed', () => {
    const storage = deferredLocalStorage<{ sql: string }>(60_000);
    storage.setItem('editor', value('typed just now'));
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem('editor')!)).toEqual(value('typed just now'));
  });

  it('drops a pending write for an item that is removed', () => {
    vi.useFakeTimers();
    const storage = deferredLocalStorage<{ sql: string }>(400);
    storage.setItem('editor', value('old'));
    storage.removeItem('editor');
    vi.advanceTimersByTime(400);
    expect(localStorage.getItem('editor')).toBeNull();
    expect(storage.getItem('editor')).toBeNull();
  });
});
