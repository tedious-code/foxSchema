/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A `foxschema` credential stores only a saved-connection id and asks FoxSchema
 * for the connection each time a run needs it.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildStoredSecret, resolveStoredSecret } from './providers.js';
import { createCredentialSchema } from './store.js';

const RESOLVED = {
  dialect: 'postgres',
  schema: 'public',
  option: { host: 'db.internal', username: 'etl', password: 'from-foxschema' },
};

describe('foxschema credential source', () => {
  it('stores the connection id and nothing else', () => {
    expect(
      buildStoredSecret('foxschema', { connectionId: ' conn-1 ', password: 'ignored' }),
    ).toEqual({ source: 'foxschema', connectionId: 'conn-1' });
  });

  it('keeps the linked-connection id prefix for linked connections', () => {
    const linked = { id: 'foxschema-conn-1', name: 'w', kind: 'database', source: 'foxschema', data: { connectionId: 'conn-1' } };
    expect(createCredentialSchema.safeParse(linked).success).toBe(true);
    // A local credential cannot pose as a linked connection…
    expect(createCredentialSchema.safeParse({ ...linked, source: 'local', data: { password: 'x' } }).success).toBe(false);
    // …nor can a link take another connection's id.
    expect(createCredentialSchema.safeParse({ ...linked, data: { connectionId: 'conn-2' } }).success).toBe(false);
  });

  it('refuses a reference with no connection id', () => {
    expect(() => buildStoredSecret('foxschema', {})).toThrow(/connectionId/);
  });

  it('resolves through an injected function without HTTP', async () => {
    const fetchImpl = vi.fn();
    const resolved = await resolveStoredSecret(
      { source: 'foxschema', connectionId: 'conn-1' },
      {},
      fetchImpl as unknown as typeof fetch,
      async (connectionId) => (connectionId === 'conn-1' ? RESOLVED : undefined),
    );
    expect(resolved).toEqual(RESOLVED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses HTTP when no resolver is injected', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveStoredSecret(
        { source: 'foxschema', connectionId: 'conn-1' },
        { WORKFLOW_ENGINE_TOKEN: 'shared-token', FOXSCHEMA_URL: 'http://fox.test:3210/' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/in-process engine/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says a refused connection is not granted', async () => {
    await expect(
      resolveStoredSecret(
        { source: 'foxschema', connectionId: 'conn-1' },
        {},
        fetch as typeof fetch,
        async () => undefined,
      ),
    ).rejects.toThrow(/not granted to workflows/);
  });
});
