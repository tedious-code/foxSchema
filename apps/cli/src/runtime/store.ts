import { requireReady } from './bootstrap';
import { AuthModule } from '@foxschema/server';
import { ConnectionStore } from '@foxschema/server';
import { MigrationHistoryStore } from '@foxschema/server';

export interface CliContext {
  userId: string;
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
  const user = await new AuthModule().ownerAccount();
  ctx = { userId: user.id, connections: new ConnectionStore(), history: new MigrationHistoryStore() };
  return ctx;
}
