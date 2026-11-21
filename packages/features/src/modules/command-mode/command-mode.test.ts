/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Command mode.
 *
 * These commands are pasted into a terminal and run by hand, often against a
 * production server, so the tests care most about two things: nothing in the
 * SQL or the connection details can become shell, and no password is ever put
 * on a command line.
 */
import { describe, expect, it } from 'vitest';
import { buildCliCommand, renderCliCommand } from './build-command.js';
import { PASSWORD_PLACEHOLDER } from '@foxschema/sql';
import { CLI_MAP, cliFor, supportsCommandMode } from './cli.registry.js';
import { heredoc, shellQuote } from './shell.js';
import { formatCommand } from './format.js';
import type { CliTarget } from './cli.types.js';
import { DIALECT_MAP } from '@foxschema/sql';

const target: CliTarget = {
  host: 'db.internal',
  port: 5432,
  database: 'foxdb',
  username: 'foxuser',
};

const build = (sql: string, dialect = 'postgres', t: CliTarget = target) =>
  buildCliCommand(sql, dialect, t);

const commandOf = (out: ReturnType<typeof build>) => ('error' in out ? '' : out.command);

describe('shellQuote', () => {
  it('wraps a plain value', () => {
    expect(shellQuote('foxdb')).toBe("'foxdb'");
  });

  it('closes, escapes and reopens around an embedded quote', () => {
    // The only character single quotes cannot hold is the single quote.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('leaves everything else inert', () => {
    for (const v of ['$HOME', '`id`', 'a;rm -rf /', 'a b', '$(whoami)']) {
      const quoted = shellQuote(v);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // Nothing inside opened a new unquoted region.
      expect(quoted.slice(1, -1)).not.toContain("'");
    }
  });
});

describe('heredoc', () => {
  it('quotes the delimiter so the body is never expanded', () => {
    const out = heredoc('psql', 'SELECT $1, `id`, "x";');
    expect(typeof out).toBe('string');
    if (typeof out !== 'string') return;
    expect(out).toContain("<<'FOXSQL'");
    // The body survives character for character.
    expect(out).toContain('SELECT $1, `id`, "x";');
  });

  it('picks another delimiter when the body contains the first', () => {
    const out = heredoc('psql', 'SELECT 1;\nFOXSQL\nSELECT 2;');
    if (typeof out !== 'string') throw new Error('expected a command');
    expect(out).toContain("<<'FOXSQL2'");
    expect(out.trimEnd().endsWith('FOXSQL2')).toBe(true);
  });

  it('always terminates the document on its own line', () => {
    const out = heredoc('psql', 'SELECT 1;');
    if (typeof out !== 'string') throw new Error('expected a command');
    expect(out.endsWith('\nFOXSQL')).toBe(true);
  });
});

describe('buildCliCommand', () => {
  const DIALECTS = Object.keys(DIALECT_MAP).map((d) => d.toLowerCase());

  it('covers every registered dialect', () => {
    // A dialect added later should not silently lose command mode.
    const missing = DIALECTS.filter((d) => !supportsCommandMode(d));
    expect(missing).toEqual([]);
  });

  it.each(DIALECTS)('%s produces a command with the statement intact', (dialect) => {
    const out = build('SELECT 1;', dialect, { ...target, file: '/tmp/x.db' });
    expect('error' in out, dialect).toBe(false);
    if ('error' in out) return;
    expect(out.command, dialect).toContain('SELECT 1;');
    expect(out.client, dialect).toBeTruthy();
  });

  /**
   * SQL*Plus and the Db2 CLP have no password environment variable, and both
   * read their prompt from stdin — which the here-document occupies. There is
   * no third option for them: the password goes in the command or the command
   * cannot authenticate. Everything else uses PGPASSWORD / MYSQL_PWD /
   * SQLCMDPASSWORD and carries nothing secret.
   */
  const INLINE_PASSWORD_DIALECTS = new Set(['oracle', 'db2']);

  it.each(DIALECTS)('%s never puts a password on the command line', (dialect) => {
    const out = build('SELECT 1;', dialect, {
      ...target,
      file: '/tmp/x.db',
    });
    if ('error' in out) return;
    // Nothing that looks like a supplied secret. `-p` must be preceded by
    // whitespace so `--port` is not mistaken for it, and followed by a
    // non-space so a bare prompting `-p` still passes.
    if (INLINE_PASSWORD_DIALECTS.has(dialect)) {
      // Allowed to carry one, but only ever as the placeholder — never a value
      // taken from the target. Whatever the reader substitutes is their choice;
      // the tool must not put a real secret there itself.
      expect(out.command, dialect).toContain(PASSWORD_PLACEHOLDER);
      expect(out.auth, dialect).toBe('inline');
      return;
    }
    expect(out.command, dialect).not.toMatch(/\s-p[^\s-]/);
    expect(out.command, dialect).not.toMatch(/--password[= ]\S/);
    expect(out.command, dialect).not.toMatch(/-P\s+\S*(?:pass|secret)/i);
    expect(out.command, dialect).not.toContain(PASSWORD_PLACEHOLDER);
    expect(['prompts', 'environment', 'none'], dialect).toContain(out.auth);
  });

  it('passes SQL full of quotes through untouched', () => {
    const sql = `INSERT INTO t (a) VALUES ('it''s', "x", $tag$body$tag$);`;
    expect(commandOf(build(sql))).toContain(sql);
  });

  it('keeps a multi-line script as multiple lines', () => {
    const sql = 'BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;';
    const cmd = commandOf(build(sql));
    expect(cmd).toContain('BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;');
  });

  it('cannot be escaped by SQL that tries to close the quoting', () => {
    // Inside a quoted heredoc none of this is shell — it is just text.
    const sql = `SELECT 1; ' ; rm -rf / ; echo '`;
    const cmd = commandOf(build(sql));
    expect(cmd).toContain(sql);
    // The command still ends at its delimiter and nowhere else.
    expect(cmd.trimEnd().endsWith('FOXSQL')).toBe(true);
  });

  it('refuses a host that would not survive as one word', () => {
    const out = build('SELECT 1;', 'postgres', { ...target, host: 'db.internal; rm -rf /' });
    expect('error' in out).toBe(true);
  });

  it('refuses an empty statement', () => {
    expect('error' in build('   ')).toBe(true);
  });

  it('says so for an engine that does not take SQL', () => {
    const out = buildCliCommand('SELECT 1;', 'mongodb', target);
    expect('error' in out).toBe(true);
    if (!('error' in out)) return;
    expect(out.error).toMatch(/MongoDB and Redis/);
  });
});

describe('per-engine flags', () => {
  it('psql stops at the first error and takes host, port, user, database', () => {
    const cmd = commandOf(build('SELECT 1;', 'postgres'));
    expect(cmd).toContain("psql -h 'db.internal' -p 5432 -U 'foxuser' -d 'foxdb'");
    expect(cmd).toContain('ON_ERROR_STOP=1');
  });

  it('psql sets the search path when a schema is chosen', () => {
    const cmd = commandOf(build('SELECT 1;', 'postgres', { ...target, schema: 'demo_a' }));
    expect(cmd).toContain('SET search_path TO demo_a');
  });

  it('mysql passes no password flag at all', () => {
    // A bare -p prompts, and the prompt reads stdin — which the here-document
    // uses, so the client swallowed the script's first line as the password.
    // MYSQL_PWD carries it instead, and nothing secret is on the line.
    const out = build('SELECT 1;', 'mysql', { ...target, port: 3306 });
    if ('error' in out) throw new Error(out.error);
    expect(out.command).not.toMatch(/\s-p/);
    expect(out.command).toMatch(/-u 'foxuser' 'foxdb'/);
    expect(out.auth).toBe('environment');
    expect(out.envVar).toBe('MYSQL_PWD');
  });

  it('sqlcmd joins host and port into one -S value and sets -b', () => {
    const cmd = commandOf(build('SELECT 1;', 'sqlserver', { ...target, port: 1433 }));
    expect(cmd).toContain("-S 'tcp:db.internal,1433'");
    expect(cmd).toContain('-b');
  });

  it('sqlplus uses Easy Connect and stops on error', () => {
    const cmd = commandOf(build('SELECT 1', 'oracle', { ...target, port: 1521 }));
    // The password is in the connect string because SQL*Plus reads its prompt
    // from stdin, which the here-document already uses.
    expect(cmd).toContain(`sqlplus -S 'foxuser/${PASSWORD_PLACEHOLDER}@//db.internal:1521/foxdb'`);
    expect(cmd).toContain('WHENEVER SQLERROR EXIT SQL.SQLCODE');
    // SQL*Plus needs the terminator and an explicit exit.
    expect(cmd).toContain('SELECT 1;');
    expect(cmd).toContain('EXIT');
  });

  it('db2 connects first and resets after', () => {
    const cmd = commandOf(build('SELECT 1', 'db2'));
    expect(cmd).toContain('db2 -tvs');
    expect(cmd).toContain(`CONNECT TO foxdb USER foxuser USING '${PASSWORD_PLACEHOLDER}';`);
    expect(cmd).toContain('CONNECT RESET;');
  });

  it('clickhouse uses the native port, not the HTTP one', () => {
    const out = build('SELECT 1;', 'clickhouse', { ...target, port: undefined });
    if ('error' in out) throw new Error(out.error);
    expect(out.command).toContain('--port 9000');
    expect(out.command).toContain('--multiquery');
    // Same heredoc rule as mysql/psql: --ask-password cannot read a prompt,
    // and official images already set CLICKHOUSE_PASSWORD which then conflicts.
    expect(out.command).not.toContain('--ask-password');
    expect(out.auth).toBe('environment');
    expect(out.envVar).toBe('CLICKHOUSE_PASSWORD');
  });

  it('mariadb uses the mariadb binary, not mysql', () => {
    // MariaDB 11 containers dropped the mysql symlink.
    const out = build('SELECT 1;', 'mariadb', { ...target, port: 3306 });
    if ('error' in out) throw new Error(out.error);
    expect(out.command).toMatch(/^mariadb /);
    expect(out.client).toBe('mariadb');
    expect(out.auth).toBe('environment');
    expect(out.envVar).toBe('MYSQL_PWD');
  });

  it('sqlite and duckdb take a file and need no login', () => {
    for (const dialect of ['sqlite', 'duckdb']) {
      const out = build('SELECT 1;', dialect, { file: '/tmp/demo.db' });
      if ('error' in out) throw new Error(out.error);
      expect(out.command, dialect).toContain("'/tmp/demo.db'");
      expect(out.auth, dialect).toBe('none');
    }
  });

  it('aliases the engines that share a client', () => {
    expect(cliFor('redshift')).toBe(CLI_MAP.postgres);
    expect(cliFor('cockroachdb')).toBe(CLI_MAP.postgres);
    expect(cliFor('tidb')).toBe(CLI_MAP.mysql);
    expect(cliFor('azuresql')).toBe(CLI_MAP.sqlserver);
  });

  it('gives MariaDB its own emitter (binary name differs)', () => {
    expect(cliFor('mariadb')).toBe(CLI_MAP.mariadb);
    expect(cliFor('mariadb')).not.toBe(CLI_MAP.mysql);
  });
});

describe('renderCliCommand', () => {
  it('leads with the variable to export, for a client that cannot prompt', () => {
    const out = build('SELECT 1;', 'postgres');
    if ('error' in out) throw new Error(out.error);
    const rendered = renderCliCommand(out);
    expect(rendered).toMatch(/^# export PGPASSWORD=/);
    expect(rendered).toContain(out.command);
  });

  it('returns just the command where no password is involved', () => {
    const out = build('SELECT 1;', 'sqlite', { ...target, file: '/tmp/x.db' });
    if ('error' in out) throw new Error(out.error);
    expect(renderCliCommand(out)).toBe(out.command);
  });
});

describe('the Docker form matches the engine’s own image', () => {
  // Each of these was found by running the generated command against the real
  // container and reading the failure, not from documentation.
  const t = { host: 'db.internal', port: undefined, database: 'foxdb', username: 'foxuser' };
  const docker = (dialect: string, target: Partial<typeof t> = {}) => {
    const cmd = build('SELECT 1;', dialect, { ...t, ...target } as never);
    if ('error' in cmd) throw new Error(cmd.error);
    return formatCommand(cmd, { format: 'docker', container: 'c' });
  };
  const textOf = (r: ReturnType<typeof docker>) => ('error' in r ? `ERROR:${r.error}` : r.text);

  it('uses the MariaDB client, which replaced mysql in the image', () => {
    // MariaDB 11 renamed it; `mysql` is simply absent, so the command died
    // with "executable file not found in $PATH".
    expect(textOf(docker('mariadb'))).toContain(' mariadb -h ');
    // The MySQL image still has mysql, and shares this emitter.
    expect(textOf(docker('mysql'))).toContain(' mysql -h ');
  });

  /**
   * The rename is the client's, not the container's.
   *
   * Fixing only the Docker form would leave the other two saying `mysql`,
   * which does not exist on a MariaDB install either — 11.8 ships `mariadb`
   * and no symlink, verified in the image. Someone with MariaDB on their own
   * machine would get the same "command not found" the Docker form was fixed
   * for, from a command that names the client in its own "Needs X on PATH"
   * line. The dedicated emitter in `providers/mariaDb/mariadb.cli.ts` is what
   * makes every format agree; this pins that it does.
   *
   * YugabyteDB stays the other way round on purpose: its *image* has no psql,
   * but it speaks the PostgreSQL wire protocol, so psql on a host works and
   * renaming it everywhere would break that reader instead.
   */
  it('names the MariaDB client in every format, not only Docker', () => {
    const cmd = build('SELECT 1;', 'mariadb', t as never);
    if ('error' in cmd) throw new Error(cmd.error);
    expect(cmd.client).toBe('mariadb');
    expect(cmd.invocation.startsWith('mariadb ')).toBe(true);
    expect(cmd.command.startsWith('mariadb ')).toBe(true);

    for (const format of ['raw', 'script'] as const) {
      const out = formatCommand(cmd, { format });
      if ('error' in out) throw new Error(out.error);
      expect(out.text, format).toContain('mariadb -h ');
      expect(out.text, format).not.toMatch(/(^|\s)mysql -h /);
    }
    // The script's "Needs X on PATH" line has to agree with the command below it.
    const script = formatCommand(cmd, { format: 'script' });
    if ('error' in script) throw new Error(script.error);
    expect(script.text).toContain('Needs mariadb on PATH');
  });

  it('leaves a statement that mentions the other client alone', () => {
    // The emitter builds the command from the client and the body separately,
    // so nothing rewrites the finished string — a body naming `mysql` survives.
    const cmd = build("SELECT 'mysql is a word' AS note;", 'mariadb', t as never);
    if ('error' in cmd) throw new Error(cmd.error);
    expect(cmd.command).toContain("'mysql is a word'");
    expect(cmd.command.startsWith('mariadb ')).toBe(true);
  });

  it('leaves every other dialect on its own client', () => {
    for (const dialect of ['mysql', 'tidb', 'postgres', 'redshift']) {
      const cmd = build('SELECT 1;', dialect, t as never);
      if ('error' in cmd) throw new Error(cmd.error);
      expect(cmd.client, dialect).toBe(dialect === 'mysql' || dialect === 'tidb' ? 'mysql' : 'psql');
    }
  });

  it('uses ysqlsh for YugabyteDB, which ships no psql', () => {
    expect(textOf(docker('yugabytedb'))).toContain(' ysqlsh -h ');
    expect(textOf(docker('postgres'))).toContain(' psql -h ');
  });

  it('reaches sqlcmd by path and trusts the container certificate', () => {
    const text = textOf(docker('sqlserver'));
    expect(text).toContain('/opt/mssql-tools18/bin/sqlcmd');
    // sqlcmd 18 refuses a self-signed certificate without -C.
    expect(text).toContain(' -C ');
  });

  it('runs the Db2 CLP through its instance owner’s login shell', () => {
    // Without the profile it fails with SQL10007N / -1390 even by absolute
    // path, because DB2INSTANCE and the library path come from there.
    const text = textOf(docker('db2', { username: 'db2inst1' }));
    expect(text).toContain('-u db2inst1');
    expect(text).toContain("bash -lc 'db2 -tvs'");
  });

  it('refuses, with a reason, where the image ships no usable client', () => {
    // Better than a command that dies with "executable file not found", which
    // does not say whether the tool or the image is at fault.
    expect(textOf(docker('cockroachdb'))).toMatch(/^ERROR:.*cockroach sql/);
    expect(textOf(docker('tidb'))).toMatch(/^ERROR:.*no SQL client/);
  });
});
