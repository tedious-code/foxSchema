/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/sdk/src/pipe/sdk.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { createInfrastructureContext } from '../index.js';
import { createDefaultPipeRegistry } from '../../pipes/utility/index.js';

describe('pipe SDK Phase 1 surface', () => {
  it('exposes metadata for every built-in connector via the registry', () => {
    const registry = createDefaultPipeRegistry();
    const listed = registry.listMetadata();
    const types = listed.map((meta) => meta.type).sort();

    expect(types).toEqual([
      'human.gate',
      'logic.loop',
      'sink.db.sql',
      'sink.file.delimited',
      'sink.http',
      'sink.mysql',
      'sink.notify.email',
      'sink.notify.sms',
      'sink.postgres',
      'sink.response',
      'source.api.http',
      'source.api.http.multi',
      'source.db.mysql',
      'source.db.postgres',
      'source.db.sql',
      'source.file.csv',
      'source.file.json',
      'source.file.text',
      'source.trigger.cron',
      'source.trigger.manual',
      'source.trigger.parent',
      'source.trigger.webhook',
      'source.triggerPayload',
      'transform.condition',
      'transform.http',
      'transform.map',
      'transform.merge',
      'transform.script',
      'transform.split',
      'transform.verify',
      'workflow.sub',
    ]);

    for (const meta of listed) {
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.category.length).toBeGreaterThan(0);
      expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(['source', 'transform', 'sink']).toContain(meta.role);
      expect(meta.configSchema).toEqual(expect.objectContaining({ type: 'object' }));
      expect(registry.metadata(meta.type)).toEqual(meta);
    }
  });

  it('creates an InfrastructureContext that reveals secrets and fetches HTTP', async () => {
    const revealSecret = async (id: string) =>
      id === 'cred-1' ? { token: 'secret' } : undefined;
    const infra = createInfrastructureContext({
      credentials: { revealSecret } as never,
      fetch: async () => new Response('ok'),
    });

    await expect(infra.secrets.get('cred-1')).resolves.toEqual({ token: 'secret' });
    await expect(infra.secrets.get('missing')).resolves.toBeUndefined();
    const response = await infra.http.fetch('https://example.test');
    expect(await response.text()).toBe('ok');
  });
});
