/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/sdk/src/pipe/sandbox.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  SandboxError,
  SandboxTimeoutError,
  runSandboxed,
} from './sandbox.js';

describe('sandboxed execution', () => {
  it('runs ordinary code and returns its result', async () => {
    const result = await runSandboxed(
      'return records.map((r) => ({ n: r.n * 2 }));',
      [{ n: 1 }, { n: 2 }],
      { timeoutMs: 2_000 },
    );

    expect(result).toEqual([{ n: 2 }, { n: 4 }]);
  });

  it('terminates a synchronous infinite loop — the case a timeout cannot fix', async () => {
    // The whole reason this module exists. In-process, `while (true) {}` blocks
    // the event loop, so the timer meant to stop it never fires and every other
    // run on the instance freezes with it. Off-thread, it is just a kill.
    const started = Date.now();

    await expect(
      runSandboxed('while (true) {}', [], { timeoutMs: 300 }),
    ).rejects.toThrow(SandboxTimeoutError);

    // Bounded by the budget, not by the loop (which never ends on its own).
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves the host responsive while a runaway is being killed', async () => {
    // Proves the isolation claim rather than just the rejection: the host's
    // event loop must keep turning while the worker spins.
    let hostTicks = 0;
    const ticking = setInterval(() => {
      hostTicks += 1;
    }, 20);

    await expect(
      runSandboxed('while (true) {}', [], { timeoutMs: 400 }),
    ).rejects.toThrow(SandboxTimeoutError);
    clearInterval(ticking);

    // In-process this would be 0: a busy loop starves timers entirely.
    expect(hostTicks).toBeGreaterThan(2);
  });

  it('surfaces a throw as an error instead of killing the host', async () => {
    await expect(
      runSandboxed('throw new Error("bad transform");', [], {
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/bad transform/);
  });

  it('contains runaway allocation inside the worker', async () => {
    // The sandbox hits its own heap cap and dies; the host is unaffected.
    //
    // Each push is an 8 MB array on the old-generation heap, so the 32 MB cap
    // is reached in ~60 ms (~500 ms with the machine saturated). The deadline
    // is only a backstop against a hang, so it sits far above that: on a
    // loaded CI runner the child can stall for seconds, and a 10 s deadline
    // used to win the race and fail this test with a timeout.
    // (ArrayBuffers would not work here: their memory is external and never
    // counts against the heap cap.)
    const error = await runSandboxed(
      'const a = []; while (true) { a.push(new Array(1e6).fill(1)); } ',
      [],
      { timeoutMs: 60_000, maxOldGenerationSizeMb: 32 },
    ).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    // The heap cap killed it, not the deadline. SandboxTimeoutError is a
    // sibling of SandboxError, not a subclass, so both checks matter.
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).not.toBeInstanceOf(SandboxTimeoutError);
    // Reaching this line at all means the host survived: had the allocation
    // run in-process, the test runner itself would have died of OOM.
    expect((error as Error).message).toMatch(/heap out of memory/i);
  }, 90_000);

  it('does not hand the host environment to sandboxed code', async () => {
    process.env.FOXFLOW_SANDBOX_CANARY = 'leaked';
    try {
      // `process` is now shadowed, so a direct reference does not resolve at
      // all — stricter than the empty env this used to observe. The guarantee
      // that survives a deliberate scope escape lives in
      // sandbox-containment.test.ts; this pins the near case.
      const result = await runSandboxed(
        'return [{ seen: typeof process === "undefined" ? null : "leaked" }];',
        [],
        { timeoutMs: 2_000 },
      );

      expect(result).toEqual([{ seen: null }]);
    } finally {
      delete process.env.FOXFLOW_SANDBOX_CANARY;
    }
  });

  it('keeps working after a neighbour was terminated', async () => {
    // One workflow's runaway must not poison the next one's execution.
    await expect(
      runSandboxed('while (true) {}', [], { timeoutMs: 200 }),
    ).rejects.toThrow(SandboxTimeoutError);

    const result = await runSandboxed('return records;', [{ ok: true }], {
      timeoutMs: 2_000,
    });
    expect(result).toEqual([{ ok: true }]);
  });
});
