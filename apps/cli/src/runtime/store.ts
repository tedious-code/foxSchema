import { requireReady } from './bootstrap';
import { AuthModule } from '@foxschema/server';
import { ConnectionStore } from '@foxschema/server';
import { MigrationHistoryStore } from '@foxschema/server';
import type { WorkspaceScope } from '@foxschema/server';

export interface CliContext {
  userId: string;
  /** The owner's own workspace: the CLI reads and writes its connections and history. */
  scope: WorkspaceScope;
  connections: ConnectionStore;
  history: MigrationHistoryStore;
}

let ctx: CliContext | null = null;

/**
 * Ready-to-use context: applies the stored config + keychain key to the env
 * (so the shared store/crypto run), resolves the install owner, and returns the
 * connection + history stores. Throws a clear message if not set up.
 */
export async function getContext(): Promise<CliContext> {
  if (ctx) return ctx;
  requireReady();
  // The CLI acts as the install owner — the same account the app's first-run
  // setup claims, so both see the same connections and history.
  const auth = new AuthModule();
  const user = await auth.ownerAccount();
  // Its own workspace, by id: the browser's last-used workspace must not
  // decide what the CLI lists and writes.
  const { workspace } = await auth.inWorkspace(user, await auth.personalWorkspaceId(user));
  ctx = { userId: user.id, scope: { userId: user.id, workspaceId: workspace.id }, connections: new ConnectionStore(), history: new MigrationHistoryStore() };
  return ctx;
}
