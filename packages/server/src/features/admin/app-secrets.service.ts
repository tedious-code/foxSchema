import { randomUUID } from 'node:crypto';
import type { WorkspaceScope } from '../../platform/http/scope';
import { getStore } from '../../database/store';
import { encryptSecret, decryptSecret } from '../../platform/crypto/crypto';
import {
  assertAzureVaultUrl,
  parseCloudRef,
  resolveCloudSecret,
  serializeCloudRef,
  type CloudSecretRef,
  type CloudSecretSource,
} from '../../internal/cloud-secrets';
import { rethrowUniqueViolation } from '../../platform/db/db-errors';
import { CloudProviderCredentialsStore } from './cloud-provider-credentials.service';
import type { CloudProviderCredentials } from '../../internal/cloud-secrets';
import { errorMessage } from '@foxschema/sql';

export type AppSecretSource = 'local' | CloudSecretSource;

export interface AppSecretInput {
  name: string;
  source: AppSecretSource;
  /** Plaintext for local secrets (create/update). Omitted on update keeps existing. */
  value?: string;
  cloudRef?: CloudSecretRef;
}

/** Safe metadata — never includes plaintext. */
export interface AppSecretSummary {
  id: string;
  name: string;
  source: AppSecretSource;
  hasValue: boolean;
  cloudRef: CloudSecretRef | null;
  updatedAt: string;
}

interface AppSecretRow {
  id: string;
  name: string;
  source: string;
  encrypted_value: string | null;
  cloud_ref: string | null;
  updated_at: string;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidSecretName(name: string): boolean {
  return NAME_RE.test(name);
}

function toSummary(row: AppSecretRow): AppSecretSummary {
  const source = row.source as AppSecretSource;
  const cloudRef = source === 'local' ? null : parseCloudRef(row.cloud_ref);
  return {
    id: row.id,
    name: row.name,
    source,
    hasValue: source === 'local' ? !!row.encrypted_value : !!cloudRef?.secretId,
    cloudRef,
    updatedAt: row.updated_at,
  };
}

/**
 * Per-user encrypted App Secrets vault (local AES-GCM values + cloud refs).
 * List never returns plaintext; use resolve() for run-time injection.
 */
export class AppSecretsStore {
  private readonly providers = new CloudProviderCredentialsStore();
  async list(scope: WorkspaceScope): Promise<AppSecretSummary[]> {
    const store = await getStore();
    const rows = await store.all<AppSecretRow>(
      `SELECT id, name, source, encrypted_value, cloud_ref, updated_at
       FROM app_secrets WHERE workspace_id = ? ORDER BY name ASC`,
      [scope.workspaceId]
    );
    return rows.map(toSummary);
  }

  async create(scope: WorkspaceScope, input: AppSecretInput): Promise<AppSecretSummary> {
    const name = input.name.trim();
    if (!isValidSecretName(name)) {
      throw new Error('Invalid secret name — use letters, digits, underscore (must start with a letter or _)');
    }
    if (!['local', 'aws', 'gcp', 'azure'].includes(input.source)) {
      throw new Error('source must be local, aws, gcp, or azure');
    }

    let encryptedValue: string | null = null;
    let cloudRefJson: string | null = null;
    if (input.source === 'local') {
      if (typeof input.value !== 'string' || input.value.length === 0) {
        throw new Error('Local secrets require a non-empty value');
      }
      encryptedValue = encryptSecret(input.value);
    } else {
      if (!input.cloudRef?.secretId?.trim()) {
        throw new Error('Cloud secrets require cloudRef.secretId');
      }
      if (input.source === 'azure' && !input.cloudRef.vaultUrl?.trim()) {
        throw new Error('Azure secrets require cloudRef.vaultUrl');
      }
      if (input.source === 'azure' && input.cloudRef.vaultUrl) {
        assertAzureVaultUrl(input.cloudRef.vaultUrl.trim());
      }
      cloudRefJson = serializeCloudRef({
        secretId: input.cloudRef.secretId.trim(),
        credentialId: input.cloudRef.credentialId,
        region: input.cloudRef.region,
        vaultUrl: input.cloudRef.vaultUrl?.trim(),
        version: input.cloudRef.version,
      });
    }

    const id = randomUUID();
    const updatedAt = new Date().toISOString();
    const store = await getStore();
    try {
      await store.run(
        `INSERT INTO app_secrets (id, user_id, workspace_id, name, source, encrypted_value, cloud_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, scope.userId, scope.workspaceId, name, input.source, encryptedValue, cloudRefJson, updatedAt]
      );
    } catch (err: unknown) {
      rethrowUniqueViolation(err, `A secret named "${name}" already exists`);
    }
    return {
      id,
      name,
      source: input.source,
      hasValue: true,
      cloudRef: input.source === 'local' ? null : parseCloudRef(cloudRefJson),
      updatedAt,
    };
  }

  async update(scope: WorkspaceScope, id: string, input: Partial<AppSecretInput>): Promise<AppSecretSummary | null> {
    const store = await getStore();
    const rows = await store.all<AppSecretRow>(
      `SELECT id, name, source, encrypted_value, cloud_ref, updated_at
       FROM app_secrets WHERE id = ? AND workspace_id = ?`,
      [id, scope.workspaceId]
    );
    const existing = rows[0];
    if (!existing) return null;

    const nextSource = (input.source ?? existing.source) as AppSecretSource;
    if (!['local', 'aws', 'gcp', 'azure'].includes(nextSource)) {
      throw new Error('source must be local, aws, gcp, or azure');
    }

    let nextName = existing.name;
    if (input.name !== undefined) {
      nextName = input.name.trim();
      if (!isValidSecretName(nextName)) {
        throw new Error('Invalid secret name — use letters, digits, underscore (must start with a letter or _)');
      }
    }

    let encryptedValue = existing.encrypted_value;
    let cloudRefJson: string | null;

    if (nextSource === 'local') {
      cloudRefJson = null;
      if (typeof input.value === 'string') {
        if (input.value.length === 0) throw new Error('Local secrets require a non-empty value');
        encryptedValue = encryptSecret(input.value);
      } else if (!encryptedValue) {
        throw new Error('Local secrets require a value');
      }
    } else {
      encryptedValue = null;
      const prev = parseCloudRef(existing.cloud_ref);
      const merged: CloudSecretRef = {
        secretId: (input.cloudRef?.secretId ?? prev?.secretId ?? '').trim(),
        credentialId: input.cloudRef?.credentialId ?? prev?.credentialId,
        region: input.cloudRef?.region ?? prev?.region,
        vaultUrl: input.cloudRef?.vaultUrl ?? prev?.vaultUrl,
        version: input.cloudRef?.version ?? prev?.version,
      };
      if (!merged.secretId) throw new Error('Cloud secrets require cloudRef.secretId');
      if (nextSource === 'azure' && !merged.vaultUrl?.trim()) {
        throw new Error('Azure secrets require cloudRef.vaultUrl');
      }
      if (nextSource === 'azure' && merged.vaultUrl) {
        assertAzureVaultUrl(merged.vaultUrl.trim());
        merged.vaultUrl = merged.vaultUrl.trim();
      }
      cloudRefJson = serializeCloudRef(merged);
    }

    const updatedAt = new Date().toISOString();
    try {
      await store.run(
        `UPDATE app_secrets
         SET name = ?, source = ?, encrypted_value = ?, cloud_ref = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
        [nextName, nextSource, encryptedValue, cloudRefJson, updatedAt, id, scope.workspaceId]
      );
    } catch (err: unknown) {
      rethrowUniqueViolation(err, `A secret named "${nextName}" already exists`);
    }

    return {
      id,
      name: nextName,
      source: nextSource,
      hasValue: nextSource === 'local' ? !!encryptedValue : true,
      cloudRef: nextSource === 'local' ? null : parseCloudRef(cloudRefJson),
      updatedAt,
    };
  }

  async remove(scope: WorkspaceScope, id: string): Promise<boolean> {
    const store = await getStore();
    const result = await store.run('DELETE FROM app_secrets WHERE id = ? AND workspace_id = ?', [id, scope.workspaceId]);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Decrypt / fetch plaintext secrets for the user.
   * Local failures and cloud failures are returned in `errors` without aborting siblings.
   * Session Variables with the same name should win at the call site.
   */
  async resolve(
    scope: WorkspaceScope,
    names?: string[]
  ): Promise<{ secrets: Record<string, string>; errors: Record<string, string> }> {
    const store = await getStore();
    let rows: AppSecretRow[];
    if (names && names.length > 0) {
      const placeholders = names.map(() => '?').join(',');
      rows = await store.all<AppSecretRow>(
        `SELECT id, name, source, encrypted_value, cloud_ref, updated_at
         FROM app_secrets WHERE workspace_id = ? AND name IN (${placeholders})`,
        [scope.workspaceId, ...names]
      );
    } else {
      rows = await store.all<AppSecretRow>(
        `SELECT id, name, source, encrypted_value, cloud_ref, updated_at
         FROM app_secrets WHERE workspace_id = ?`,
        [scope.workspaceId]
      );
    }

    const secrets: Record<string, string> = {};
    const errors: Record<string, string> = {};
    const credCache = new Map<string, CloudProviderCredentials | undefined>();

    const credsFor = async (
      source: 'aws' | 'gcp' | 'azure',
      credentialId?: string
    ): Promise<CloudProviderCredentials | undefined> => {
      const key = `${source}:${credentialId ?? ''}`;
      if (credCache.has(key)) return credCache.get(key);
      const creds = await this.providers.resolveCredentials(scope, source, credentialId);
      credCache.set(key, creds);
      return creds;
    };

    await Promise.all(
      rows.map(async (row) => {
        try {
          if (row.source === 'local') {
            if (!row.encrypted_value) {
              errors[row.name] = 'Local secret has no stored value';
              return;
            }
            secrets[row.name] = decryptSecret(row.encrypted_value);
            return;
          }
          const ref = parseCloudRef(row.cloud_ref);
          if (!ref) {
            errors[row.name] = 'Cloud secret is missing cloud_ref';
            return;
          }
          if (row.source !== 'aws' && row.source !== 'gcp' && row.source !== 'azure') {
            errors[row.name] = `Unknown source: ${row.source}`;
            return;
          }
          const providerCreds = await credsFor(row.source, ref.credentialId);
          secrets[row.name] = await resolveCloudSecret(row.source, ref, providerCreds);
        } catch (err: unknown) {
          errors[row.name] = errorMessage(err);
        }
      })
    );

    return { secrets, errors };
  }
}
