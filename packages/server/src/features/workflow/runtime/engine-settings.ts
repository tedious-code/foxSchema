/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Keeps an engine process in step with the settings a workflow admin saves in
 * FoxSchema: whether it takes new runs, how many run at once, and where run
 * events are copied.
 *
 * Pulled, not pushed. FoxSchema stays the one place the settings live and never
 * needs to know where engines run, and an engine that restarts picks them up
 * by itself. Until the first answer arrives the engine keeps its defaults, and
 * a failed refresh keeps the last settings: FoxSchema restarting must not
 * re-enable a disabled engine or lift its limit.
 *
 * Settings apply per process: two processes that both execute runs each allow
 * `maxParallel` of them.
 */
import { dirname, join } from 'node:path';
import {
  ENGINE_STATES,
  WORKFLOW_ENGINE_CONFIG_PATH,
  foxSchemaEndpoint,
  type EngineRuntimeConfig,
} from '@foxschema/workflow-contract';
import { resolveDatabasePath, type LocalRunScheduler, type RunEvent } from '@foxschema/workflow-engine';
import { RunEventSinks } from './run-event-sinks.js';

/** How often the settings are read again. */
const REFRESH_MS = 30_000;
const KNOWN_STATES: ReadonlySet<string> = new Set(ENGINE_STATES);

export interface EngineConfigSyncOptions {
  scheduler: Pick<LocalRunScheduler, 'setAdmission'>;
  sinks: Pick<RunEventSinks, 'configure'>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
}

export class EngineConfigSync {
  private timer?: ReturnType<typeof setInterval>;
  private readonly endpoint: { url: string; token: string | undefined };

  constructor(private readonly options: EngineConfigSyncOptions) {
    this.endpoint = foxSchemaEndpoint(WORKFLOW_ENGINE_CONFIG_PATH, options.env ?? process.env);
  }

  /** False when there is no token, so no FoxSchema to ask; the engine keeps its defaults. */
  start(): boolean {
    if (!this.endpoint.token) return false;
    if (this.timer) return true;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fetch and apply the settings once. Resolves with what was applied, or undefined. */
  async refresh(): Promise<EngineRuntimeConfig | undefined> {
    try {
      const response = await (this.options.fetch ?? fetch)(this.endpoint.url, {
        headers: { accept: 'application/json', authorization: `Bearer ${this.endpoint.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`FoxSchema answered HTTP ${response.status}`);
      const config = (await response.json()) as EngineRuntimeConfig;
      if (!KNOWN_STATES.has(config.state)) throw new Error(`unknown engine state: ${String(config.state)}`);
      this.options.scheduler.setAdmission({ state: config.state, maxConcurrentRuns: config.maxParallel });
      this.options.sinks.configure(Array.isArray(config.sinks) ? config.sinks : []);
      return config;
    } catch (error) {
      (this.options.onError ?? console.warn)(
        `workflow engine settings not refreshed from FoxSchema: ${(error as Error).message}`,
      );
      return undefined;
    }
  }
}

/** Where file sinks write: WORKFLOW_LOG_DIR, else beside the engine database. */
export function logDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.WORKFLOW_LOG_DIR) return env.WORKFLOW_LOG_DIR;
  const database = resolveDatabasePath();
  if (database === ':memory:' || database.startsWith('file:')) return undefined;
  return join(dirname(database), 'workflow-logs');
}

/**
 * Settings sync and event sinks for one engine process — server, scheduler or
 * worker alike. Returns what stops them.
 */
export function attachEngineSettings(engine: {
  scheduler: Pick<LocalRunScheduler, 'setAdmission'>;
  onEvent: (listener: (event: RunEvent) => void) => () => void;
}): () => Promise<void> {
  const sinks = new RunEventSinks(logDirectory());
  const unsubscribe = engine.onEvent((event) => sinks.write(event));
  const sync = new EngineConfigSync({ scheduler: engine.scheduler, sinks });
  sync.start();
  return async () => {
    sync.stop();
    unsubscribe();
    await sinks.close();
  };
}
