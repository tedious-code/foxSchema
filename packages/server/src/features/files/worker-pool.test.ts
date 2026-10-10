import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerPool } from './worker-pool';

/** Real worker scripts — a mocked Worker would test the mock, not the pool. */
const dir = mkdtempSync(join(tmpdir(), 'fox-pool-'));
function script(name: string, body: string): URL {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, `import { parentPort, workerData } from 'node:worker_threads';\n${body}\n`);
  return pathToFileURL(file);
}

const ok = script('ok', `parentPort.postMessage({ type: 'done', result: (workerData?.n ?? 0) * 2 });`);
const reportsError = script('err', `parentPort.postMessage({ type: 'error', error: 'nope' });`);
const throwsEarly = script('throws', `throw new Error('boom');`);
const exitsSilently = script('silent', `process.exit(0);`);
const withProgress = script('prog', `
  parentPort.postMessage({ type: 'progress', percent: 50, note: 'half' });
  parentPort.postMessage({ type: 'done', result: 'finished' });
`);
const hangs = script('hang', `setInterval(() => {}, 1000);`);
const slow = script('slow', `setTimeout(() => parentPort.postMessage({ type: 'done', result: 'late' }), 300);`);

describe('worker pool', () => {
  it('runs a task and returns its result', async () => {
    const pool = new WorkerPool(2);
    await expect(pool.run<{ n: number }, number>({ script: ok, input: { n: 21 } }).promise)
      .resolves.toBe(42);
  });

  it('surfaces an error the worker reports', async () => {
    const pool = new WorkerPool(2);
    await expect(pool.run({ script: reportsError, input: {} }).promise).rejects.toThrow(/nope/);
  });

  it('settles when the worker throws before posting anything', async () => {
    // Otherwise the caller hangs until its own timeout with no explanation.
    const pool = new WorkerPool(2);
    await expect(pool.run({ script: throwsEarly, input: {} }).promise).rejects.toThrow(/boom/);
  });

  it('settles when the worker exits without a result', async () => {
    const pool = new WorkerPool(2);
    await expect(pool.run({ script: exitsSilently, input: {} }).promise)
      .rejects.toThrow(/without returning a result|exited/i);
  });

  it('emits progress before the result', async () => {
    const pool = new WorkerPool(2);
    const seen: Array<[number, string | undefined]> = [];
    const handle = pool.run<unknown, string>({ script: withProgress, input: {} });
    handle.on('progress', (p: number, n?: string) => seen.push([p, n]));
    await expect(handle.promise).resolves.toBe('finished');
    expect(seen).toEqual([[50, 'half']]);
  });

  it('kills a worker that never finishes', async () => {
    const pool = new WorkerPool(2);
    await expect(pool.run({ script: hangs, input: {}, timeoutMs: 250 }).promise)
      .rejects.toThrow(/timed out/i);
  });

  it('frees its slot after a timeout, so the pool does not leak capacity', async () => {
    const pool = new WorkerPool(1);
    await expect(pool.run({ script: hangs, input: {}, timeoutMs: 200 }).promise).rejects.toThrow();
    // If the slot leaked, this would queue forever.
    await expect(pool.run<{ n: number }, number>({ script: ok, input: { n: 5 } }).promise)
      .resolves.toBe(10);
  });

  it('queues beyond the limit instead of spawning unbounded workers', async () => {
    const pool = new WorkerPool(1);
    const a = pool.run<unknown, string>({ script: slow, input: {} });
    const b = pool.run<{ n: number }, number>({ script: ok, input: { n: 3 } });
    // b cannot have started: the single slot is taken.
    expect(pool.stats.queued).toBe(1);
    await expect(a.promise).resolves.toBe('late');
    await expect(b.promise).resolves.toBe(6);
    expect(pool.stats).toMatchObject({ active: 0, queued: 0 });
  });

  it('cancels a queued task without ever starting it', async () => {
    const pool = new WorkerPool(1);
    const running = pool.run<unknown, string>({ script: slow, input: {} });
    const queued = pool.run({ script: ok, input: { n: 1 } });
    queued.cancel();
    await expect(queued.promise).rejects.toThrow(/cancelled/i);
    await expect(running.promise).resolves.toBe('late');
  });

  it('cancels a running task', async () => {
    const pool = new WorkerPool(1);
    const handle = pool.run({ script: hangs, input: {}, timeoutMs: 10_000 });
    handle.cancel();
    await expect(handle.promise).rejects.toThrow(/cancelled/i);
  });

  it('an unawaited failure does not become an unhandled rejection', async () => {
    // A caller may only want events; that must not crash the process.
    const pool = new WorkerPool(1);
    const handle = pool.run({ script: reportsError, input: {} });
    const seen = await new Promise<Error>((resolve) => handle.on('error', resolve));
    expect(seen.message).toMatch(/nope/);
  });

  it('never sizes itself to zero threads', () => {
    expect(new WorkerPool(0).stats.limit).toBe(1);
    expect(new WorkerPool(-5).stats.limit).toBe(1);
  });
});
