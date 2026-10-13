/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine health as the control panel reports it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEngineConfig } from '@foxschema/workflow-contract';
import type { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { WorkflowSettingsService } from './workflow-settings.service';

function serviceWith(state: WorkflowEngineConfig['state'], respond: () => Response) {
  const stored = JSON.stringify({ state, endpoint: 'http://engine.test:8081/' });
  const appSettings = { get: async () => stored, set: async () => undefined } as unknown as AppSettingsStore;
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal('fetch', fetchMock);
  return { service: new WorkflowSettingsService(appSettings), fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeEngineHealth', () => {
  it('reads the engine’s { ok: true } as healthy, with admission from the saved state', async () => {
    const { service, fetchMock } = serviceWith('enabled', () => Response.json({ ok: true, service: 'workflow-server' }));

    await expect(service.probeEngineHealth()).resolves.toEqual({
      ok: true,
      acceptsRuns: true,
      version: undefined,
      endpoint: 'http://engine.test:8081',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://engine.test:8081/health', expect.anything());
  });

  it('does not report runs accepted while the saved state is draining', async () => {
    const { service } = serviceWith('draining', () => Response.json({ ok: true }));

    expect(await service.probeEngineHealth()).toMatchObject({ ok: true, acceptsRuns: false });
  });

  it('ignores an acceptsRuns the engine sends — admission is the control plane’s', async () => {
    const { service } = serviceWith('disabled', () => Response.json({ ok: true, acceptsRuns: true, version: '1.2.0' }));

    expect(await service.probeEngineHealth()).toMatchObject({ ok: true, acceptsRuns: false, version: '1.2.0' });
  });

  it.each([
    ['a body without ok: true', () => Response.json({ status: 'ok' })],
    ['an empty body object', () => Response.json({})],
  ])('is not healthy on %s', async (_label, respond) => {
    const { service } = serviceWith('enabled', respond);

    expect((await service.probeEngineHealth()).ok).toBe(false);
  });

  it('is not healthy on an HTTP error', async () => {
    const { service } = serviceWith('enabled', () => new Response('boom', { status: 500 }));

    expect(await service.probeEngineHealth()).toMatchObject({ ok: false, acceptsRuns: false, error: 'HTTP 500' });
  });
});

describe('getConfig', () => {
  function counting() {
    let stored = JSON.stringify({ state: 'enabled', maxParallel: 2 });
    const get = vi.fn(async () => stored);
    const appSettings = {
      get,
      set: async (_key: string, value: string) => {
        stored = value;
      },
    } as unknown as AppSettingsStore;
    return { service: new WorkflowSettingsService(appSettings), get };
  }

  it('reads the store once for a burst of calls, as every proxied engine call asks', async () => {
    const { service, get } = counting();
    for (let i = 0; i < 5; i++) await service.getConfig();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('sees its own save at once, not after the cache expires', async () => {
    const { service } = counting();
    await service.getConfig();
    await service.putConfig({ state: 'draining' });
    expect((await service.getConfig()).state).toBe('draining');
  });

  it('hands out copies, so a caller changing one cannot change the next', async () => {
    const { service } = counting();
    const first = await service.getConfig();
    first.maxParallel = 99;
    first.sinks.push({ kind: 'json', enabled: true });
    const second = await service.getConfig();
    expect(second.maxParallel).toBe(2);
    expect(second.sinks).toHaveLength(3);
  });
});

describe('probeEngineHealth reads the endpoint as the proxy does', () => {
  it('refuses a non-http endpoint without fetching it', async () => {
    const appSettings = {
      get: async () => JSON.stringify({ state: 'enabled', endpoint: 'file:///etc/passwd' }),
      set: async () => undefined,
    } as unknown as AppSettingsStore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const health = await new WorkflowSettingsService(appSettings).probeEngineHealth();
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/http or https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes the address the proxy forwards to: every trailing slash and the query dropped', async () => {
    const appSettings = {
      get: async () => JSON.stringify({ state: 'enabled', endpoint: 'http://engine.test:8081/base//?x=1' }),
      set: async () => undefined,
    } as unknown as AppSettingsStore;
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await new WorkflowSettingsService(appSettings).probeEngineHealth();
    expect(fetchMock).toHaveBeenCalledWith('http://engine.test:8081/base/health', expect.anything());
  });
});
