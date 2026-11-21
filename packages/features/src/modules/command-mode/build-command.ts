/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The entry point for command mode: SQL plus a connection, out comes the
 * shell command that runs it.
 */
import type { CliTarget, GeneratedCommand } from './cli.types.js';
import { cliFor } from './cli.registry.js';

/**
 * The command that runs `sql` against `target` using `dialect`'s own client.
 *
 * Returns `{ error }` rather than an approximation when the dialect has no
 * client or the connection details cannot be put on a command line — a command
 * that is nearly right is worse than none, because it will be pasted into a
 * terminal and run.
 */
/**
 * Where each engine's client lives inside its own official image.
 *
 * Only for clients that are present but not on PATH there — the mssql images
 * keep sqlcmd in /opt/mssql-tools18/bin — or absent under the expected name,
 * as with YugabyteDB's `ysqlsh`. That is a property of the image, not of the
 * engine, which is why it applies to this format alone.
 *
 * A client with a different *name* does not belong here, because every format
 * needs it: MariaDB 11 ships `mariadb` and no `mysql`, and the fix for that is
 * its own emitter in `providers/mariaDb/mariadb.cli.ts`, one level down, where
 * the raw and script forms get it too. YugabyteDB stays here on purpose — its
 * image has no psql, but it speaks the PostgreSQL wire protocol, so psql on a
 * host works and naming ysqlsh everywhere would break that reader instead.
 *
 * Keyed by dialect, not by emitter: CockroachDB, YugabyteDB and Redshift share
 * the PostgreSQL emitter, so putting this on the emitter would apply one
 * image's layout to another's.
 */
const DOCKER_CLIENT: Record<string, string> = {
  sqlserver: '/opt/mssql-tools18/bin/sqlcmd',
  azuresql: '/opt/mssql-tools18/bin/sqlcmd',
  yugabytedb: 'ysqlsh',
};

/** Flags that only make sense against a local container. */
const DOCKER_FLAGS: Record<string, string[]> = {
  // sqlcmd 18 encrypts by default and refuses a container's self-signed
  // certificate outright, so without -C it cannot connect at all.
  sqlserver: ['-C'],
  azuresql: ['-C'],
};

/**
 * Images that ship no client this emitter can drive, with the reason.
 *
 * Saying so beats emitting a command that dies with "executable file not found
 * in $PATH" — the reader cannot tell from that whether the tool is wrong or the
 * image is.
 */
const NO_DOCKER_CLIENT: Record<string, string> = {
  cockroachdb:
    'The CockroachDB image ships `cockroach sql`, which does not take psql\'s flags. Run the command from a machine with psql — CockroachDB speaks the PostgreSQL wire protocol, so psql works against it.',
  tidb: 'The TiDB image ships no SQL client. Run the command from a machine that has the mysql client.',
};

export function buildCliCommand(
  sql: string,
  dialect: string,
  target: CliTarget
): GeneratedCommand | { error: string } {
  if (!sql.trim()) return { error: 'There is no SQL to run yet.' };

  const key = (dialect || '').toLowerCase();
  const cli = cliFor(dialect);
  if (!cli) {
    return {
      error: `Command mode has no client for ${dialect || 'this engine'}. MongoDB and Redis do not take SQL, so there is nothing to hand to one.`,
    };
  }
  const built = cli.run(sql, target);
  if ('error' in built) return built;

  // Attached here rather than in the emitter, because several dialects share
  // one emitter but run in different images.
  return {
    ...built,
    ...(DOCKER_CLIENT[key] ? { dockerClient: DOCKER_CLIENT[key] } : {}),
    ...(DOCKER_FLAGS[key] ? { dockerFlags: DOCKER_FLAGS[key] } : {}),
    ...(NO_DOCKER_CLIENT[key] ? { dockerUnsupported: NO_DOCKER_CLIENT[key] } : {}),
  };
}

/**
 * The whole thing as one block to copy: how to supply the password, then the
 * command.
 *
 * Kept separate from {@link buildCliCommand} so a caller that renders the
 * parts itself is not forced through string assembly.
 */
export function renderCliCommand(generated: GeneratedCommand): string {
  const lines: string[] = [];
  if (generated.auth === 'environment' && generated.envVar) {
    // Not "or let it prompt": the statement arrives on stdin through a
    // here-document, so no client here can read a prompt.
    lines.push(`# export ${generated.envVar}=…   # the client cannot prompt here`);
  }
  lines.push(generated.command);
  return lines.join('\n');
}
