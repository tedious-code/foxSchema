/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A compare run: the statement read again on the source and the target, in
 * key order, COMPARE_WINDOW_ROWS (+1) rows each. The pages a grid shows are
 * read independently with OFFSET and do not line up, so comparing them leaves
 * most one-sided rows unresolved; two windows in the same key order do.
 *
 * Held here, beside the pane that asked, not in the editor store: the grids'
 * own pages stay as they are, and a new run of the statement drops it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { executeSql, type SqlStatementResult } from '@/shared/api/sqlApi';
import { getSessionPassword } from '@/shared/lib/sessionPasswords';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { COMPARE_WINDOW_ROWS } from '@/features/sql-editor/lib/compareView';

type OkResult = Extract<SqlStatementResult, { ok: true }>;

export type CompareWindowState =
  | { status: 'idle' }
  | { status: 'loading'; keys: string[] }
  | { status: 'ready'; keys: string[]; sourceId: string; destId: string; source: OkResult; dest: OkResult }
  | { status: 'error'; keys: string[]; error: string };

export interface CompareWindowSide {
  connectionId: string;
  sql: string;
}

export function useCompareWindow(
  /** Changes when the statement runs again: the windows then describe old results. */
  resetKey: unknown
): {
  state: CompareWindowState;
  run: (source: CompareWindowSide, dest: CompareWindowSide, keys: string[]) => Promise<void>;
  clear: () => void;
} {
  const [state, setState] = useState<CompareWindowState>({ status: 'idle' });
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  /** Which run is current: a slow older one must not overwrite a newer answer. */
  const runId = useRef(0);

  useEffect(() => {
    runId.current += 1;
    setState({ status: 'idle' });
  }, [resetKey]);

  const run = useCallback(
    async (source: CompareWindowSide, dest: CompareWindowSide, keys: string[]) => {
      const id = ++runId.current;
      setState({ status: 'loading', keys });
      const read = async (side: CompareWindowSide): Promise<OkResult> => {
        const password = getSessionPassword(side.connectionId) || sessionPasswords[side.connectionId] || undefined;
        const { results } = await executeSql(
          { connectionId: side.connectionId, password },
          [side.sql],
          COMPARE_WINDOW_ROWS,
          0,
          undefined,
          { orderBy: keys }
        );
        const one = results[0];
        if (!one) throw new Error('No result returned');
        if (!one.ok) throw new Error(one.error);
        return one;
      };
      try {
        const [s, d] = await Promise.all([read(source), read(dest)]);
        if (id === runId.current) {
          setState({ status: 'ready', keys, sourceId: source.connectionId, destId: dest.connectionId, source: s, dest: d });
        }
      } catch (error: unknown) {
        if (id === runId.current) {
          setState({ status: 'error', keys, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    [sessionPasswords]
  );

  const clear = useCallback(() => {
    runId.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { state, run, clear };
}
