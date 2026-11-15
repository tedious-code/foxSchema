/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine health as the control panel reports it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { markWorkflowEngineReady } from './runtime/engine-ready';
import { WorkflowSettingsService, defaultWorkflowEngineConfig } from './workflow-settings.service';

afterEach(() => {
  markWorkflowEngineReady(false);
});

describe('probeEngineHealth', () => {
  it('is healthy when the in-process engine is ready, with admission from the saved state', async () => {
    markWorkflowEngineReady(true);
    const stored = JSON.stringify({ state: 'enabled' });
    const service = new WorkflowSettingsService({
      get: async () => stored,
      set: async () => undefined,
    } as unknown as AppSettingsStore);

    await expect(service.probeEngineHealth()).resolves.toEqual({
      ok: true,
      acceptsRuns: true,
    });
  });

  it('does not report runs accepted while the saved state is draining', async () => {
    markWorkflowEngineReady(true);
    const service = new WorkflowSettingsService({
      get: async () => JSON.stringify({ state: 'draining' }),
      set: async () => undefined,
    } as unknown as AppSettingsStore);
    expect(await service.probeEngineHealth()).toMatchObject({ ok: true, acceptsRuns: false });
  });

  it('is not healthy before the engine starts', async () => {
    const service = new WorkflowSettingsService({
      get: async () => JSON.stringify({ state: 'enabled' }),
      set: async () => undefined,
    } as unknown as AppSettingsStore);
    expect(await service.probeEngineHealth()).toMatchObject({ ok: false, acceptsRuns: false });
  });
});

describe('defaultWorkflowEngineConfig', () => {
  it('defaults to enabled so a local install can run a workflow after npm run dev', () => {
    expect(defaultWorkflowEngineConfig().state).toBe('enabled');
    expect(defaultWorkflowEngineConfig().endpoint).toBe('');
  });
});

describe('readConfig', () => {
  it('drops a saved remote engine URL; the engine is in-process', async () => {
    const service = new WorkflowSettingsService({
      get: async () => JSON.stringify({ state: 'draining', endpoint: 'http://attacker.test', processes: [{ id: 'x' }] }),
      set: async () => undefined,
    } as unknown as AppSettingsStore);
    const config = await service.getConfig();
    expect(config.state).toBe('draining');
    expect(config.endpoint).toBe('');
    expect(config.processes).toEqual([]);
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

  it('reads the store once for a burst of calls', async () => {
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

  it('does not persist an endpoint: the engine is in-process', async () => {
    const { service } = counting();
    await service.putConfig({ endpoint: 'http://attacker.test', state: 'draining' });
    expect((await service.getConfig()).endpoint).toBe('');
    expect((await service.getConfig()).state).toBe('draining');
  });
});
