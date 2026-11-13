/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The engine every role of this process runs (server, scheduler, worker), and
 * the services routes are built on.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CronCoordinator,
  Engine,
  LocalRunScheduler,
  MiddlewareRegistry,
  PollCoordinator,
  loadPipePlugin,
  parseAllowlist,
  type CheckpointStore,
  type CredentialStore,
  type EngineOptions,
  type EnvironmentStore,
  type EventStore,
  type HumanInputStore,
  type PipeRegistry,
  type RunStore,
  type TriggerScheduleStore,
  type VariableStore,
  type WorkflowStore,
} from '@foxschema/workflow-engine';
import { createSqlProbe } from './sql-probe.js';

/**
 * Process-wide durable services shared by routes and the local runtime.
 * Built on the Engine facade; cron coordination stays at the app layer.
 */
export interface AppContext {
  credentials: CredentialStore;
  workflows: WorkflowStore;
  runs: RunStore;
  events: EventStore;
  checkpoints: CheckpointStore;
  schedules: TriggerScheduleStore;
  environments: EnvironmentStore;
  variables: VariableStore;
  humanInputs: HumanInputStore;
  registry: PipeRegistry;
  middleware: MiddlewareRegistry;
  scheduler: LocalRunScheduler;
  cron: CronCoordinator;
  poll: PollCoordinator;
  /** Be told of each run event once it is stored. */
  onEvent: Engine['onEvent'];
  close: () => void;
}

/**
 * The engine with this app's SQL probe for trigger conditions. Every role
 * builds its engine here, so a run behaves the same whichever process starts it.
 */
export function createEngine(options: Omit<EngineOptions, 'sql'> = {}): Engine {
  // Built on first use: the probe needs the engine's credential store, which
  // does not exist until the engine does. Conditions are evaluated long after
  // construction, so the closure is safe.
  let sqlProbe: ReturnType<typeof createSqlProbe> | undefined;
  const engine = new Engine({
    ...options,
    sql: (input) => {
      sqlProbe ??= createSqlProbe(engine.stores.credentials);
      return sqlProbe(input);
    },
  });
  return engine;
}

/** Cron and poll admission for an engine's workflows. */
export function createTriggerCoordinators(engine: Engine): { cron: CronCoordinator; poll: PollCoordinator } {
  const options = {
    workflows: engine.stores.workflows,
    schedules: engine.stores.schedules,
    scheduler: engine.scheduler,
    credentials: engine.stores.credentials,
  };
  return { cron: new CronCoordinator(options), poll: new PollCoordinator(options) };
}

export function createContext(options: Pick<EngineOptions, 'databasePath' | 'encryptionKey'> = {}): AppContext {
  // Unset options are intentional: Engine applies the database-path and key
  // defaults, so every process lands on the same file.
  const engine = createEngine(options);
  return {
    ...engine.stores,
    registry: engine.registry,
    middleware: engine.middleware,
    scheduler: engine.scheduler,
    ...createTriggerCoordinators(engine),
    onEvent: (listener) => engine.onEvent(listener),
    close: () => engine.close(),
  };
}

/**
 * Load local plugin packages from FOXFLOW_PLUGINS_DIR (one package per
 * subdirectory), subject to `FOXFLOW_PLUGINS_ALLOWLIST`.
 *
 * The directory is scanned, but nothing in it is imported unless an operator
 * named it. Without that, dropping a folder here is arbitrary code execution at
 * API startup — earlier than every other boundary in the engine, because a
 * module body runs on import, before any pipe executes.
 *
 * A plugin that is present but unapproved is reported, not fatal: one
 * unreviewed folder should not stop an installation from booting, and a silent
 * skip is how an operator ends up wondering where their pipe went.
 */
export async function loadConfiguredPlugins(
  registry: PipeRegistry,
  logger: { warn?: (message: string) => void } = console,
): Promise<string[]> {
  const root = process.env.FOXFLOW_PLUGINS_DIR;
  if (!root) return [];
  const allowlist = parseAllowlist(process.env.FOXFLOW_PLUGINS_ALLOWLIST);
  const loaded: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator-set FOXFLOW_PLUGINS_DIR; nothing in it is imported unless allowlisted
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await loadPipePlugin(join(root, entry.name), registry, {
        allowlist,
      });
      loaded.push(`${manifest.name}@${manifest.version}`);
    } catch (error) {
      logger.warn?.(
        `[plugins] skipped ${entry.name}: ${(error as Error).message}`,
      );
    }
  }
  return loaded;
}
