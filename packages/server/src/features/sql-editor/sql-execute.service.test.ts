import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { clampMaxRows, shapePositional, shapeRows, runStatements } from './sql-execute.service';
import { ConnectionFactory } from '@foxschema/db';

describe('clampMaxRows', () => {
  it('defaults, clamps, and floors', () => {
    expect(clampMaxRows(undefined)).toBe(200);
    expect(clampMaxRows('abc')).toBe(200);
    expect(clampMaxRows(0)).toBe(1);
    expect(clampMaxRows(-5)).toBe(1);
    expect(clampMaxRows(99999)).toBe(5000);
    expect(clampMaxRows(42.9)).toBe(42);
  });
});

describe('shapeRows', () => {
  it('derives columns from row keys and preserves order', () => {
    const shaped = shapeRows([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], 500);
    expect(shaped).toMatchObject({ columns: ['a', 'b'], rowCount: 2, truncated: false });
    expect(shaped.rows).toEqual([[1, 'x'], [2, 'y']]);
  });

  it('unions keys across rows (drivers that omit null keys)', () => {
    const shaped = shapeRows([{ a: 1 }, { b: 2 }], 500);
    expect(shaped.columns).toEqual(['a', 'b']);
    expect(shaped.rows).toEqual([[1, undefined], [undefined, 2]]);
  });

  it('truncates past maxRows and flags it', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    const shaped = shapeRows(raw, 3);
    expect(shaped).toMatchObject({ rowCount: 3, truncated: true });
    expect(shaped.rows).toHaveLength(3);
  });

  it('serializes BigInt, Date, binary, and nested objects to JSON-safe cells', () => {
    const shaped = shapeRows(
      [{ big: 9007199254740993n, when: new Date('2026-01-02T03:04:05.000Z'), bin: new Uint8Array([0xde, 0xad]), obj: { x: 1 } }],
      500
    );
    expect(shaped.rows[0]).toEqual(['9007199254740993', '2026-01-02T03:04:05.000Z', '0xdead', '{"x":1}']);
    expect(() => JSON.stringify(shaped)).not.toThrow();
  });

  it('treats a non-array driver result (e.g. write OkPacket) as an empty result set', () => {
    const shaped = shapeRows({ affectedRows: 3 }, 500);
    expect(shaped).toMatchObject({ columns: [], rows: [], rowCount: 0, truncated: false });
  });

  it('empty result set yields no column names (documented v1 limitation)', () => {
    expect(shapeRows([], 500).columns).toEqual([]);
  });
});

describe('runStatements against a real SQLite file', () => {
  const dbPath = join(tmpdir(), `fox-sql-exec-test-${process.pid}.db`);

  beforeAll(async () => {
    // better-sqlite3 ships no type declarations (the sqlite adapter loads it
    // untyped via createRequire too) — suppress for this seeding-only usage.
    // @ts-expect-error no type declarations for better-sqlite3
    const mod = (await import('better-sqlite3')) as { default: new (path: string) => { exec(sql: string): void; close(): void } };
    const Database = mod.default;
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO t (id, name) VALUES (1, 'alpha'), (2, 'beta'), (3, NULL);`);
    db.close();
  });

  afterAll(async () => {
    await ConnectionFactory.closeAll().catch(() => {});
    rmSync(dbPath, { force: true });
  });

  it('runs statements sequentially, isolating per-statement errors', async () => {
    const results = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      ['SELECT id, name FROM t ORDER BY id;', 'SELECT nope FROM missing_table;', 'SELECT COUNT(*) AS n FROM t;'],
      500
    );
    expect(results).toHaveLength(3);

    expect(results[0]).toMatchObject({ ok: true, columns: ['id', 'name'], rowCount: 3, truncated: false });
    if (results[0].ok) expect(results[0].rows[0]).toEqual([1, 'alpha']);

    expect(results[1].ok).toBe(false);
    if (!results[1].ok) expect(results[1].error).toMatch(/missing_table|no such table/i);

    expect(results[2]).toMatchObject({ ok: true, columns: ['n'] });
    if (results[2].ok) expect(results[2].rows).toEqual([[3]]);
  });

  it('with stopOnError, leaves every statement after a failure unrun', async () => {
    // Clone Table's shape: a step fails, and the steps after it assumed it
    // worked. Here the third statement would create a table if it ran.
    const run = (stopOnError: boolean) =>
      runStatements(
        'sqlite',
        { connectionString: dbPath },
        [
          'CREATE TABLE IF NOT EXISTS stop_first (x INTEGER);',
          'INSERT INTO stop_missing VALUES (1);',
          'CREATE TABLE stop_after (x INTEGER);',
        ],
        500,
        undefined,
        0,
        [],
        undefined,
        stopOnError
      );
    const created = async () =>
      (await runStatements('sqlite', { connectionString: dbPath }, ["SELECT name FROM sqlite_master WHERE name = 'stop_after';"], 10))[0];

    const stopped = await run(true);
    expect(stopped.map((r) => r.ok)).toEqual([true, false]);
    expect(await created()).toMatchObject({ ok: true, rowCount: 0 });

    // Without it every statement runs, as the editor reports them.
    const all = await run(false);
    expect(all.map((r) => r.ok)).toEqual([true, false, true]);
    expect(await created()).toMatchObject({ ok: true, rowCount: 1 });
  });

  it('rolls a transaction back when a later statement fails, and commits when all succeed', async () => {
    const rolled = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      [
        'CREATE TABLE tx_keep (x INTEGER);',
        'INSERT INTO tx_keep VALUES (1);',
        'INSERT INTO tx_missing VALUES (1);',
        'CREATE TABLE tx_after (x INTEGER);',
      ],
      10,
      undefined,
      0,
      [],
      undefined,
      false,
      true
    );
    expect(rolled).toHaveLength(3);
    expect(rolled.map((result) => result.ok)).toEqual([true, true, false]);
    const gone = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      ["SELECT name FROM sqlite_master WHERE name = 'tx_keep';"],
      10
    );
    expect(gone[0]).toMatchObject({ ok: true, rowCount: 0 });
    const after = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      ["SELECT name FROM sqlite_master WHERE name = 'tx_after';"],
      10
    );
    expect(after[0]).toMatchObject({ ok: true, rowCount: 0 });

    const kept = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      ['CREATE TABLE tx_ok (x INTEGER);', 'INSERT INTO tx_ok VALUES (1);'],
      10,
      undefined,
      0,
      [],
      undefined,
      false,
      true
    );
    expect(kept.map((result) => result.ok)).toEqual([true, true]);
    const rows = await runStatements('sqlite', { connectionString: dbPath }, ['SELECT x FROM tx_ok;'], 10);
    expect(rows[0]).toMatchObject({ ok: true, rows: [[1]] });
  });

  it('applies the row cap with the truncated flag', async () => {
    const results = await runStatements('sqlite', { connectionString: dbPath }, ['SELECT * FROM t;'], 2);
    expect(results[0]).toMatchObject({ ok: true, rowCount: 2, truncated: true, hasNext: true });
  });

  it('pages SELECT with OFFSET (page 1 is not page 0)', async () => {
    const page0 = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      ['SELECT id, name FROM t ORDER BY id;'],
      1,
      undefined,
      0
    );
    const page1 = await runStatements(
      'sqlite',
      { connectionString: dbPath },
      ['SELECT id, name FROM t ORDER BY id;'],
      1,
      undefined,
      1
    );
    expect(page0[0]).toMatchObject({ ok: true, hasNext: true });
    expect(page1[0]).toMatchObject({ ok: true });
    if (page0[0]!.ok && page1[0]!.ok) {
      expect(page0[0].rows[0]).toEqual([1, 'alpha']);
      expect(page1[0].rows[0]).toEqual([2, 'beta']);
    }
  });

  it('runs non-SELECT unwrapped at offset 0 (no wrap attempt)', async () => {
    const spy = vi.spyOn(ConnectionFactory, 'executeOnConnection').mockResolvedValueOnce([]);
    try {
      const results = await runStatements(
        'sqlite',
        { connectionString: dbPath },
        [`UPDATE t SET name = 'x' WHERE id = 1;`],
        10
      );
      expect(results[0]).toMatchObject({ ok: true, hasNext: false, rowCount: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![2])).toMatch(/^UPDATE t/i);
      expect(String(spy.mock.calls[0]![2])).not.toContain('_fox_page');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects paging a non-SELECT when offset > 0', async () => {
    const spy = vi.spyOn(ConnectionFactory, 'executeOnConnection');
    try {
      const results = await runStatements(
        'sqlite',
        { connectionString: dbPath },
        [`UPDATE t SET name = 'x' WHERE id = 1;`],
        10,
        undefined,
        10
      );
      expect(results[0]).toMatchObject({ ok: false });
      if (!results[0]!.ok) expect(results[0].error).toMatch(/non-SELECT/i);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('runs insert-returning CTE unwrapped (not page-wrapped)', async () => {
    // SQLite has no INSERT…RETURNING in CTE the same way PG does; assert wrap path is skipped.
    const spy = vi.spyOn(ConnectionFactory, 'executeOnConnection').mockResolvedValueOnce([{ id: 1 }]);
    try {
      const sql =
        'WITH i AS (INSERT INTO t (id, name) VALUES (99, \'z\') RETURNING id) SELECT id FROM i';
      const results = await runStatements('sqlite', { connectionString: dbPath }, [sql], 10);
      expect(results[0]).toMatchObject({ ok: true, hasNext: false });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![2])).toBe(sql);
      expect(String(spy.mock.calls[0]![2])).not.toContain('fox_page');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a Redis statement error as itself, not as a failed page', async () => {
    // Redis pages with LIMIT/OFFSET on the statement, so there is no wrapper to blame.
    const create = vi.spyOn(ConnectionFactory, 'create').mockResolvedValue({} as never);
    const close = vi.spyOn(ConnectionFactory, 'close').mockResolvedValue(undefined);
    const positional = vi.spyOn(ConnectionFactory, 'executePositional').mockReturnValue(null as never);
    const message = 'Redis: Only `column = value` predicates joined by AND are supported on this store.';
    const exec = vi.spyOn(ConnectionFactory, 'executeOnConnection').mockRejectedValue(new Error(message));
    try {
      const results = await runStatements('redis', {}, ['SELECT * FROM users WHERE id > 1'], 200);
      expect(results[0]).toMatchObject({ ok: false, error: message });
      expect(String(exec.mock.calls[0]![2])).toBe('SELECT * FROM users WHERE id > 1 LIMIT 201 OFFSET 0');
    } finally {
      for (const s of [create, close, positional, exec]) s.mockRestore();
    }
  });

  it('does not fall back to unwrapped SQL when offset > 0 and wrap fails', async () => {
    const spy = vi
      .spyOn(ConnectionFactory, 'executeOnConnection')
      .mockRejectedValueOnce(new Error('wrap boom'));
    try {
      const results = await runStatements(
        'sqlite',
        { connectionString: dbPath },
        ['SELECT id FROM t ORDER BY id;'],
        1,
        undefined,
        1
      );
      expect(results[0]).toMatchObject({ ok: false });
      if (!results[0]!.ok) {
        expect(results[0].error).toMatch(/Paging failed/i);
        expect(results[0].error).toMatch(/wrap boom/);
      }
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![2])).toContain('fox_page');
      expect(String(spy.mock.calls[0]![2])).not.toContain('_fox_page');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the statement error when a LIMIT 1 probe fails', async () => {
    const spy = vi
      .spyOn(ConnectionFactory, 'executeOnConnection')
      .mockRejectedValueOnce(new Error('wrap boom'))
      .mockRejectedValueOnce(new Error("no such table: COUPONS"));
    try {
      const results = await runStatements(
        'sqlite',
        { connectionString: dbPath },
        ['SELECT * FROM COUPONS cou'],
        1,
        undefined,
        0
      );
      expect(results[0]).toMatchObject({ ok: false });
      if (!results[0]!.ok) {
        expect(results[0].error).toBe('no such table: COUPONS');
        expect(results[0].error).not.toMatch(/Paging failed/i);
      }
      expect(spy).toHaveBeenCalledTimes(2);
      expect(String(spy.mock.calls[0]![2])).toContain('fox_page');
      expect(String(spy.mock.calls[1]![2])).toBe('SELECT * FROM COUPONS cou LIMIT 1');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the paging error when the statement itself runs', async () => {
    const spy = vi
      .spyOn(ConnectionFactory, 'executeOnConnection')
      .mockRejectedValueOnce(new Error('wrap boom'))
      .mockResolvedValueOnce([{ id: 1 }]);
    try {
      const results = await runStatements(
        'sqlite',
        { connectionString: dbPath },
        ['SELECT id FROM t ORDER BY id;'],
        1,
        undefined,
        0
      );
      expect(results[0]).toMatchObject({ ok: false });
      if (!results[0]!.ok) {
        expect(results[0].error).toMatch(/Paging failed/i);
        expect(results[0].error).toMatch(/wrap boom/);
      }
      expect(spy).toHaveBeenCalledTimes(2);
      expect(String(spy.mock.calls[1]![2])).toContain('LIMIT 1');
      expect(String(spy.mock.calls[1]![2])).not.toContain('fox_page');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('shapePositional', () => {
  it('keeps every column when a join repeats a name', () => {
    // The defect this exists for: rows arrive keyed by column name, so a join
    // over four tables that each have `id` returned one `id` holding the last
    // table's value, and three columns vanished with no error. The row then
    // read as a single record while mixing values from different tables.
    const raw = {
      columns: ['id', 'total', 'id', 'name'],
      rows: [[701, '1048.50', 901, 'Ada Lovelace']],
    };
    const out = shapePositional(raw, 100);
    expect(out.columns).toEqual(['id', 'total', 'id', 'name']);
    expect(out.rows[0]).toEqual([701, '1048.50', 901, 'Ada Lovelace']);
  });

  it('names columns even when no rows came back', () => {
    // The name-keyed path derives columns from the rows, so an empty result had
    // no column names at all ("0 rows (column names unavailable)"). Field
    // metadata does not depend on there being rows.
    const out = shapePositional({ columns: ['id', 'name'], rows: [] }, 100);
    expect(out.columns).toEqual(['id', 'name']);
    expect(out.rowCount).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('truncates at maxRows and says so', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [i]);
    const out = shapePositional({ columns: ['n'], rows }, 3);
    expect(out.rowCount).toBe(3);
    expect(out.truncated).toBe(true);
  });

  it('survives a driver that returned nothing usable', () => {
    const out = shapePositional({ columns: [], rows: [] }, 10);
    expect(out.columns).toEqual([]);
    expect(out.rows).toEqual([]);
  });
});
