/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which saved connections workflows may use, and on whose behalf.
 *
 * A saved connection belongs to one user and is decrypted only for that user.
 * Workflows run on a schedule with nobody signed in, so the owner grants a
 * connection explicitly. The engine can then resolve that connection — as its
 * owner, per run — and no other. Revoking the grant stops the next run.
 */
import type {
  ResolvedWorkflowConnection,
  WorkflowConnectionSummary,
} from '@foxschema/workflow-contract';
import { getStore } from '../../database/store';
import { ConnectionStore } from '../connections/connection-store.service';
import type { WorkspaceScope } from '../../platform/http/scope';

export class WorkflowConnectionGrants {
  constructor(
    private readonly connections: Pick<ConnectionStore, 'list' | 'resolve'> = new ConnectionStore(),
  ) {}

  /** The workspace's saved connections, each marked with whether the caller lets workflows use it. */
  async list(scope: WorkspaceScope): Promise<WorkflowConnectionSummary[]> {
    const store = await getStore();
    const [saved, rows] = await Promise.all([
      this.connections.list(scope),
      store.all<{ connection_id: string }>(
        'SELECT connection_id FROM workflow_connection_grants WHERE user_id = ?',
        [scope.userId],
      ),
    ]);
    const granted = new Set(rows.map((row) => row.connection_id));
    return saved.map((connection) => ({
      id: connection.id,
      name: connection.name,
      dialect: connection.dialect,
      ...(connection.schema ? { schema: connection.schema } : {}),
      ...(connection.host ? { host: connection.host } : {}),
      ...(connection.database ? { database: connection.database } : {}),
      hasPassword: connection.hasPassword,
      granted: granted.has(connection.id),
    }));
  }

  /**
   * Grant the connection and resolve with its name — undefined when it is not
   * the caller's, so there is nothing of theirs to grant.
   */
  async grant(scope: WorkspaceScope, connectionId: string): Promise<string | undefined> {
    const userId = scope.userId;
    const connection = await this.connections.resolve(scope, connectionId);
    if (!connection) return undefined;
    const store = await getStore();
    await store.upsert(
      'workflow_connection_grants',
      ['connection_id'],
      { connection_id: connectionId, user_id: userId, created_at: new Date().toISOString() },
      ['user_id', 'created_at'],
    );
    return connection.name;
  }

  async revoke(userId: string, connectionId: string): Promise<boolean> {
    const store = await getStore();
    const result = await store.run(
      'DELETE FROM workflow_connection_grants WHERE connection_id = ? AND user_id = ?',
      [connectionId, userId],
    );
    return result.changes > 0;
  }

  /**
   * The decrypted connection, when it is granted and its owner still has it.
   * Only the engine's token-guarded route calls this.
   */
  async resolveForEngine(connectionId: string): Promise<ResolvedWorkflowConnection | undefined> {
    const store = await getStore();
    // The granter must still be a member of the connection's workspace: one
    // who left (or was removed) no longer lends it to workflows.
    const grant = await store.get<{ user_id: string; workspace_id: string }>(
      `SELECT g.user_id, c.workspace_id
       FROM workflow_connection_grants g
       JOIN connections c ON c.id = g.connection_id
       JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = g.user_id
       WHERE g.connection_id = ?`,
      [connectionId],
    );
    if (!grant) return undefined;
    const resolved = await this.connections.resolve({ userId: grant.user_id, workspaceId: grant.workspace_id }, connectionId);
    if (!resolved) return undefined;
    return {
      dialect: resolved.dialect,
      ...(resolved.schema ? { schema: resolved.schema } : {}),
      option: { ...resolved.option } as Record<string, unknown>,
    };
  }
}
