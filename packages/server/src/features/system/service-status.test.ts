/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { readServiceStatus, type ServiceStatusDeps } from './service-status';

const SET = { FOXFLOW_ENCRYPTION_KEY: 'k' };

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
      detail: 'Set FOXFLOW_ENCRYPTION_KEY on the server to run the engine.',
    });
    const blank = await readServiceStatus(deps(down, { FOXFLOW_ENCRYPTION_KEY: '  ' }));
    expect(blank.engine.detail).toBe('Set FOXFLOW_ENCRYPTION_KEY on the server to run the engine.');
  });

  it('calls a configured engine that is not ready unreachable, with the reason', async () => {
    const { engine } = await readServiceStatus(deps(async () => ({ ok: false, acceptsRuns: false, error: 'not started' })));
    expect(engine).toEqual({ state: 'unreachable', detail: 'Engine not ready: not started' });
  });

  it('treats a probe that throws as not ready', async () => {
    const { engine } = await readServiceStatus(
      deps(async () => {
        throw new Error('Invalid URL');
      })
    );
    expect(engine).toEqual({ state: 'unreachable', detail: 'Engine not ready: Invalid URL' });
  });

  it('includes Web UI status when provided', async () => {
    const { ui } = await readServiceStatus({
      ...deps(async () => ({ ok: true, acceptsRuns: true })),
      ui: () => ({
        source: 'cdn',
        version: '0.3.40',
        apiContract: 1,
        updatesEnabled: true,
        feedUrl: 'https://fox-ui.foxschema.workers.dev',
      }),
    });
    expect(ui).toMatchObject({ source: 'cdn', version: '0.3.40', apiContract: 1 });
  });
});
