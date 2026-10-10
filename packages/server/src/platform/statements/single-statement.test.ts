import { describe, expect, it } from 'vitest';
import { statementVerb, sqlStatementCategories } from '@foxschema/db';
import { isSingleSqlStatement } from './single-statement';

describe('isSingleSqlStatement', () => {
  it('accepts the shapes grid CRUD and data migrate actually generate', () => {
    expect(isSingleSqlStatement('INSERT INTO t (a) VALUES ($1)')).toBe(true);
    expect(isSingleSqlStatement('UPDATE t SET a = $1 WHERE id = $2')).toBe(true);
    expect(isSingleSqlStatement('DELETE FROM t WHERE id = $1')).toBe(true);
    // A single trailing semicolon is normal, not a second statement.
    expect(isSingleSqlStatement('DELETE FROM t WHERE id = $1;')).toBe(true);
    expect(isSingleSqlStatement('DELETE FROM t WHERE id = $1;  \n')).toBe(true);
  });

  it('rejects a batch that hides a second verb', () => {
    expect(isSingleSqlStatement('INSERT INTO t VALUES (1); DELETE FROM users')).toBe(false);
    expect(isSingleSqlStatement('UPDATE t SET a=1; TRUNCATE TABLE users')).toBe(false);
  });

  it('is not fooled by a semicolon inside a literal or comment', () => {
    expect(isSingleSqlStatement("INSERT INTO t VALUES ('a;b')")).toBe(true);
    expect(isSingleSqlStatement('DELETE FROM t WHERE id = 1 -- ; DROP TABLE users')).toBe(true);
  });
});

describe('why the guard is needed (the checks it backs up are not enough alone)', () => {
  const smuggle = 'INSERT INTO t VALUES (1); DELETE FROM users';

  it('statementVerb sees only the first verb', () => {
    // This is what let op=insert / datagridAction=insert match while a DELETE
    // rode along unpriced.
    expect(statementVerb(smuggle)).toBe('insert');
  });

  it('every category is dml, so the category rule cannot catch it', () => {
    expect(sqlStatementCategories(smuggle)).toEqual(['dml', 'dml']);
  });

  it('but a different category still is caught without this guard', () => {
    expect(sqlStatementCategories('INSERT INTO t VALUES (1); DROP TABLE users')).toContain('ddl');
  });
});
