/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A statement needs what its own database sees in it.
 *
 * Each case is text that two engines lex differently: the quote, comment or
 * name ends in a different place, so one of them runs a write that the other
 * reads as part of a string or comment. Classified for the dialect that will
 * run it, the write has to be seen.
 */
import { describe, expect, it } from 'vitest';
import { dmlLacksWhere, isWriteStatement, sqlStatementCategories, statementVerb } from './sql-splitter.js';

/** The categories `sql` needs on `dialect`. */
const needs = (sql: string, dialect?: string) => sqlStatementCategories(sql, dialect);

describe('strings', () => {
  it('PostgreSQL: a backslash in a standard string is a plain character', () => {
    expect(needs("SELECT 'a\\'; DROP TABLE t; --'", 'postgres')).toContain('ddl');
  });

  it('MySQL: NO_BACKSLASH_ESCAPES and ANSI_QUOTES can each end a string early', () => {
    expect(needs("SELECT 'a\\'; DROP TABLE t; --'", 'mysql')).toContain('ddl');
    expect(needs('SELECT "a\\"; DROP TABLE t; --"', 'mysql')).toContain('ddl');
  });

  it('MySQL: $$ is not a quote', () => {
    expect(needs("SELECT $$a, '$$'; DROP TABLE t; --'", 'mysql')).toContain('ddl');
  });

  it('Oracle: a q-quoted string needs no doubled quote', () => {
    expect(needs("SELECT q'[it's]' FROM dual; DROP TABLE t; --'", 'oracle')).toContain('ddl');
  });

  it('ClickHouse: a backslash escapes inside a backtick name', () => {
    expect(needs("SELECT `x\\`, ' `; DROP TABLE t; -- '", 'clickhouse')).toContain('ddl');
  });
});

describe('comments', () => {
  it('PostgreSQL: # is an operator, not a comment', () => {
    expect(needs('SELECT 1 # 2 INTO t', 'postgres')).toEqual(['ddl']);
  });

  it('MySQL: -- starts a comment only before a space', () => {
    expect(needs('SELECT 1--1; DROP TABLE t', 'mysql')).toContain('ddl');
  });

  it('SQL Server and PostgreSQL: block comments nest', () => {
    const sql = "SELECT 1 /* /* */ ' */; DROP TABLE t; --'";
    expect(needs(sql, 'sqlserver')).toContain('ddl');
    expect(needs(sql, 'postgres')).toContain('ddl');
  });

  it('MySQL: a versioned comment newer than the server is only a comment', () => {
    expect(needs("SELECT 1 /*!99999 ' */ INTO OUTFILE '/tmp/x' -- '", 'mysql')).toContain('ddl');
  });

  it('MariaDB and TiDB run executable comments of their own', () => {
    expect(needs("SELECT 1 /*M! INTO OUTFILE '/tmp/x' */", 'mariadb')).toContain('ddl');
    expect(needs("SELECT 1 /*T! INTO OUTFILE '/tmp/x' */", 'tidb')).toContain('ddl');
  });
});

describe('names', () => {
  it('PostgreSQL: [ is a subscript, not a quoted name', () => {
    expect(needs("SELECT ARRAY[']']; DROP TABLE t; --]", 'postgres')).toContain('ddl');
  });

  it('SQLite: a bracketed name ends at its first ]', () => {
    expect(needs('SELECT [x]]; DROP TABLE t; --]', 'sqlite')).toContain('ddl');
  });

  it('PostgreSQL: a number ends at its last digit', () => {
    // Before 15, PostgreSQL reads `1INTO t` as `1 INTO t`; 15 refuses it.
    expect(needs('SELECT 1INTO t', 'postgres')).toEqual(['ddl']);
  });

  it('PostgreSQL: a name runs on through letters past ASCII', () => {
    expect(needs("SELECT 1 AS é$$, '$$'; DROP TABLE t; --'", 'postgres')).toContain('ddl');
  });
});

describe('when the readings disagree', () => {
  it('asks for every reading with no dialect, or one it does not know', () => {
    expect(needs("SELECT 'a\\'; DROP TABLE t; --'")).toContain('ddl');
    expect(needs("SELECT 'a\\'; DROP TABLE t; --'", 'nosuchdb')).toContain('ddl');
  });

  it('names no verb rather than pick one', () => {
    // Run on 9.99.99 or later, this is an UPDATE; before, an INSERT.
    expect(statementVerb('/*!99999 UPDATE */ INSERT INTO t VALUES (1)', 'mysql')).toBeNull();
  });

  it('Safe Mode sees the write too', () => {
    expect(isWriteStatement("SELECT 'a\\'; DROP TABLE t; --'", 'postgres')).toBe(true);
  });

  it('Safe Mode asks about a missing WHERE that any reading misses', () => {
    // PostgreSQL nests comments: the WHERE is inside one.
    expect(dmlLacksWhere('DELETE FROM t /* /* */ WHERE id = 1 */', 'postgres')).toBe(true);
    // An UPDATE or a DELETE, by server version; neither has a WHERE.
    expect(dmlLacksWhere('/*!99999 UPDATE */ DELETE FROM t', 'mysql')).toBe(true);
  });
});

describe('code fences', () => {
  it('splits the SQL after an unclosed fence, which the database reads as a comment', () => {
    expect(needs('-- @node\nSELECT 1; DROP TABLE t', 'postgres')).toContain('ddl');
  });
});
