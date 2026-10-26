/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The statements Fox runs against saved connections, handed to whoever is
 * listening: the SQL Tracer's "Fox activity" mode.
 *
 * Nothing is kept here. With no trace open there is no listener and a statement
 * is dropped as soon as it is reported, so Fox holds statement text in memory
 * only while someone with `utility.trace` is watching that connection.
 *
 * In platform/ because the SQL editor reports and the tracer listens, and one
 * feature never imports another.
 */

export interface SqlActivity {
  /** The saved connection it ran on. */
  connectionId: string;
  /** Raw statement text: listeners redact it before keeping any. */
  text: string;
  /** The database account it ran as. */
  user: string | null;
  database: string | null;
  durationMs: number;
  rows: number | null;
  error: string | null;
  at: Date;
}

export type SqlActivityListener = (activity: SqlActivity) => void;

export class SqlActivityFeed {
  private readonly listeners = new Map<string, Set<SqlActivityListener>>();

  /** Whether anyone is listening to `connectionId` — check before building activity. */
  watching(connectionId: string): boolean {
    return (this.listeners.get(connectionId)?.size ?? 0) > 0;
  }

  report(activity: SqlActivity): void {
    const listeners = this.listeners.get(activity.connectionId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      // A listener failing must never fail the statement that was reported.
      try {
        listener(activity);
      } catch {
        /* the tracer stops itself on its own errors */
      }
    }
  }

  /** Listen to one connection; call the returned function to stop. */
  listen(connectionId: string, listener: SqlActivityListener): () => void {
    let set = this.listeners.get(connectionId);
    if (!set) {
      set = new Set();
      this.listeners.set(connectionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(connectionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(connectionId);
    };
  }
}
