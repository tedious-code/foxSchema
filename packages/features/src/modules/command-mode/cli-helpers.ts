/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The shared shape of a command-mode emitter, so each engine's file holds only
 * what is different about that engine's client.
 */
import type { CliTarget, GeneratedCommand } from './cli.types.js';
import { checkConnectionPart, heredoc, shellQuote } from './shell.js';

/** Validate the parts an emitter is about to put on the command line. */
export function checkTarget(
  target: CliTarget,
  required: ReadonlyArray<'host' | 'database' | 'username' | 'file'>
): string | null {
  const labels = {
    host: 'Host',
    database: 'Database',
    username: 'User name',
    file: 'File path',
  } as const;
  for (const key of required) {
    const bad = checkConnectionPart(labels[key], String(target[key] ?? ''));
    if (bad) return bad;
  }
  if (target.port !== undefined && !Number.isInteger(target.port)) {
    return 'Port must be a whole number.';
  }
  return null;
}

/**
 * Assemble `<client> <flags> <<'DELIM' … DELIM`.
 *
 * The statement always arrives on stdin through a quoted heredoc rather than
 * in a `-c` argument, so nothing in it is re-interpreted by the shell.
 */
export function commandWithSql(args: {
  client: string;
  flags: string[];
  sql: string;
  explanation: string;
  auth: GeneratedCommand['auth'];
  envVar?: string;
  dockerClient?: string;
  dockerFlags?: string[];
  dockerUser?: string;
  note?: string;
}): GeneratedCommand | { error: string } {
  const head = [args.client, ...args.flags].join(' ');
  const body = args.sql.trim();
  const built = heredoc(head, body);
  if (typeof built !== 'string') return built;
  return {
    command: built,
    invocation: head,
    body,
    explanation: args.explanation,
    client: args.client,
    auth: args.auth,
    ...(args.envVar ? { envVar: args.envVar } : {}),
    ...(args.dockerClient ? { dockerClient: args.dockerClient } : {}),
    ...(args.dockerFlags?.length ? { dockerFlags: args.dockerFlags } : {}),
    ...(args.dockerUser ? { dockerUser: args.dockerUser } : {}),
    ...(args.note ? { note: args.note } : {}),
  };
}

export { shellQuote };
