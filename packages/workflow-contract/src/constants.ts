/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** Implicit community workspace id (single-tenant desktop / local install). */
export const COMMUNITY_WORKSPACE_ID = 'local';

/**
 * Env var holding the service token FoxSchema and the workflow engine share.
 * Set the same value on both processes: the proxy presents it to the engine,
 * and the engine presents it back when it resolves a saved connection.
 */
export const WORKFLOW_ENGINE_TOKEN_ENV = 'WORKFLOW_ENGINE_TOKEN';

/** FoxSchema routes only the workflow engine calls. Not behind a user session. */
export const WORKFLOW_INTERNAL_PREFIX = '/api/workflow-internal';

/** Where the engine resolves a saved connection a user granted to workflows. */
export const WORKFLOW_CONNECTION_RESOLVE_PATH = `${WORKFLOW_INTERNAL_PREFIX}/connections/resolve`;

/** Where the engine reads the settings a workflow admin saved in FoxSchema. */
export const WORKFLOW_ENGINE_CONFIG_PATH = `${WORKFLOW_INTERNAL_PREFIX}/engine-config`;

/** Env var that tells the engine where FoxSchema's API is. */
export const FOXSCHEMA_URL_ENV = 'FOXSCHEMA_URL';

/** FoxSchema's API on its default port, when {@link FOXSCHEMA_URL_ENV} is not set. */
export const DEFAULT_FOXSCHEMA_URL = 'http://127.0.0.1:3210';

/** Prefix of the engine credential ids reserved for linked saved connections. */
export const LINKED_CONNECTION_PREFIX = 'foxschema-';

/**
 * The engine credential a granted saved connection is known by. Derived rather
 * than stored, so FoxSchema and the designer agree on it without a lookup. The
 * engine refuses the prefix for any other credential, so the id is a reliable tag.
 */
export function connectionCredentialId(connectionId: string): string {
  return `${LINKED_CONNECTION_PREFIX}${connectionId}`;
}

/** The saved connection a credential id points at, when it is a linked one. */
export function linkedConnectionId(credentialId: string | undefined): string | undefined {
  return credentialId?.startsWith(LINKED_CONNECTION_PREFIX)
    ? credentialId.slice(LINKED_CONNECTION_PREFIX.length)
    : undefined;
}

/**
 * A FoxSchema internal endpoint as the engine calls it: the URL under
 * FOXSCHEMA_URL (or the default) and the service token to present.
 */
export function foxSchemaEndpoint(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): { url: string; token: string | undefined } {
  const base = (env[FOXSCHEMA_URL_ENV] || DEFAULT_FOXSCHEMA_URL).replace(/\/+$/, '');
  return { url: `${base}${path}`, token: env[WORKFLOW_ENGINE_TOKEN_ENV] || undefined };
}

/** The SSE event that tells a run-event stream's client the run is over and the stream is closing. */
export const RUN_STREAM_END_EVENT = 'end';

/**
 * The kinds of trigger a workflow can have. The engine's trigger schema fails to
 * compile unless it accepts exactly these. Defined here rather than in the
 * engine so the designer can list them without loading the engine's validators.
 */
export const TRIGGER_KINDS = ['manual', 'cron', 'webhook', 'http', 'poll', 'parent'] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Run states a run never leaves. `paused` and `interrupted` can still resume. */
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}
