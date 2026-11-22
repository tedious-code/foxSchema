/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Keeps workflow SQL sessions that share one driver handle from stepping on
 * each other's transactions.
 *
 * Some `@foxschema/db` adapters hand every caller the same handle for a target
 * whatever `pooled` says: SQLite caches one `Database` per file, DuckDB one
 * connection per file. A "dedicated" session on those is not dedicated. Two
 * batches reaching one SQLite write pipe at once (a merge feeding it, or two
 * pipes writing the same file) each sent `BEGIN` on the same handle, and the
 * second failed with "cannot start a transaction within a transaction". Worse,
 * a plain statement from another session could land inside the open
 * transaction and be rolled back with it.
 *
 * The gate is keyed by the handle object itself, so it applies exactly where a
 * handle is shared and costs nothing where each session gets its own. While a
 * session holds a transaction, the other sessions on that handle wait: for
 * their own `BEGIN`, and for any statement.
 */

/** Opaque identity of one session on a handle. */
export type GateSession = symbol;

export class SharedHandleGate {
  private owner: GateSession | undefined;
  private waiters: Array<() => void> = [];

  private taken(session: GateSession): boolean {
    return this.owner !== undefined && this.owner !== session;
  }

  private wait(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  // The wait loops are inlined on purpose. Waiting in a separate async helper
  // adds a microtask between "the handle is free" and acting on it, and every
  // waiter woken by one release would see it free in that gap.

  /** Runs one statement, outside any other session's transaction. */
  async run<T>(session: GateSession, work: () => Promise<T>): Promise<T> {
    while (this.taken(session)) await this.wait();
    return work();
  }

  /**
   * Takes the handle for `session` and starts its transaction with `begin`.
   * The handle stays taken until {@link release}; a failed `begin` releases it.
   */
  async begin(session: GateSession, begin: () => Promise<void>): Promise<void> {
    while (this.taken(session)) await this.wait();
    // Taken in the same tick the loop saw the handle free.
    this.owner = session;
    try {
      await begin();
    } catch (error) {
      this.release(session);
      throw error;
    }
  }

  /** Gives the handle back after commit or rollback. A no-op for a non-owner. */
  release(session: GateSession): void {
    if (this.owner !== session) return;
    this.owner = undefined;
    const waiting = this.waiters.splice(0);
    for (const wake of waiting) wake();
  }

  /** Whether `session` holds the handle's transaction right now. */
  holds(session: GateSession): boolean {
    return this.owner === session;
  }
}

const gates = new WeakMap<object, SharedHandleGate>();

/**
 * The gate for a driver handle. Sessions that were handed the same object
 * share one gate. A primitive handle (no identity to share) gets its own.
 */
export function gateForHandle(handle: unknown): SharedHandleGate {
  if (handle === null || (typeof handle !== 'object' && typeof handle !== 'function')) {
    return new SharedHandleGate();
  }
  let gate = gates.get(handle);
  if (!gate) {
    gate = new SharedHandleGate();
    gates.set(handle, gate);
  }
  return gate;
}
