/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Keeps the in-process engine in step with the settings a workflow admin
 * saves: whether it takes new runs, how many run at once, and where run
 * events are copied.
 *
 * Until the first answer arrives the engine keeps its defaults, and a failed
 * refresh keeps the last settings: a settings-store blip must not re-enable a
 * disabled engine or lift its limit.
 */
import { dirname, join } from 'node:path';
import { ENGINE_STATES, type EngineRuntimeConfig } from '@foxschema/workflow-contract';
import { resolveDatabasePath, type LocalRunScheduler, type RunEvent } from '@foxschema/workflow-engine';
import { RunEventSinks } from './run-event-sinks.js';

/** How often the settings are read again. */
const REFRESH_MS = 30_000;
const KNOWN_STATES: ReadonlySet<string> = new Set(ENGINE_STATES);

export interface EngineConfigSyncOptions {
  scheduler: Pick<LocalRunScheduler, 'setAdmission'>;
  sinks: Pick<RunEventSinks, 'configure'>;
  load: () => Promise<EngineRuntimeConfig>;
  onError?: (message: string) => void;
}

export class EngineConfigSync {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: EngineConfigSyncOptions) {}

  start(): boolean {
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

  /** Apply the settings once. Resolves with what was applied, or undefined. */
  async refresh(): Promise<EngineRuntimeConfig | undefined> {
    try {
      const config = await this.options.load();
      if (!KNOWN_STATES.has(config.state)) throw new Error(`unknown engine state: ${String(config.state)}`);
      this.options.scheduler.setAdmission({ state: config.state, maxConcurrentRuns: config.maxParallel });
      this.options.sinks.configure(Array.isArray(config.sinks) ? config.sinks : []);
      return config;
    } catch (error) {
      (this.options.onError ?? console.warn)(
        `workflow engine settings not refreshed: ${(error as Error).message}`,
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
 * Settings sync and event sinks for the in-process engine. Returns what stops them.
 */
export function attachEngineSettings(
  engine: {
    scheduler: Pick<LocalRunScheduler, 'setAdmission'>;
    onEvent: (listener: (event: RunEvent) => void) => () => void;
  },
  load: () => Promise<EngineRuntimeConfig>,
): () => Promise<void> {
  const sinks = new RunEventSinks(logDirectory());
  const unsubscribe = engine.onEvent((event) => sinks.write(event));
  const sync = new EngineConfigSync({ scheduler: engine.scheduler, sinks, load });
  sync.start();
  return async () => {
    sync.stop();
    unsubscribe();
    await sinks.close();
  };
}
