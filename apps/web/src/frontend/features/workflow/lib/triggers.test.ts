/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (lib/triggers.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { TRIGGER_KINDS as ENGINE_TRIGGER_KINDS } from '@foxschema/workflow-engine/definitions';
import type { CredentialMeta } from '../api/engineClient';
import {
  TRIGGER_KINDS,
  createCronSql,
  createTrigger,
  credentialsForTrigger,
  nextTriggerId,
  partitionRetiredTriggers,
  triggerCredentialId,
  withExecutionType,
  withTriggerCredentialId,
  type WorkflowTrigger,
} from './triggers';
import type { HttpRequestValue } from '../components/HttpRequestEditor';

describe('nextTriggerId', () => {
  it('uses the bare kind when it is free', () => {
    expect(nextTriggerId([], 'cron')).toBe('cron');
  });

  it('suffixes from 2 when the bare kind is taken', () => {
    expect(nextTriggerId([{ id: 'cron' }], 'cron')).toBe('cron-2');
  });

  it('skips every suffix already in use', () => {
    expect(
      nextTriggerId([{ id: 'cron' }, { id: 'cron-2' }, { id: 'cron-3' }], 'cron'),
    ).toBe('cron-4');
  });

  it('is not confused by ids belonging to other kinds', () => {
    expect(nextTriggerId([{ id: 'manual' }, { id: 'manual-2' }], 'cron')).toBe(
      'cron',
    );
  });
});

describe('the designer offers exactly the kinds the engine accepts', () => {
  /**
   * This suite exists because it used to pass while being wrong. `TRIGGER_KINDS`
   * was a hand-maintained copy in `triggers.ts` that still listed `event` and
   * `custom` after the engine deleted them, and the loop below iterated that
   * copy — so it happily asserted that the designer could build two kinds the
   * engine's schema rejects. A designer picking either produced a workflow that
   * failed on save.
   *
   * `TRIGGER_KINDS` is now re-exported from the engine, and `triggers.ts`
   * carries a compile-time assertion tying `WorkflowTrigger['kind']` to it.
   * This is the runtime half: it fails if the re-export is ever replaced by a
   * local array again.
   */
  it('re-exports the engine list rather than restating it', () => {
    expect([...TRIGGER_KINDS]).toEqual([...ENGINE_TRIGGER_KINDS]);
  });

  it('does not offer the kinds the engine removed', () => {
    expect(TRIGGER_KINDS).not.toContain('event');
    expect(TRIGGER_KINDS).not.toContain('custom');
    // API endpoint and API polling were retired: a Webhook trigger serves
    // inbound calls, and a SQL schedule watches a database.
    expect(TRIGGER_KINDS).not.toContain('http');
    expect(TRIGGER_KINDS).not.toContain('poll');
  });

  it('can construct every kind the engine accepts', () => {
    for (const kind of ENGINE_TRIGGER_KINDS) {
      expect(createTrigger(kind, kind).kind).toBe(kind);
    }
  });
});

describe('createTrigger', () => {
  it('builds every kind enabled, under the id it was given', () => {
    for (const kind of TRIGGER_KINDS) {
      expect(createTrigger(kind, `${kind}-x`)).toMatchObject({
        id: `${kind}-x`,
        kind,
        enabled: true,
      });
    }
  });

  it('starts a webhook on signature auth, POST only, with the header names the engine verifies', () => {
    // The header names are wire protocol. A project-wide rename sweep must not
    // touch them, or every signed webhook starts failing verification.
    expect(createTrigger('webhook', 'hook')).toMatchObject({
      auth: {
        type: 'signature',
        credentialId: '',
        signatureHeader: 'x-foxflow-signature',
        timestampHeader: 'x-foxflow-timestamp',
      },
      methods: ['POST'],
      onMissingIdempotencyKey: 'reject',
    });
  });
});

describe('trigger credentials', () => {
  const webhook = createTrigger('webhook', 'hook');

  it('reads and writes a webhook’s credential inside auth', () => {
    const next = withTriggerCredentialId(webhook, 'cred-hook');
    expect(next).toMatchObject({ auth: { type: 'signature', credentialId: 'cred-hook' } });
    expect(next).not.toHaveProperty('credentialId');
    expect(triggerCredentialId(next)).toBe('cred-hook');
  });

  it('gives an unauthenticated webhook no credential to set', () => {
    const open = {
      ...webhook,
      auth: { type: 'none', acknowledgeUnauthenticated: true },
    } as WorkflowTrigger;
    expect(triggerCredentialId(open)).toBe('');
    expect(withTriggerCredentialId(open, 'cred-hook')).toBe(open);
  });

  it('gives kinds without authentication no credential', () => {
    const cron = createTrigger('cron', 'nightly');
    expect(triggerCredentialId(cron)).toBe('');
    expect(withTriggerCredentialId(cron, 'cred-x')).toBe(cron);
  });
});

describe('credentialsForTrigger', () => {
  const credentials: CredentialMeta[] = (
    ['webhook', 'http', 'oauth', 'database', 'llm'] as const
  ).map((kind) => ({
    id: `cred-${kind}`,
    name: kind,
    kind,
    source: 'local',
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
  }));

  it('offers a webhook only webhook secrets', () => {
    expect(credentialsForTrigger('webhook', credentials).map((c) => c.kind)).toEqual(
      ['webhook'],
    );
  });
});

describe('Schedule execution type', () => {
  const emptyHttp = { url: '' } as HttpRequestValue;
  const cron = createTrigger('cron', 'nightly') as Extract<WorkflowTrigger, { kind: 'cron' }>;

  it('starts a new schedule as "run this workflow", with no SQL settings', () => {
    expect(cron.executionType).toBe('workflow');
    expect(cron).not.toHaveProperty('sql');
  });

  it('seeds the SQL settings the first time SQL execute is chosen', () => {
    const next = withExecutionType(cron, 'sql', emptyHttp);
    expect(next.executionType).toBe('sql');
    expect(next.sql).toEqual(createCronSql());
    // Rows-only is the default: an idle tick should leave no run behind.
    expect(next.sql?.onlyWhenRows).toBe(true);
    expect(next.sql?.credentialId).toBe('');
  });

  it('keeps a half-written script when switching away and back', () => {
    const withScript = {
      ...withExecutionType(cron, 'sql', emptyHttp),
      sql: { ...createCronSql(), credentialId: 'foxschema-conn-1', script: 'SELECT 1' },
    };
    const away = withExecutionType(withScript, 'workflow', emptyHttp);
    expect(away.executionType).toBe('workflow');
    const back = withExecutionType(away, 'sql', emptyHttp);
    expect(back.sql).toMatchObject({ credentialId: 'foxschema-conn-1', script: 'SELECT 1' });
  });

  it('seeds the HTTP request when Call an HTTP endpoint is chosen', () => {
    expect(withExecutionType(cron, 'http', emptyHttp).http).toBe(emptyHttp);
  });
});

describe('partitionRetiredTriggers', () => {
  it('keeps the kinds the engine accepts and names the retired ones', () => {
    // As a workflow saved before the two kinds were retired holds them.
    const stored = [
      { id: 'manual', kind: 'manual', enabled: true },
      { id: 'api', kind: 'http', enabled: true },
      { id: 'poll', kind: 'poll', enabled: true },
      { id: 'nightly', kind: 'cron', enabled: true },
    ];
    const { supported, retired } = partitionRetiredTriggers(stored);
    expect(supported.map((trigger) => trigger.kind)).toEqual(['manual', 'cron']);
    expect(retired).toEqual(['http', 'poll']);
  });

  it('reports nothing retired for a current workflow', () => {
    expect(partitionRetiredTriggers([createTrigger('webhook', 'hook')]).retired).toEqual([]);
  });
});
