import { useEffect, useState } from 'react';
import type { MigrationRunDetail, MigrationRunSummary } from '@foxschema/server';
import { getContext } from '../../runtime/store';
import { friendlyError } from '../../format/friendlyError';
import type { AsyncState } from '../types';

/** Plain, hook-independent data functions — unit-testable with the same vi.spyOn(store, 'getContext') pattern as the line commands. */
export async function loadHistoryList(): Promise<MigrationRunSummary[]> {
  const ctx = await getContext();
  return ctx.history.list(ctx.scope);
}

export async function loadHistoryDetail(runId: string): Promise<MigrationRunDetail | null> {
  const ctx = await getContext();
  return ctx.history.get(ctx.scope, runId);
}

export function useHistoryList(): AsyncState<MigrationRunSummary[]> {
  const [state, setState] = useState<AsyncState<MigrationRunSummary[]>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadHistoryList()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((e) => {
        if (!cancelled) setState({ status: 'error', error: friendlyError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function useHistoryDetail(runId: string): AsyncState<MigrationRunDetail | null> {
  const [state, setState] = useState<AsyncState<MigrationRunDetail | null>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadHistoryDetail(runId)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((e) => {
        if (!cancelled) setState({ status: 'error', error: friendlyError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return state;
}
