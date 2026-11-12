/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared delete path for Secrets and Variables: vault row first, then session
 * variables, so a failed API call leaves the list unchanged.
 */
import {
  deleteAppSecret,
  listAppSecrets,
  type AppSecretSummary,
} from '@/shared/api/appSecretsApi';
import type { SqlVariable } from '@/shared/lib/sql-variables';

export const APP_SECRETS_CHANGED_EVENT = 'foxschema-app-secrets-changed';

function notifyAppSecretsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(APP_SECRETS_CHANGED_EVENT));
}

/** Secrets panel trash: drop the vault row, then every session Variable of that name. */
export async function deleteVaultSecretAndVariables(
  secret: AppSecretSummary,
  variables: SqlVariable[],
  deleteVariable: (id: string) => void
): Promise<void> {
  await deleteAppSecret(secret.id);
  for (const variable of variables) {
    if (variable.name === secret.name) deleteVariable(variable.id);
  }
}

/**
 * Variables panel trash: if this is a secret, drop the vault row first so the
 * next Run cannot merge it back. Public variables are local-only.
 */
export async function deleteSecretVariable(
  variable: SqlVariable,
  deleteVariable: (id: string) => void
): Promise<void> {
  if (!variable.secret) {
    deleteVariable(variable.id);
    return;
  }
  const secrets = await listAppSecrets();
  const match = secrets.find((s) => s.name === variable.name);
  if (match) await deleteAppSecret(match.id);
  deleteVariable(variable.id);
  notifyAppSecretsChanged();
}
