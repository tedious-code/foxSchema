/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How a generated GRANT / REVOKE script is cut into statements.
 *
 * Both cases here are ones a `split(/;\s*(?:\n+|$)/)` gets wrong, and both are
 * shapes an emitter or a real identifier produces — a one-line pair, and a
 * semicolon living inside quotes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAccessSql } from './accessSql';

const executeSql = vi.hoisted(() => vi.fn());
vi.mock('./sqlApi', () => ({ executeSql }));

const ref = { connectionId: 'c1' };
const sent = () => executeSql.mock.calls[0]![1] as string[];

describe('runAccessSql', () => {
  beforeEach(() => {
    executeSql.mockReset();
    executeSql.mockResolvedValue({ results: [{ ok: true }] });
  });

  it('splits a pair written on one line', async () => {
    // Emitters join with '; ' as often as with a newline; a splitter that
    // needs the newline sends both as one statement and the driver rejects it.
    await runAccessSql(ref, 'GRANT USAGE ON SCHEMA app TO r; GRANT SELECT ON ALL TABLES IN SCHEMA app TO r;');
    expect(sent()).toEqual([
      'GRANT USAGE ON SCHEMA app TO r;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA app TO r;',
    ]);
  });

  it('keeps a semicolon that is inside quotes', async () => {
    // The identifier is the object being granted on. Cutting it in half sends
    // two statements that are each invalid, against an object that exists.
    await runAccessSql(ref, `GRANT SELECT ON "audit;2024" TO app;`);
    expect(sent()).toEqual([`GRANT SELECT ON "audit;2024" TO app;`]);
  });

  it('splits a multi-line script and drops blank trailing text', async () => {
    await runAccessSql(ref, 'GRANT SELECT ON t TO r;\n\nGRANT INSERT ON t TO r;\n');
    expect(sent()).toEqual(['GRANT SELECT ON t TO r;', 'GRANT INSERT ON t TO r;']);
  });

  it('sends the original text when nothing splits out of it', async () => {
    await runAccessSql(ref, 'GRANT SELECT ON t TO r');
    expect(sent()).toEqual(['GRANT SELECT ON t TO r']);
  });

  it('asks the server to stop at the first failure', async () => {
    // A script's later steps assume its earlier ones; running them anyway
    // half-applies access the reader was never shown as a plan.
    await runAccessSql(ref, 'GRANT SELECT ON t TO r;\nGRANT INSERT ON t TO r;');
    expect(executeSql.mock.calls[0]![5]).toEqual({ stopOnError: true });
  });

  it('says which statement failed, what was applied before it and what did not run', async () => {
    // The server stops at the failure, so the results end there.
    executeSql.mockResolvedValue({
      results: [{ ok: true }, { ok: false, error: 'role "r" does not exist' }],
    });
    await expect(
      runAccessSql(ref, 'GRANT USAGE ON SCHEMA s TO r;\nGRANT SELECT ON t TO r;\nGRANT INSERT ON t TO r;')
    ).resolves.toEqual({
      ok: false,
      error: 'Statement 2 of 3 failed: role "r" does not exist. The 1 before it was applied. The 1 after it did not run.',
    });
  });

  it('reports a lone statement’s error as it is', async () => {
    executeSql.mockResolvedValue({ results: [{ ok: false, error: 'permission denied' }] });
    await expect(runAccessSql(ref, 'GRANT SELECT ON t TO r;')).resolves.toEqual({ ok: false, error: 'permission denied' });
  });

  it('does not report ok when fewer results came back than statements were sent', async () => {
    executeSql.mockResolvedValue({ results: [{ ok: true }] });
    await expect(runAccessSql(ref, 'GRANT SELECT ON t TO r;\nGRANT INSERT ON t TO r;')).resolves.toEqual({
      ok: false,
      error: 'Only 1 of 2 statements ran.',
    });
  });

  it('reports ok only when every statement succeeded', async () => {
    executeSql.mockResolvedValue({ results: [{ ok: true }, { ok: true }] });
    await expect(runAccessSql(ref, 'GRANT SELECT ON t TO r;\nGRANT INSERT ON t TO r;')).resolves.toEqual({
      ok: true,
    });
  });
});
