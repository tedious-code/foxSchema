/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { SharedHandleGate, gateForHandle } from './shared-handle-gate.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SharedHandleGate', () => {
  it('holds other sessions’ statements and BEGIN until the owner releases', async () => {
    const gate = new SharedHandleGate();
    const a = Symbol('a');
    const b = Symbol('b');
    const order: string[] = [];

    await gate.begin(a, async () => void order.push('a:begin'));
    const bQuery = gate.run(b, async () => void order.push('b:query'));
    const bBegin = gate.begin(b, async () => void order.push('b:begin'));
    await gate.run(a, async () => void order.push('a:query'));
    await tick();
    expect(order).toEqual(['a:begin', 'a:query']);

    gate.release(a);
    await Promise.all([bQuery, bBegin]);
    expect(order).toEqual(['a:begin', 'a:query', 'b:query', 'b:begin']);
    expect(gate.holds(b)).toBe(true);
  });

  it('lets only one of several woken waiters take the handle', async () => {
    const gate = new SharedHandleGate();
    const owner = Symbol('owner');
    await gate.begin(owner, async () => undefined);
    const sessions = [Symbol('x'), Symbol('y'), Symbol('z')];
    let inside = 0;
    let most = 0;
    const runs = sessions.map((s) =>
      (async () => {
        await gate.begin(s, async () => undefined);
        inside += 1;
        most = Math.max(most, inside);
        await tick();
        inside -= 1;
        gate.release(s);
      })(),
    );
    gate.release(owner);
    await Promise.all(runs);
    expect(most).toBe(1);
  });

  it('releases the handle when BEGIN itself fails', async () => {
    const gate = new SharedHandleGate();
    const a = Symbol('a');
    await expect(gate.begin(a, async () => Promise.reject(new Error('locked')))).rejects.toThrow('locked');
    expect(gate.holds(a)).toBe(false);
    await expect(gate.run(Symbol('b'), async () => 'ran')).resolves.toBe('ran');
  });

  it('shares one gate per handle object, and none for a primitive', () => {
    const handle = {};
    expect(gateForHandle(handle)).toBe(gateForHandle(handle));
    expect(gateForHandle({})).not.toBe(gateForHandle(handle));
    expect(gateForHandle('conn')).not.toBe(gateForHandle('conn'));
  });
});
