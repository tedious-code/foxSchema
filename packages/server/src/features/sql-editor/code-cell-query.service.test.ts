import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionFactory } from '@foxschema/db';
import { MAX_CELL_QUERY_ROWS } from './code-cell-bridge.service';
import {
  makeBeamCellQueryRunner,
  makeCellQueryRunner,
  objectRowsFromPositional,
} from './code-cell-query.service';
import type { Permission } from '@foxschema/shared';
import type { CellQueryRunner } from './code-cell-execute.service';

vi.mock('@foxschema/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@foxschema/db')>();
  return {
    ...actual,
    ConnectionFactory: {
      create: vi.fn(async () => ({})),
      close: vi.fn(async () => {}),
      // Default: no positional — fall back to name-keyed rows (SQLite-like).
      executePositional: vi.fn(() => null),
      executeOnConnection: vi.fn(async () => [{ ok: 1 }]),
    },
  };
});

const resolved = { dialect: 'postgres', option: {} as never };
/** An editor: data + schema power, but explicitly not GRANT. */
const editor = new Set<Permission>(['editor.dml', 'editor.ddl']);
const runnerFor = (perms: Set<Permission>, allowWrites = true) =>
  makeCellQueryRunner(resolved, { allowWrites, can: (p) => perms.has(p) });

beforeEach(() => {
  vi.mocked(ConnectionFactory.create).mockReset().mockResolvedValue({});
  vi.mocked(ConnectionFactory.close).mockReset().mockResolvedValue(undefined);
  vi.mocked(ConnectionFactory.executePositional).mockReset().mockReturnValue(null);
  vi.mocked(ConnectionFactory.executeOnConnection).mockReset().mockResolvedValue([{ ok: 1 }] as never);
});

describe('objectRowsFromPositional', () => {
  it('zips unique columns into objects cells already consume', () => {
    expect(
      objectRowsFromPositional(
        ['id', 'name'],
        [
          [1, 'Ada'],
          [2, 'Bob'],
        ]
      )
    ).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('fails closed when a join would collapse duplicate names into one key', () => {
    // orders.id and customers.id both arrive as "id". Packing into an object
    // would keep only the last — the exact silent Beam-copy corruption this
    // guards against.
    expect(() =>
      objectRowsFromPositional(
        ['id', 'email', 'id', 'name'],
        [[7, 'ada@example.com', 1, 'Ada']]
      )
    ).toThrow(/duplicate column names \(id\)/);
  });

  it('lists every colliding name once', () => {
    expect(() =>
      objectRowsFromPositional(['id', 'name', 'id', 'name'], [[1, 'a', 2, 'b']])
    ).toThrow(/duplicate column names \(id, name\)/);
  });
});

describe('code cell bridge permission policy', () => {
  it('allows reads regardless of permissions', async () => {
    await expect(runnerFor(new Set(), false)('SELECT 1', [])).resolves.toEqual([{ ok: 1 }]);
  });

  it('lets an editor run data and schema changes', async () => {
    await expect(runnerFor(editor)('INSERT INTO t VALUES (1)', [])).resolves.toBeTruthy();
    await expect(runnerFor(editor)('CREATE TABLE t (a int)', [])).resolves.toBeTruthy();
  });

  it('blocks GRANT from an editor even when writes are allowed', async () => {
    // The escalation Bugbot found: allowWrites used to be a blanket pass, so a
    // cell could hand its own account privileges it was never granted.
    await expect(runnerFor(editor)('GRANT ALL ON t TO bob', [])).rejects.toThrow(
      /editor\.grant/
    );
  });

  it('allows GRANT once the caller actually has editor.grant', async () => {
    const owner = new Set<Permission>([...editor, 'editor.grant']);
    await expect(runnerFor(owner)('GRANT ALL ON t TO bob', [])).resolves.toBeTruthy();
  });

  it('blocks a dml-only caller from schema changes', async () => {
    const dmlOnly = new Set<Permission>(['editor.dml']);
    await expect(runnerFor(dmlOnly)('DROP TABLE t', [])).rejects.toThrow(/editor\.ddl/);
  });

  it('Safe mode still blocks writes before permissions are consulted', async () => {
    const owner = new Set<Permission>([...editor, 'editor.grant']);
    await expect(runnerFor(owner, false)('DELETE FROM t', [])).rejects.toThrow(/Safe mode/);
  });

  it('fails closed on an unrecognized verb', async () => {
    await expect(runnerFor(new Set<Permission>(['editor.dml']))('FLASHBACK TABLE t', [])).rejects.toThrow(
      /editor\.ddl/
    );
  });

  it('does not let a leading SELECT authorize a batched write or GRANT', async () => {
    await expect(runnerFor(editor, false)('SELECT 1; DELETE FROM t', [])).rejects.toThrow(/Safe mode/);
    await expect(runnerFor(editor)('SELECT 1; GRANT ALL ON t TO bob', [])).rejects.toThrow(/editor\.grant/);
  });

  it('blocks a leading-semicolon write that used to classify as a read', async () => {
    await expect(runnerFor(new Set(), false)('; DELETE FROM t', [])).rejects.toThrow(/Safe mode/);
  });

  it('reads the statement as the connection dialect does', async () => {
    // PostgreSQL: the backslash is a plain character, so the DROP is outside the string.
    const dmlOnly = new Set<Permission>(['editor.dml']);
    await expect(runnerFor(dmlOnly)("SELECT 'a\\'; DROP TABLE t; --'", [])).rejects.toThrow(/editor\.ddl/);
  });

  it('blocks parenthesized PRAGMA assignments', async () => {
    await expect(runnerFor(new Set(), false)('PRAGMA user_version(123)', [])).rejects.toThrow(/Safe mode/);
  });

  it('fails closed when a bridged SELECT exceeds MAX_CELL_QUERY_ROWS', async () => {
    const many = Array.from({ length: MAX_CELL_QUERY_ROWS + 1 }, (_, i) => ({ id: i }));
    vi.mocked(ConnectionFactory.executeOnConnection).mockResolvedValueOnce(many as never);
    await expect(runnerFor(new Set(), false)('SELECT id FROM t', [])).rejects.toThrow(
      /refuses more than/
    );
  });

  it('prefers positional rows and refuses a join that would collapse columns', async () => {
    vi.mocked(ConnectionFactory.executePositional).mockReturnValueOnce(
      Promise.resolve({
        columns: ['id', 'email', 'id', 'name'],
        rows: [[7, 'ada@example.com', 1, 'Ada']],
      }) as never
    );
    await expect(
      runnerFor(new Set(), false)(
        'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
        []
      )
    ).rejects.toThrow(/duplicate column names \(id\)/);
    // Name-keyed path must not have been used as a silent fallback.
    expect(ConnectionFactory.executeOnConnection).not.toHaveBeenCalled();
  });

  it('hands unique positional columns through as objects', async () => {
    vi.mocked(ConnectionFactory.executePositional).mockReturnValueOnce(
      Promise.resolve({
        columns: ['order_id', 'customer_id', 'email'],
        rows: [[7, 1, 'ada@example.com']],
      }) as never
    );
    await expect(
      runnerFor(new Set(), false)(
        'SELECT o.id AS order_id, c.id AS customer_id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id',
        []
      )
    ).resolves.toEqual([{ order_id: 7, customer_id: 1, email: 'ada@example.com' }]);
  });

  it('releases the connection after a positional query', async () => {
    vi.mocked(ConnectionFactory.executePositional).mockReturnValueOnce(
      Promise.resolve({ columns: ['n'], rows: [[1]] }) as never
    );
    await runnerFor(new Set(), false)('SELECT 1 AS n', []);
    expect(ConnectionFactory.create).toHaveBeenCalled();
    expect(ConnectionFactory.close).toHaveBeenCalled();
  });
});

describe('makeBeamCellQueryRunner', () => {
  const stub = (label: string): CellQueryRunner =>
    async (text, params, alias) => [{ label, text, params, alias }];

  it('routes by alias and falls back to the default', async () => {
    const byAlias = new Map<string, CellQueryRunner>([
      ['source', stub('src')],
      ['target', stub('tgt')],
    ]);
    const run = makeBeamCellQueryRunner(byAlias, 'source');
    await expect(run('SELECT 1', [], 'target')).resolves.toEqual([
      { label: 'tgt', text: 'SELECT 1', params: [], alias: 'target' },
    ]);
    await expect(run('SELECT 2', [9])).resolves.toEqual([
      { label: 'src', text: 'SELECT 2', params: [9], alias: 'source' },
    ]);
  });

  it('fails closed on missing or unknown aliases', async () => {
    const byAlias = new Map<string, CellQueryRunner>([['source', stub('src')]]);
    const noDefault = makeBeamCellQueryRunner(byAlias);
    await expect(noDefault('SELECT 1', [])).rejects.toThrow(/missing alias/i);
    const withDefault = makeBeamCellQueryRunner(byAlias, 'source');
    await expect(withDefault('SELECT 1', [], 'warehouse')).rejects.toThrow(
      /Unknown Server Beam alias "warehouse"/
    );
  });
});
