import { describe, expect, it, vi } from 'vitest';
import { loadOnce } from './loadOnce';

describe('loadOnce', () => {
  it('loads once and shares the result between callers', async () => {
    const load = vi.fn(async () => ({ ready: true }));
    const get = loadOnce(load);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(await get()).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('peeks at the value only once a load has succeeded', async () => {
    const get = loadOnce(async () => 42);
    expect(get.peek()).toBeUndefined();
    const pending = get();
    expect(get.peek()).toBeUndefined();
    await pending;
    expect(get.peek()).toBe(42);
  });

  it('retries after a failed load instead of caching the failure', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('module');
    const get = loadOnce(load);
    await expect(get()).rejects.toThrow('offline');
    expect(get.peek()).toBeUndefined();
    expect(await get()).toBe('module');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
