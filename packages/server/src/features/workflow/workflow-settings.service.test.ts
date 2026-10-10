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
