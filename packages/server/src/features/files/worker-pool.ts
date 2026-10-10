/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A small bounded worker-thread pool for CPU-bound work.
 *
 * Node runs one thread, so a long synchronous stretch blocks every other
 * request, the health endpoint and the shutdown handler. Parsing a 22MB CSV
 * occupies the event loop for roughly 784ms; a 100MB import would hold it for
 * several seconds.
 *
 * What belongs in a worker is narrower than it first appears. Database calls
 * are I/O and already yield; moving them here would only add serialisation
 * cost. Schema compare measured 48ms for 3000 tables — below the threshold
 * where the transfer overhead pays for itself. This is for work that is both
 * genuinely CPU-bound and large: parsing uploads is the clear case.
 *
 * Events, rather than a bare promise, because these tasks are long enough that
 * a caller wants to report progress and a cancel has to be possible.
 */

import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';

export interface PoolTask<TInput> {
  /** Worker entry file. */
  script: URL;
  input: TInput;
  /** Kill the worker after this long. */
  timeoutMs?: number;
  /** Large payloads that should move rather than be copied. */
  transfer?: readonly ArrayBuffer[];
}

export class TaskHandle<TResult> extends EventEmitter {
  #cancel: (() => void) | null = null;
  readonly promise: Promise<TResult>;
  #settle!: (r: TResult) => void;
  #fail!: (e: Error) => void;

  constructor() {
    super();
    this.promise = new Promise<TResult>((resolve, reject) => {
      this.#settle = resolve;
      this.#fail = reject;
    });
    // A caller may only want events; an unhandled rejection must not crash the
    // process when the promise has no attached handler.
    this.promise.catch(() => undefined);
  }

  /** @internal */
  _bindCancel(fn: () => void): void {
    this.#cancel = fn;
  }
  /** @internal */
  _resolve(result: TResult): void {
    this.#settle(result);
    this.emit('done', result);
  }
  /** @internal */
  _reject(error: Error): void {
    this.#fail(error);
    // EventEmitter throws on an 'error' event with no listener — the same trap
    // that killed the API through an unhandled pg pool error. A caller using
    // only the promise must not be punished for not also subscribing.
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  cancel(): void {
    this.#cancel?.();
  }
}

interface Queued {
  run: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class WorkerPool {
  /**
   * Leave a core for the event loop itself. A pool sized to every core starves
   * the thread that has to hand work out and collect it.
   */
  private readonly limit: number;
  private active = 0;
  private readonly queue: Queued[] = [];

  constructor(limit = Math.max(1, Math.min(4, cpus().length - 1))) {
    this.limit = Math.max(1, limit);
  }

  get stats(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }

  run<TInput, TResult>(task: PoolTask<TInput>): TaskHandle<TResult> {
    const handle = new TaskHandle<TResult>();
    const start = () => this.#start(task, handle);

    if (this.active >= this.limit) {
      // Queued rather than spawned: unbounded workers on a burst of uploads
      // would be a worse failure than waiting.
      let cancelled = false;
      handle._bindCancel(() => {
        cancelled = true;
        handle._reject(new Error('Task cancelled before it started.'));
      });
      this.queue.push({
        run: () => {
          if (cancelled) return;
          start();
        },
      });
      return handle;
    }
    start();
    return handle;
  }

  #next(): void {
    this.active -= 1;
    const nextTask = this.queue.shift();
    if (nextTask) nextTask.run();
  }

  #start<TInput, TResult>(task: PoolTask<TInput>, handle: TaskHandle<TResult>): void {
    this.active += 1;
    let settled = false;

    const worker = new Worker(task.script, {
      workerData: task.input,
      // tsx registers the TS loader for the worker too; without it a .ts entry
      // fails to load in development.
      execArgv: process.execArgv,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      this.#next();
      fn();
    };

    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      finish(() => handle._reject(new Error(`Task timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    handle._bindCancel(() => {
      finish(() => handle._reject(new Error('Task cancelled.')));
    });

    worker.on('message', (msg: { type: string; percent?: number; note?: string; result?: TResult; error?: string }) => {
      if (msg?.type === 'progress') {
        handle.emit('progress', msg.percent ?? 0, msg.note);
        return;
      }
      if (msg?.type === 'error') {
        finish(() => handle._reject(new Error(msg.error || 'Worker failed.')));
        return;
      }
      if (msg?.type === 'done') {
        finish(() => handle._resolve(msg.result as TResult));
      }
    });

    // A worker that throws before posting anything must still settle the
    // caller — otherwise the request hangs until its own timeout.
    worker.on('error', (err: unknown) =>
      finish(() => handle._reject(err instanceof Error ? err : new Error(String(err))))
    );
    worker.on('exit', (code) => {
      if (code !== 0) {
        finish(() => handle._reject(new Error(`Worker exited with code ${code}.`)));
      } else {
        finish(() => handle._reject(new Error('Worker exited without returning a result.')));
      }
    });
  }
}

/** Shared pool, so concurrent uploads share one bounded set of threads. */
export const cpuPool = new WorkerPool(Number(process.env.FOX_WORKER_LIMIT) || undefined);
