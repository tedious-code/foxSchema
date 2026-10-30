/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redisAdapter, redisRowMatchesPredicates } from './redis.adapter.js';

describe('redis adapter handle isolation', () => {
  afterEach(async () => {
    await redisAdapter.closeAll();
    vi.restoreAllMocks();
  });

  it('setCurrentSchema does not leave the shared client on another DB index for the next acquire', async () => {
    let selectedDb = 0;
    const select = vi.fn(async (n: number) => {
      selectedDb = n;
    });
    const connect = vi.fn(async () => undefined);
    const quit = vi.fn(async () => undefined);
    const createClient = vi.fn(() => ({
      on: vi.fn(),
      connect,
      quit,
      select,
    }));
    (redisAdapter as any).mod = { createClient };

    const first = await redisAdapter.acquire(
      'redis://localhost:6379',
      { database: '0' } as any,
      true
    );
    expect(selectedDb).toBe(0);

    await redisAdapter.setCurrentSchema(first, '3');
    expect(selectedDb).toBe(3);

    const second = await redisAdapter.acquire(
      'redis://localhost:6379',
      { database: '0' } as any,
      true
    );
    expect(second).toBe(first);
    expect(selectedDb).toBe(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('redisRowMatchesPredicates', () => {
  it('matches when every non-id predicate holds', () => {
    const row = { id: '1', name: 'alice', status: 'active' };
    expect(
      redisRowMatchesPredicates(
        row,
        [
          { column: 'name', value: { kind: 'param', index: 0 } },
          { column: 'status', value: { kind: 'literal', value: 'active' } },
        ],
        ['alice']
      )
    ).toBe(true);
  });

  it('fails closed when a predicate does not match', () => {
    const row = { id: '1', name: 'alice', status: 'inactive' };
    expect(
      redisRowMatchesPredicates(
        row,
        [{ column: 'status', value: { kind: 'literal', value: 'active' } }],
        []
      )
    ).toBe(false);
  });

  it('does not treat null as matching a missing field', () => {
    const row = { id: '1', name: 'alice' };
    expect(
      redisRowMatchesPredicates(
        row,
        [{ column: 'status', value: { kind: 'literal', value: null } }],
        []
      )
    ).toBe(false);
  });
});
