/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The three shapes a built command can take.
 */
import { describe, expect, it } from 'vitest';
import { buildCliCommand } from './build-command.js';
import { formatCommand } from './format.js';
import type { GeneratedCommand } from './cli.types.js';

const target = { host: '127.0.0.1', port: 5432, database: 'foxdb', username: 'foxuser' };

function built(sql = "SELECT 'it''s ok';"): GeneratedCommand {
  const out = buildCliCommand(sql, 'postgres', target);
  if ('error' in out) throw new Error(out.error);
  return out;
}

const textOf = (r: ReturnType<typeof formatCommand>) => ('error' in r ? '' : r.text);

describe('raw', () => {
  it('is the command as built', () => {
    const g = built();
    expect(textOf(formatCommand(g, { format: 'raw' }))).toBe(g.command);
  });
});

describe('docker', () => {
  it('keeps stdin open, or the heredoc would be thrown away', () => {
    // Without -i, docker gives the client no stdin: it reads nothing and the
    // statement silently does not run.
    const text = textOf(formatCommand(built(), { format: 'docker', container: 'foxschema-postgres' }));
    // `-e PGPASSWORD` forwards the variable from the caller's shell; without a
    // tty and with stdin taken by the here-document, that is the only way the
    // password reaches psql.
    expect(text).toContain('docker exec -i -e PGPASSWORD foxschema-postgres psql');
  });

  it('keeps the statement and the heredoc intact', () => {
    const text = textOf(formatCommand(built(), { format: 'docker', container: 'pg' }));
    expect(text).toContain("<<'FOXSQL'");
    expect(text).toContain("SELECT 'it''s ok';");
    expect(text.trimEnd().endsWith('FOXSQL')).toBe(true);
  });

  it('puts the client flags after the container, not before', () => {
    const text = textOf(formatCommand(built(), { format: 'docker', container: 'pg' }));
    expect(text.indexOf('docker exec -i pg')).toBeLessThan(text.indexOf('psql'));
  });

  it('asks for a container rather than guessing one', () => {
    const out = formatCommand(built(), { format: 'docker' });
    expect('error' in out).toBe(true);
  });

  it.each([
    ['a semicolon', 'pg; rm -rf /'],
    ['a space', 'my container'],
    ['a leading dash', '-rf'],
    ['a quote', "pg'"],
    ['a dollar sign', 'pg$(id)'],
  ])('refuses a container name with %s', (_label, container) => {
    const out = formatCommand(built(), { format: 'docker', container });
    expect('error' in out).toBe(true);
  });

  it('accepts the names docker actually allows', () => {
    for (const name of ['foxschema-db2', 'pg_1', 'a.b-c', '0abc']) {
      expect('error' in formatCommand(built(), { format: 'docker', container: name })).toBe(false);
    }
  });

  it('rebuilds a fresh delimiter when the statement collides', () => {
    const g = built('SELECT 1;\nFOXSQL\nSELECT 2;');
    const text = textOf(formatCommand(g, { format: 'docker', container: 'pg' }));
    expect(text).toContain("<<'FOXSQL2'");
    expect(text.trimEnd().endsWith('FOXSQL2')).toBe(true);
  });
});

describe('script', () => {
  const script = () => formatCommand(built(), { format: 'script' });

  it('is a runnable bash file that stops on error', () => {
    const text = textOf(script());
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(text).toContain('psql -h');
  });

  it('names the client the reader has to install', () => {
    expect(textOf(script())).toContain('Needs psql on PATH');
  });

  it('says which variable to set, since no client here can prompt', () => {
    expect(textOf(script())).toMatch(/PGPASSWORD/);
  });

  it('suggests a file name', () => {
    const out = script();
    if ('error' in out) throw new Error('expected a script');
    expect(out.filename).toBe('foxschema-psql.sh');
  });

  it('ends with a newline, as a shell script should', () => {
    expect(textOf(script()).endsWith('\n')).toBe(true);
  });

  it('carries no password', () => {
    // The whole point: the script is saved to disk and may be committed.
    const text = textOf(script());
    expect(text).not.toMatch(/PGPASSWORD=\S/);
    expect(text).not.toMatch(/\s-p[^\s-]/);
  });
});
