/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (lib/triggers.ts).
 */
// From the contract, not the engine's definitions: those build zod and ajv
// validators as they load, 300 kB the designer does not otherwise need.
import { TRIGGER_KINDS, type TriggerKind } from '@foxschema/shared';
import type { CredentialMeta } from '../api/engineClient';
import type { HttpRequestValue } from '../components/HttpRequestEditor';

/**
 * The workflow trigger model the designer edits: the discriminated union, the
 * defaults a new trigger starts from, and the rules every trigger editor
 * shares.
 *
 * It used to live in `components/TriggerSettings.tsx`, beside a component
 * nothing rendered. The two editors that are rendered — the Triggers dialog and
 * the inspector's inline settings — each re-implemented parts of it, and had
 * already drifted: they filtered credentials differently.
 */

type CommonTrigger = { id: string; enabled: boolean };

/** What happens when a trigger fires while a run is still going. */
export type OverlapPolicy = 'skip' | 'queue' | 'parallel';

export interface CronRetryConfig {
  maxRetryAttempts: number;
  maxRetryDuration: string;
  minBackoffDuration: string;
  maxBackoffDuration: string;
  maxDoublings: number;
}

export function createCronRetryConfig(): CronRetryConfig {
  return {
    maxRetryAttempts: 0,
    maxRetryDuration: '0s',
    minBackoffDuration: '5s',
    maxBackoffDuration: '1h',
    maxDoublings: 5,
  };
}

/** How a webhook caller proves it may start the run. Mirrors the engine's `webhookAuthSchema`. */
export type WebhookAuthValue =
  | { type: 'none'; acknowledgeUnauthenticated: true }
  | {
      type: 'signature';
      credentialId: string;
      signatureHeader: string;
      timestampHeader: string;
      maxAgeSeconds: number;
    }
  | { type: 'basic'; credentialId: string }
  | { type: 'header'; credentialId: string; header: string }
  | {
      type: 'jwt';
      credentialId: string;
      header: string;
      algorithms: ('HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512')[];
      issuer?: string;
      audience?: string;
      clockToleranceSeconds: number;
    };

/**
 * What a Schedule trigger in SQL mode runs. Mirrors the engine's
 * `cronSqlSchema`: the script runs against a database credential (or a saved
 * FoxSchema connection granted to workflows) and its rows start the run.
 */
export interface CronSqlValue {
  credentialId: string;
  /** Only for a credential entered in the engine; a saved connection already says. */
  dialect?: string;
  schema?: string;
  script: string;
  /** Skip the run when the script returns no rows. */
  onlyWhenRows: boolean;
  transaction: boolean;
  maxRows: number;
}

export function createCronSql(): CronSqlValue {
  return {
    credentialId: '',
    script: '',
    onlyWhenRows: true,
    transaction: false,
    maxRows: 1000,
  };
}

export type CronExecutionType = 'workflow' | 'http' | 'sql';

export type WorkflowTrigger =
  | (CommonTrigger & { kind: 'manual'; inputData?: unknown })
  | (CommonTrigger & {
      kind: 'cron';
      cron: string;
      timezone: string;
      catchUp: 'none' | 'one' | 'all';
      executionType: CronExecutionType;
      /** Same shape as `source.api.http` — required when executionType is http. */
      http?: HttpRequestValue;
      /** Required when executionType is sql. */
      sql?: CronSqlValue;
      retryConfig?: CronRetryConfig;
    })
  | (CommonTrigger & {
      kind: 'webhook';
      auth: WebhookAuthValue;
      methods: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
      /** Vanity path served at /api/hooks/<path>. */
      path?: string;
      idempotencyHeader: string;
      onMissingIdempotencyKey: 'reject' | 'fingerprint';
      maxBodyBytes: number;
    })
  | (CommonTrigger & {
      kind: 'parent';
      /** Empty = any parent workflow may call via workflow.sub. */
      allowFrom: string[];
    });

/**
 * The kinds a trigger may have — **re-exported from the engine, never restated**.
 *
 * This list used to be a hand-maintained copy here, and it drifted: it kept
 * offering `event` and `custom` after the engine deleted both, so the designer
 * rendered a picker with two kinds the engine's schema rejects, and this
 * module's own test iterated the wrong list and passed. The engine guards its
 * copy with a compile-time assertion (`common/definitions/workflow.ts`); the
 * assertion below extends that guarantee to the designer's union, so adding or
 * removing a kind on either side fails to compile until both agree.
 */
export { TRIGGER_KINDS, type TriggerKind };

type AssertDesignerKindsMatchEngine = [WorkflowTrigger['kind']] extends [TriggerKind]
  ? [TriggerKind] extends [WorkflowTrigger['kind']]
    ? true
    : ['the engine has a trigger kind WorkflowTrigger is missing']
  : ['WorkflowTrigger has a kind the engine schema rejects'];
const _assertDesignerKindsMatchEngine: AssertDesignerKindsMatchEngine = true;
void _assertDesignerKindsMatchEngine;

export function createTrigger(
  kind: WorkflowTrigger['kind'],
  id: string,
): WorkflowTrigger {
  const common = { id, enabled: true };
  switch (kind) {
    case 'manual':
      return { ...common, kind };
    case 'cron':
      return {
        ...common,
        kind,
        cron: '0 * * * *',
        timezone: 'UTC',
        catchUp: 'none',
        executionType: 'workflow',
      };
    case 'webhook':
      return {
        ...common,
        kind,
        // Signature is the strongest option and the historical default, so a
        // new webhook starts there rather than at the one that needs no setup.
        // The header names are wire protocol the engine verifies — not branding
        // for a rename to reach.
        auth: {
          type: 'signature',
          credentialId: '',
          signatureHeader: 'x-foxflow-signature',
          timestampHeader: 'x-foxflow-timestamp',
          maxAgeSeconds: 300,
        },
        methods: ['POST'],
        idempotencyHeader: 'x-idempotency-key',
        onMissingIdempotencyKey: 'reject',
        maxBodyBytes: 1_048_576,
      };
    case 'parent':
      return { ...common, kind, allowFrom: [] };
  }
}

/**
 * A Schedule trigger switched to another execution type. Switching to `http`
 * or `sql` seeds that mode's settings the first time; switching away keeps
 * them, so flipping back and forth does not lose a half-written script.
 */
export function withExecutionType(
  trigger: Extract<WorkflowTrigger, { kind: 'cron' }>,
  executionType: CronExecutionType,
  emptyHttp: HttpRequestValue,
): Extract<WorkflowTrigger, { kind: 'cron' }> {
  return {
    ...trigger,
    executionType,
    ...(executionType === 'http' ? { http: trigger.http ?? emptyHttp } : {}),
    ...(executionType === 'sql' ? { sql: trigger.sql ?? createCronSql() } : {}),
  };
}

/**
 * Trigger kinds the engine no longer has. A workflow saved while they existed
 * still holds them; the designer drops them on load (and says so) rather than
 * render a trigger it has no editor for and the engine would refuse to save.
 */
export function partitionRetiredTriggers(triggers: readonly { kind: string }[]): {
  supported: WorkflowTrigger[];
  retired: string[];
} {
  const known = new Set<string>(TRIGGER_KINDS);
  const supported: WorkflowTrigger[] = [];
  const retired: string[] = [];
  for (const trigger of triggers) {
    if (known.has(trigger.kind)) supported.push(trigger as WorkflowTrigger);
    else retired.push(trigger.kind);
  }
  return { supported, retired };
}

/**
 * The credential a trigger authenticates with: `webhook` keeps it inside
 * `auth`, and `auth: none` has none.
 */
export function triggerCredentialId(trigger: WorkflowTrigger): string {
  if (trigger.kind !== 'webhook') return '';
  return trigger.auth.type === 'none' ? '' : trigger.auth.credentialId;
}

/** `trigger` with its credential set; unchanged for kinds (or `auth: none`) that take none. */
export function withTriggerCredentialId(trigger: WorkflowTrigger, credentialId: string): WorkflowTrigger {
  if (trigger.kind !== 'webhook' || trigger.auth.type === 'none') return trigger;
  return { ...trigger, auth: { ...trigger.auth, credentialId } };
}

/** First free id of the form `kind`, `kind-2`, `kind-3`, … */
export function nextTriggerId(
  triggers: readonly { id: string }[],
  kind: WorkflowTrigger['kind'],
): string {
  const taken = new Set(triggers.map((trigger) => trigger.id));
  if (!taken.has(kind)) return kind;
  let suffix = 2;
  while (taken.has(`${kind}-${suffix}`)) suffix += 1;
  return `${kind}-${suffix}`;
}

/**
 * Credentials a webhook can authenticate with — webhook credentials only,
 * because that is the rule the runtime enforces (`authenticateHttpTrigger`
 * rejects any other kind).
 *
 * Both editors once had this wrong, in different ways: the Triggers dialog
 * listed every credential, and the inspector offered OAuth credentials to
 * endpoint triggers. Either let an author save a trigger that then failed on
 * every request.
 */
export function credentialsForTrigger(
  kind: 'webhook',
  credentials: CredentialMeta[],
): CredentialMeta[] {
  return credentials.filter((credential) => credential.kind === kind);
}
