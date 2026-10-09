import { useCallback, useEffect, useState } from 'react';
import type { ConnectionOptions } from '@foxschema/db';
import type { SavedConnectionSummary } from '@foxschema/server';
import { getContext } from '../../runtime/store';
import { friendlyError } from '../../format/friendlyError';
import type { AsyncState } from '../types';

/** Plain, hook-independent data function — unit-testable with the same vi.spyOn(store, 'getContext') pattern as the line commands. */
export async function loadConnections(): Promise<SavedConnectionSummary[]> {
  const ctx = await getContext();
  return ctx.connections.list(ctx.scope);
}

/** Decrypt a saved connection by id — same call connectionRef.ts's resolveRef makes internally. */
export async function resolveConnection(
  id: string
): Promise<{ dialect: string; schema?: string; option: ConnectionOptions } | null> {
  const ctx = await getContext();
  return ctx.connections.resolve(ctx.scope, id);
}

/** ctx.connections.list() as an AsyncState, with a `reload` escape hatch after add/remove. */
export function useConnections(): AsyncState<SavedConnectionSummary[]> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<SavedConnectionSummary[]>>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadConnections()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((e) => {
        if (!cancelled) setState({ status: 'error', error: friendlyError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...state, reload };
}
