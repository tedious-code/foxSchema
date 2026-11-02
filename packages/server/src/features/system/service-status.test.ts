/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { readServiceStatus, type ServiceStatusDeps } from './service-status';

const SET = { WORKFLOW_ENGINE_TOKEN: 't', FOXFLOW_ENCRYPTION_KEY: 'k' };

function deps(probe: ServiceStatusDeps['probeEngine'], env: Record<string, string | undefined> = SET): ServiceStatusDeps {
  return { probeEngine: probe, version: () => '0.2.400', uptimeSec: () => 61.9, env };
}

describe('readServiceStatus', () => {
  it('reports the API as running, with its version and whole seconds of uptime', async () => {
    const { api } = await readServiceStatus(deps(async () => ({ ok: true, acceptsRuns: true })));
    expect(api).toEqual({ state: 'running', version: '0.2.400', uptimeSec: 61 });
  });

  it('reports an engine whose health check answers as running', async () => {
    const { engine } = await readServiceStatus(deps(async () => ({ ok: true, acceptsRuns: true, version: '1.4.0' })));
    expect(engine).toEqual({ state: 'running', version: '1.4.0', acceptsRuns: true });
  });

  it('says so when a running engine takes no new runs', async () => {
    const { engine } = await readServiceStatus(deps(async () => ({ ok: true, acceptsRuns: false })));
    expect(engine).toMatchObject({ state: 'running', acceptsRuns: false, detail: expect.stringMatching(/Not taking new runs/) });
  });

  it('names what the server lacks when the engine does not answer', async () => {
    const down = async () => ({ ok: false, acceptsRuns: false, error: 'fetch failed' });
    const both = await readServiceStatus(deps(down, {}));
    expect(both.engine).toEqual({
      state: 'not_configured',
      detail: 'Set WORKFLOW_ENGINE_TOKEN and FOXFLOW_ENCRYPTION_KEY on the server to run the engine.',
    });
    const keyOnly = await readServiceStatus(deps(down, { WORKFLOW_ENGINE_TOKEN: 't', FOXFLOW_ENCRYPTION_KEY: '  ' }));
    expect(keyOnly.engine.detail).toBe('Set FOXFLOW_ENCRYPTION_KEY on the server to run the engine.');
  });

  it('calls a configured engine that does not answer unreachable, with the reason', async () => {
    const { engine } = await readServiceStatus(deps(async () => ({ ok: false, acceptsRuns: false, error: 'fetch failed' })));
    expect(engine).toEqual({ state: 'unreachable', detail: 'No answer: fetch failed' });
  });

  it('treats a probe that throws as no answer', async () => {
    const { engine } = await readServiceStatus(
      deps(async () => {
        throw new Error('Invalid URL');
      })
    );
    expect(engine).toEqual({ state: 'unreachable', detail: 'No answer: Invalid URL' });
  });
});
