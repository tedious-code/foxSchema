import type { SqlVariable } from '@/shared/lib/sql-variables';
import { newTabId } from '@/features/sql-editor/state/sqlEditorTabLogic';

/**
 * Merge vault plaintext into the Variables list for a Run.
 * Session Variables with the same name win (vault entry skipped).
 */
export function mergeVaultSecretsIntoVariables(
  session: SqlVariable[],
  vault: Record<string, string>,
  now = Date.now()
): SqlVariable[] {
  const taken = new Set(session.map((v) => v.name));
  const extras: SqlVariable[] = [];
  for (const [name, value] of Object.entries(vault)) {
    if (taken.has(name)) continue;
    extras.push({
      id: `vault:${name}:${newTabId()}`,
      name,
      kind: 'scalar',
      value,
      secret: true,
      updatedAt: now,
    });
  }
  return extras.length === 0 ? session : [...session, ...extras];
}
