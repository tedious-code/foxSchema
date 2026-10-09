import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import {
  appendFileToSqliteWorkspace,
  isFileQueryConnectionName,
  isFileQueryDbPath,
  materializeFileToSqlite,
  parseCsv,
  parseJsonRecords,
  parseTextOffsets,
  pruneOrphanFileQueryConnections,
  sanitizeTableName,
  fileQueryTempDir,
} from './file-query.service';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const created: string[] = [];
afterEach(() => {
  for (const p of created) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  created.length = 0;
});

describe('file-query parsers', () => {
  it('sanitizeTableName strips extension and unsafe chars', () => {
    expect(sanitizeTableName('My Sales.csv')).toBe('My_Sales');
    expect(sanitizeTableName('123abc')).toBe('t_123abc');
  });

  it('detects file-query connection names and temp DB paths', () => {
    expect(isFileQueryConnectionName('Files: people.csv')).toBe(true);
    expect(isFileQueryConnectionName('Prod Postgres')).toBe(false);
    expect(isFileQueryDbPath(join(fileQueryTempDir(), 'files-abc.db'))).toBe(true);
    expect(isFileQueryDbPath('/var/data/app.db')).toBe(false);
  });

  it('prunes Files: credentials whose temp DB file is missing', async () => {
    const missing = join(fileQueryTempDir(), 'files-orphan-gone.db');
    const keptPath = join(fileQueryTempDir(), 'files-orphan-kept.db');
    // Touch a real temp DB so the "kept" credential survives.
    const Database = require('better-sqlite3');
    const Db = Database.default ?? Database;
    const db = new Db(keptPath);
    db.close();
    created.push(keptPath);

    const rows = [
      { id: 'gone', dialect: 'sqlite', name: 'Files: gone.csv', database: missing },
      { id: 'kept', dialect: 'sqlite', name: 'Files: kept.csv', database: keptPath },
      { id: 'pg', dialect: 'postgres', name: 'Prod', database: 'app' },
    ];
    const store = {
      list: async () => [...rows],
      resolve: async (_u: unknown, id: string) => {
        const row = rows.find((r) => r.id === id);
        return row ? { option: { database: row.database } } : null;
      },
      remove: async (_u: unknown, id: string) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i < 0) return false;
        rows.splice(i, 1);
        return true;
      },
    };

    const removed = await pruneOrphanFileQueryConnections(store, { userId: 'user-1', workspaceId: 'w1' });
    expect(removed).toEqual(['gone']);
    expect(rows.map((r) => r.id)).toEqual(['kept', 'pg']);
  });

  it('rejects path-traversal strings that only lexically prefix the temp dir', () => {
    const root = fileQueryTempDir();
    expect(isFileQueryDbPath(join(root, '..', '..', 'etc', 'passwd'))).toBe(false);
    expect(isFileQueryDbPath(`${root}/../../../etc/passwd`)).toBe(false);
    expect(isFileQueryDbPath(root)).toBe(false);
  });

  it('parseCsv handles headers, quotes, and commas', () => {
    const { columns, rows } = parseCsv('id,name,note\n1,"Ada, Lovelace","ok""yes"\n2,Grace,\n');
    expect(columns).toEqual(['id', 'name', 'note']);
    expect(rows).toEqual([
      ['1', 'Ada, Lovelace', 'ok"yes'],
      ['2', 'Grace', ''],
    ]);
  });

  it('parseCsv respects semicolon, tab, and multi-char delimiters', () => {
    const semi = parseCsv('a;b\n1;2\n', { delimiter: ';' });
    expect(semi.columns).toEqual(['a', 'b']);
    expect(semi.rows).toEqual([['1', '2']]);

    const tab = parseCsv('a\tb\n1\t2\n', { delimiter: '\\t' });
    expect(tab.columns).toEqual(['a', 'b']);
    expect(tab.rows).toEqual([['1', '2']]);

    const multi = parseCsv('a||b\n1||2\n', { delimiter: '||' });
    expect(multi.columns).toEqual(['a', 'b']);
    expect(multi.rows).toEqual([['1', '2']]);
  });

  it('parseJsonRecords reads an array of objects', () => {
    const { columns, rows } = parseJsonRecords(
      JSON.stringify([
        { id: 1, name: 'a' },
        { id: 2, name: 'b', extra: true },
      ])
    );
    expect(columns).toEqual(expect.arrayContaining(['id', 'name', 'extra']));
    expect(rows).toHaveLength(2);
  });

  it('parseJsonRecords reads NDJSON', () => {
    const { rows } = parseJsonRecords('{"a":1}\n{"a":2}\n', 'ndjson');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('parseTextOffsets slices fixed-width columns', () => {
    const { columns, rows } = parseTextOffsets(
      '001Ada   \n002Grace \n',
      [
        { name: 'id', start: 0, length: 3 },
        { name: 'name', start: 3, length: 6 },
      ]
    );
    expect(columns).toEqual(['id', 'name']);
    expect(rows).toEqual([
      ['001', 'Ada'],
      ['002', 'Grace'],
    ]);
  });
});

describe('materializeFileToSqlite', () => {
  it('writes CSV into a queryable SQLite table', () => {
    const result = materializeFileToSqlite({
      format: 'csv',
      fileName: 'people.csv',
      content: 'id,name\n1,Ada\n2,Grace\n',
    });
    created.push(result.dbPath);
    expect(existsSync(result.dbPath)).toBe(true);
    expect(result.tableName).toBe('people');
    expect(result.rowCount).toBe(2);

    const Database = require('better-sqlite3');
    const db = new Database(result.dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT * FROM "${result.tableName}" ORDER BY id`).all();
    db.close();
    expect(rows).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);
  });

  it('writes JSON and fixed-width text', () => {
    const json = materializeFileToSqlite({
      format: 'json',
      fileName: 'items.json',
      content: '[{"sku":"A","qty":2},{"sku":"B","qty":3}]',
    });
    created.push(json.dbPath);
    expect(json.rowCount).toBe(2);

    const text = materializeFileToSqlite({
      format: 'text',
      fileName: 'fixed.txt',
      content: '10AA\n20BB\n',
      text: {
        columns: [
          { name: 'code', start: 0, length: 2 },
          { name: 'tag', start: 2, length: 2 },
        ],
      },
    });
    created.push(text.dbPath);
    expect(text.rowCount).toBe(2);
    expect(text.columns).toEqual(['code', 'tag']);
  });

  it('appends a second file as another table in the same workspace DB', () => {
    const first = materializeFileToSqlite({
      format: 'csv',
      fileName: 'people.csv',
      content: 'id,name\n1,Ada\n',
      tableName: 'people',
    });
    created.push(first.dbPath);
    const second = appendFileToSqliteWorkspace(first.dbPath, {
      format: 'csv',
      fileName: 'orders.csv',
      content: 'id,total\n1,9.5\n',
      tableName: 'orders',
    });
    expect(second.tableName).toBe('orders');
    expect(second.rowCount).toBe(1);

    const Database = require('better-sqlite3');
    const db = new Database(first.dbPath, { readonly: true, fileMustExist: true });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: { name: string }) => r.name);
    db.close();
    expect(tables).toEqual(['orders', 'people']);
  });
});
