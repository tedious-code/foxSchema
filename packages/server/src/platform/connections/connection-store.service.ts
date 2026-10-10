import type { WorkspaceScope } from '../http/scope';
import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';
import { encryptSecret, decryptSecret } from '../crypto/crypto';
import { ConnectionOptions, buildConnectionString, resolveAuthMethod, assertWindowsAccount } from '@foxschema/db';

export interface SavedConnectionInput {
  name?: string;
  dialect: string;
  schema?: string;
  option: ConnectionOptions;
  /**
   * Whether to persist the password. Default (undefined) keeps the password that was
   * supplied. When explicitly `false`, the password is never stored (and cleared on an
   * update), so the user re-enters it each session.
   */
  savePassword?: boolean;
}

/** Safe-to-send connection metadata — never includes the password. */
export interface SavedConnectionSummary {
  id: string;
  name: string;
  dialect: string;
  schema?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  /** How Fox authenticates: password (default), windows (NTLM), ldap (Db2 directory). */
  authMethod?: string;
  /** NTLM domain when authMethod is windows (not a secret). */
  domain?: string;
  /** Whether a password is stored (so the edit form can reflect the checkbox). */
  hasPassword: boolean;
  createdAt: string;
}

interface ConnectionRow {
  id: string;
  name: string | null;
  dialect: string;
  schema: string | null;
  encrypted_config: string;
  created_at: string;
}

/**
 * Per-user saved connections. The full option (with password) is AES-256-GCM
 * encrypted at rest and only ever decrypted server-side (`resolve`) — the
 * client receives metadata only, never the secret.
 */
export class ConnectionStore {
  /**
   * Decide what password (if any) to persist for a save, and always rebuild
   * `connectionString` from the result — the single place both create() and update()
   * go through, so the password rule can never drift between them.
   *
   * Rebuilding connectionString unconditionally is required, not optional: the client
   * builds `option.connectionString` from the form BEFORE the save intent is known, so
   * for URL-style dialects (Postgres/MySQL/MariaDB) or SQL Server's `Password=...;`
   * format it already embeds the plaintext password the caller may be opting out of.
   * If we only cleared `option.password` and left connectionString alone, the secret
   * would still be persisted inside it, defeating the opt-out entirely.
   *
   * The stale connectionString must also be discarded BEFORE rebuilding, not just
   * overwritten after: those same dialects' buildConnectionString() honors an existing
   * connectionString verbatim instead of reconstructing it from host/user/password, so
   * rebuilding "in place" would silently keep the old embedded password unchanged.
   */
  private resolvePasswordOnSave(
    dialect: string,
    option: ConnectionOptions,
    savePassword: boolean | undefined,
    existingPassword?: string
  ): ConnectionOptions {
    const resolved: ConnectionOptions = { ...option, connectionString: undefined };
    const incoming =
      typeof resolved.password === 'string' && resolved.password.length > 0
        ? resolved.password
        : undefined;
    if (savePassword === false) {
      resolved.password = undefined; // user opted out — never persist a secret
    } else if (incoming) {
      resolved.password = incoming;
    } else if (existingPassword) {
      // Edit omitted / blank password — keep the stored secret.
      resolved.password = existingPassword;
    } else {
      resolved.password = undefined; // treat "" like missing so hasPassword stays accurate
    }
    const authMethod = resolveAuthMethod(dialect, resolved.authMethod);
    resolved.authMethod = authMethod === 'password' ? undefined : authMethod;
    if (authMethod !== 'windows') resolved.domain = undefined;
    else if (typeof resolved.domain === 'string') resolved.domain = resolved.domain.trim() || undefined;
    if (authMethod === 'windows') assertWindowsAccount(resolved.username, resolved.domain);
    resolved.connectionString = buildConnectionString(dialect, resolved);
    return resolved;
  }

  private publicFields(opt: ConnectionOptions): Pick<
    SavedConnectionSummary,
    'host' | 'port' | 'database' | 'username' | 'authMethod' | 'domain' | 'hasPassword'
  > {
    const stored = typeof opt.authMethod === 'string' ? opt.authMethod.trim().toLowerCase() : '';
    return {
      host: opt.host,
      port: opt.port,
      database: opt.database,
      username: opt.username,
      authMethod: stored === 'windows' || stored === 'ldap' ? stored : undefined,
      domain: typeof opt.domain === 'string' && opt.domain.trim() ? opt.domain.trim() : undefined,
      hasPassword: typeof opt.password === 'string' && opt.password.length > 0,
    };
  }

  private toSummary(row: ConnectionRow): SavedConnectionSummary {
    let fields: ReturnType<ConnectionStore['publicFields']> = {
      hasPassword: false,
    };
    try {
      const opt = JSON.parse(decryptSecret(row.encrypted_config)) as ConnectionOptions;
      fields = this.publicFields(opt);
    } catch {
      /* unreadable (key rotated?) — show metadata without connection fields */
    }
    return {
      id: row.id,
      name: row.name ?? '',
      dialect: row.dialect,
      schema: row.schema ?? undefined,
      ...fields,
      createdAt: row.created_at,
    };
  }

  async list(scope: WorkspaceScope): Promise<SavedConnectionSummary[]> {
    const store = await getStore();
    const rows = await store.all<ConnectionRow>(
      'SELECT id, name, dialect, "schema", encrypted_config, created_at FROM connections WHERE workspace_id = ? ORDER BY created_at DESC',
      [scope.workspaceId]
    );
    return rows.map((r) => this.toSummary(r));
  }

  async create(scope: WorkspaceScope, input: SavedConnectionInput): Promise<SavedConnectionSummary> {
    const store = await getStore();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const option = this.resolvePasswordOnSave(input.dialect, input.option, input.savePassword);
    await store.run(
      'INSERT INTO connections (id, user_id, workspace_id, name, dialect, "schema", encrypted_config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, scope.userId, scope.workspaceId, input.name ?? null, input.dialect, input.schema ?? null, encryptSecret(JSON.stringify(option)), createdAt]
    );
    return {
      id,
      name: input.name ?? '',
      dialect: input.dialect,
      schema: input.schema,
      ...this.publicFields(option),
      createdAt,
    };
  }

  /** Decrypted config for server-side use (connect/compare). Never sent to the client. */
  async resolve(
    scope: WorkspaceScope,
    id: string
  ): Promise<{ name: string; dialect: string; schema?: string; option: ConnectionOptions } | null> {
    const store = await getStore();
    const row = await store.get<{ name: string | null; dialect: string; schema: string | null; encrypted_config: string }>(
      'SELECT name, dialect, "schema", encrypted_config FROM connections WHERE id = ? AND workspace_id = ?',
      [id, scope.workspaceId]
    );
    if (!row) return null;
    return {
      name: row.name ?? '',
      dialect: row.dialect,
      schema: row.schema ?? undefined,
      option: JSON.parse(decryptSecret(row.encrypted_config)) as ConnectionOptions,
    };
  }

  /**
   * Update a saved connection. If the incoming option omits the password (the edit form
   * never receives it), the existing password is preserved — UNLESS the user unticked
   * "save password" (`savePassword === false`), in which case it's explicitly cleared.
   * The connection string is rebuilt so it stays valid either way.
   */
  async update(scope: WorkspaceScope, id: string, input: SavedConnectionInput): Promise<SavedConnectionSummary | null> {
    const store = await getStore();
    const existing = await this.resolve(scope, id);
    if (!existing) return null;

    const merged = this.resolvePasswordOnSave(input.dialect, input.option, input.savePassword, existing.option.password);

    await store.run(
      'UPDATE connections SET name = ?, dialect = ?, "schema" = ?, encrypted_config = ? WHERE id = ? AND workspace_id = ?',
      [input.name ?? null, input.dialect, input.schema ?? null, encryptSecret(JSON.stringify(merged)), id, scope.workspaceId]
    );

    const row = await store.get<ConnectionRow>(
      'SELECT id, name, dialect, "schema", encrypted_config, created_at FROM connections WHERE id = ? AND workspace_id = ?',
      [id, scope.workspaceId]
    );
    return row ? this.toSummary(row) : null;
  }

  async remove(scope: WorkspaceScope, id: string): Promise<boolean> {
    const store = await getStore();
    const result = await store.run('DELETE FROM connections WHERE id = ? AND workspace_id = ?', [id, scope.workspaceId]);
    return result.changes > 0;
  }
}
