import { password as passwordPrompt, select } from '@inquirer/prompts';
import { buildConnectionString, type ConnectionOptions } from '@foxschema/db';
import { getContext } from './store';

export interface ResolvedRef {
  dialect: string;
  option: ConnectionOptions;
  schema: string;
}

/** CLI flags that name a connection: a saved name/id, or inline fields. */
export interface RefFlags {
  connection?: string; // saved connection name or id
  dialect?: string;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  schema?: string;
  url?: string; // full connection string
}

/**
 * Resolve a connection reference to concrete credentials. Order:
 *   1. --connection <name|id>  → decrypt a saved connection
 *   2. --url <conn-string> (+ --dialect)
 *   3. inline --dialect/--host/--database/--user (+ password from env or prompt)
 * Passwords are never taken from a flag (they leak into history/`ps`).
 */
export async function resolveRef(flags: RefFlags): Promise<ResolvedRef> {
  if (flags.connection) {
    const ctx = await getContext();
    const list = await ctx.connections.list(ctx.scope);
    const match = list.find((c) => c.id === flags.connection || c.name === flags.connection);
    if (!match) throw new Error(`Saved connection "${flags.connection}" not found (see \`fox connections list\`).`);
    const resolved = await ctx.connections.resolve(ctx.scope, match.id);
    if (!resolved) throw new Error('Could not decrypt the saved connection.');
    return { dialect: resolved.dialect, option: resolved.option, schema: flags.schema ?? resolved.schema ?? '' };
  }

  if (!flags.dialect) {
    throw new Error('Provide --connection <name>, or --dialect with connection details (or --url).');
  }

  const option: ConnectionOptions = {
    connectionString: flags.url,
    host: flags.host,
    port: flags.port ? Number(flags.port) : undefined,
    database: flags.database,
    username: flags.user,
    schema: flags.schema,
    password: process.env.FOXSCHEMA_DB_PASSWORD || undefined,
  };

  if (!option.connectionString && !option.password) {
    option.password = await passwordPrompt({
      message: `Password for ${flags.user ?? 'user'}@${flags.host ?? 'host'}:`,
      mask: true,
    });
  }
  if (!option.connectionString) option.connectionString = buildConnectionString(flags.dialect, option);

  return { dialect: flags.dialect, option, schema: flags.schema ?? '' };
}

async function promptForSavedConnection(role: 'source' | 'target'): Promise<string> {
  const ctx = await getContext();
  const list = await ctx.connections.list(ctx.scope);
  if (list.length === 0) {
    throw new Error(`No saved connections yet — add one with \`fox connections add\`, then re-run this.`);
  }
  return select({
    message: `Pick the ${role} connection:`,
    choices: list.map((c) => ({
      name: `${c.name || '(unnamed)'}  [${c.dialect}]  ${[c.host, c.database, c.schema].filter(Boolean).join(' / ')}`,
      value: c.id,
    })),
  });
}

/**
 * `compare`/`migrate` need both --source and --target. In a real terminal, a
 * missing one is prompted for interactively (pick from saved connections)
 * instead of hard-failing — the flags stay required for scripts/CI, where
 * stdin/stdout aren't a TTY and prompting would just hang.
 */
export async function ensureSourceTarget(opts: {
  source?: string;
  target?: string;
}): Promise<{ source: string; target: string }> {
  if (opts.source && opts.target) return { source: opts.source, target: opts.target };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Both --source and --target are required (a saved connection name or id).');
  }
  const source = opts.source ?? (await promptForSavedConnection('source'));
  const target = opts.target ?? (await promptForSavedConnection('target'));
  return { source, target };
}
