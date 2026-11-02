/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { buildDbaUtilityQuery, TRACE_MAX_EVENTS, TRACE_MAX_MS, type UserSessionRow } from '@foxschema/sql';
import { SqlActivityFeed, type SqlActivity } from '../../platform/sql-activity/sql-activity';
import { LIVE_POLL_MIN_MS, MAX_TRACES_PER_OWNER, STOPPED_TRACE_KEEP_MS, SqlTraceService, type ProbeSessions } from './sql-trace.service';

const PG = { dialect: 'postgres', option: { host: 'db', password: 'pw' } };
const WS = 'w1';

function setup(probe?: ProbeSessions) {
  let clock = 1_000_000;
  const activity = new SqlActivityFeed();
  const probeSessions = vi.fn<ProbeSessions>(probe ?? (async () => ({ ok: true, sessions: [] })));
  const service = new SqlTraceService({ activity, probeSessions, now: () => clock });
  return {
    activity,
    probeSessions,
    service,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const ran = (text: string, extra: Partial<SqlActivity> = {}): SqlActivity => ({
  connectionId: 'c1',
  text,
  user: 'app',
  database: 'shop',
  durationMs: 4,
  rows: 1,
  error: null,
  at: new Date('2026-10-25T00:00:00Z'),
  ...extra,
});

const session = (sessionId: string, queryText: string, state = 'active'): UserSessionRow => ({
  sessionId,
  userName: 'app',
  clientHost: '10.0.0.5',
  databaseName: 'shop',
  state,
  waitEvent: null,
  queryText,
  connectedAt: null,
  applicationName: 'psql',
});

describe('SqlTraceService — Fox activity', () => {
  it('records statements Fox runs on the traced connection, redacted', async () => {
    const { activity, service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    activity.report(ran("ALTER USER app IDENTIFIED BY 'hunter2'"));
    activity.report(ran('SELECT 1', { connectionId: 'other' }));
    const { events } = await service.events('u1', WS, id, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, user: 'app', database: 'shop', client: 'Fox', rows: 1, source: 'fox' });
    expect(events[0]!.text).toBe("ALTER USER app IDENTIFIED BY '***'");
  });

  it('redacts an error that quotes the statement back', async () => {
    const { activity, service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    activity.report(ran('x', { error: "syntax error near PASSWORD 'hunter2'", rows: null }));
    const { events } = await service.events('u1', WS, id, 0);
    expect(events[0]!.error).not.toContain('hunter2');
  });

  it('returns only the events after the one asked for', async () => {
    const { activity, service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    for (const sql of ['SELECT 1', 'SELECT 2', 'SELECT 3']) activity.report(ran(sql));
    expect((await service.events('u1', WS, id, 2)).events.map((e) => e.text)).toEqual(['SELECT 3']);
  });

  it('stops listening when stopped', async () => {
    const { activity, service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    service.stop('u1', WS, id);
    expect(activity.watching('c1')).toBe(false);
    activity.report(ran('SELECT 1'));
    const page = await service.events('u1', WS, id, 0);
    expect(page.events).toEqual([]);
    expect(page.status).toMatchObject({ running: false, stopReason: 'stopped' });
  });
});

describe('SqlTraceService — bounds', () => {
  it('stops itself at the time box', async () => {
    const { activity, service, tick } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    tick(TRACE_MAX_MS);
    activity.report(ran('SELECT 1'));
    const page = await service.events('u1', WS, id, 0);
    expect(page.events).toEqual([]);
    expect(page.status).toMatchObject({ running: false, stopReason: 'time' });
    expect(activity.watching('c1')).toBe(false);
  });

  it('stops itself at the event cap', async () => {
    const { activity, service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    for (let i = 0; i < TRACE_MAX_EVENTS + 5; i++) activity.report(ran(`SELECT ${i}`));
    const page = await service.events('u1', WS, id, 0);
    expect(page.events).toHaveLength(TRACE_MAX_EVENTS);
    expect(page.status).toMatchObject({ running: false, stopReason: 'events' });
  });

  it('keeps one trace per person per connection', async () => {
    const { service } = setup();
    const first = service.start('u1', WS, 'c1', 'fox', null);
    service.start('u1', WS, 'c1', 'fox', null);
    expect((await service.events('u1', WS, first.id, 0)).status).toMatchObject({ running: false, stopReason: 'replaced' });
  });

  it('caps the traces one person runs at once', () => {
    const { service } = setup();
    for (let i = 0; i < MAX_TRACES_PER_OWNER; i++) service.start('u1', WS, `c${i}`, 'fox', null);
    expect(() => service.start('u1', WS, 'c-more', 'fox', null)).toThrow(/At most/);
    // Someone else is not held to u1's traces.
    expect(() => service.start('u2', WS, 'c-more', 'fox', null)).not.toThrow();
  });

  it('answers someone else’s trace as missing', async () => {
    const { service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    await expect(service.events('u2', WS, id, 0)).rejects.toMatchObject({ code: 'not_found' });
    expect(() => service.stop('u2', WS, id)).toThrow(/not found/);
  });

  it('forgets a stopped trace after a while', async () => {
    const { service, tick } = setup();
    const { id } = service.start('u1', WS, 'c1', 'fox', null);
    service.stop('u1', WS, id);
    tick(STOPPED_TRACE_KEEP_MS);
    await expect(service.events('u1', WS, id, 0)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('SqlTraceService — live', () => {
  const probeSql = (buildDbaUtilityQuery({ dialect: 'postgres', kind: 'sessions' }) as { sql: string }).sql;

  it('shows what is running at the start, not every idle session’s last statement', async () => {
    const { service } = setup(async () => ({
      ok: true,
      sessions: [session('1', 'SELECT * FROM orders'), session('2', 'SELECT now()', 'idle')],
    }));
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    const { events } = await service.events('u1', WS, id, 0);
    expect(events.map((e) => e.text)).toEqual(['SELECT * FROM orders']);
    expect(events[0]).toMatchObject({ sessionId: '1', user: 'app', client: 'psql', state: 'active', source: 'live' });
  });

  it('adds a statement once while it runs, and again when it comes back', async () => {
    const reads: UserSessionRow[][] = [
      [session('1', 'SELECT 1')],
      [session('1', 'SELECT 1'), session('2', 'UPDATE t SET a = 1', 'idle')],
      [],
      [session('1', 'SELECT 1')],
    ];
    const { service, tick } = setup(async () => ({ ok: true, sessions: reads.shift() ?? [] }));
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(...(await service.events('u1', WS, id, seen.length)).events.map((e) => `${e.sessionId}:${e.text}`));
      tick(LIVE_POLL_MIN_MS);
    }
    expect(seen).toEqual(['1:SELECT 1', '2:UPDATE t SET a = 1', '1:SELECT 1']);
  });

  it('leaves out its own probe', async () => {
    const { service } = setup(async () => ({ ok: true, sessions: [session('9', `  ${probeSql}  `)] }));
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    expect((await service.events('u1', WS, id, 0)).events).toEqual([]);
  });

  it('asks the engine at most once a second', async () => {
    const { probeSessions, service, tick } = setup();
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    await Promise.all([service.events('u1', WS, id, 0), service.events('u1', WS, id, 0)]);
    await service.events('u1', WS, id, 0);
    expect(probeSessions).toHaveBeenCalledTimes(1);
    tick(LIVE_POLL_MIN_MS);
    await service.events('u1', WS, id, 0);
    expect(probeSessions).toHaveBeenCalledTimes(2);
  });

  it('says why nothing arrives when the probe fails', async () => {
    const { service } = setup(async () => ({ ok: false, error: 'permission denied for pg_stat_activity' }));
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    expect((await service.events('u1', WS, id, 0)).status.error).toMatch(/permission denied/);
  });

  it('redacts what it reads', async () => {
    const { service } = setup(async () => ({ ok: true, sessions: [session('1', "CREATE ROLE r PASSWORD 'hunter2'")] }));
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    expect((await service.events('u1', WS, id, 0)).events[0]!.text).not.toContain('hunter2');
  });

  it('stops polling once stopped', async () => {
    const { probeSessions, service } = setup();
    const { id } = service.start('u1', WS, 'c1', 'live', PG);
    service.stop('u1', WS, id);
    await service.events('u1', WS, id, 0);
    expect(probeSessions).not.toHaveBeenCalled();
  });

  it('refuses a live trace without the connection', () => {
    expect(() => setup().service.start('u1', WS, 'c1', 'live', null)).toThrow(/needs the connection/);
  });
});
