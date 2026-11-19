/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Process-wide engine boot: a bad key must not take down the API, and a saved
 * disabled state must be applied before recover/cron can run.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeatureContext } from '../../../app/feature-registry';
import { AppSettingsStore } from '../../../platform/settings/app-settings.service';
import { workflowFeature } from '../index';
import { WORKFLOW_ENGINE_CONFIG_KEY } from '../workflow-settings.service';
import {
  getProductionWorkflowEngine,
  startProductionWorkflowEngine,
  stopProductionWorkflowEngine,
} from './engine-host';

const MINIMAL = {
  id: 'wf-host',
  name: 'wf-host',
  version: 1,
  onOverlap: 'parallel',
  triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
  pipelines: [],
} as never;

async function dropHost(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (!getProductionWorkflowEngine()) return;
    await stopProductionWorkflowEngine();
  }
}

describe('production workflow engine host', () => {
  afterEach(async () => {
    await dropHost();
  });

  it('throws on an encryption key that is not 32 bytes', async () => {
    await dropHost();
    const previous = process.env.FOXFLOW_ENCRYPTION_KEY;
    process.env.FOXFLOW_ENCRYPTION_KEY = 'not-a-key';
    try {
      await expect(startProductionWorkflowEngine()).rejects.toThrow(/32 bytes/);
    } finally {
      process.env.FOXFLOW_ENCRYPTION_KEY = previous;
    }
  });

  it('leaves the API up when registerFastify cannot start the engine', async () => {
    await dropHost();
    const previous = process.env.FOXFLOW_ENCRYPTION_KEY;
    process.env.FOXFLOW_ENCRYPTION_KEY = 'not-a-key';
    const app = Fastify();
    try {
      await expect(
        workflowFeature.registerFastify?.(app, createFeatureContext()),
      ).resolves.toBeUndefined();
    } finally {
      process.env.FOXFLOW_ENCRYPTION_KEY = previous;
      await app.close();
    }
  });

  it('applies a stored disabled state before returning', async () => {
    await dropHost();
    const settings = new AppSettingsStore();
    const previous = await settings.get(WORKFLOW_ENGINE_CONFIG_KEY);
    await settings.set(WORKFLOW_ENGINE_CONFIG_KEY, JSON.stringify({ state: 'disabled', maxParallel: 1 }));
    try {
      const host = await startProductionWorkflowEngine();
      expect(host.backend.mode).toBe('sandbox');
      expect(host.backend.pid).toBeDefined();
      expect(host.backend.pid).not.toBe(process.pid);
      const result = await host.backend.enqueueWorkflow(MINIMAL);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('disabled');
    } finally {
      if (previous === undefined) {
        await settings.set(WORKFLOW_ENGINE_CONFIG_KEY, JSON.stringify({ state: 'enabled' }));
      } else {
        await settings.set(WORKFLOW_ENGINE_CONFIG_KEY, previous);
      }
    }
  });
});
