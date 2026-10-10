import { randomUUID } from 'node:crypto';
import type { WorkspaceScope } from '../../platform/http/scope';
import { getStore } from '../../database/store';
import { encryptSecret, decryptSecret } from '../../platform/crypto/crypto';
import { rethrowUniqueViolation } from '../../platform/db/db-errors';
import type {
  AwsProviderCredentials,
  AzureProviderCredentials,
  CloudProviderCredentials,
  CloudSecretSource,
  GcpProviderCredentials,
} from '../../internal/cloud-secrets';
import { isCloudSecretSource } from '../../internal/cloud-secrets';

export type {
  AwsProviderCredentials,
  AzureProviderCredentials,
  CloudProviderCredentials,
  GcpProviderCredentials,
} from '../../internal/cloud-secrets';

/** Named cloud credential (like a saved DB connection) — used by Secrets fetch. */
export type CloudProviderCredentialSummary = {
  id: string;
  name: string;
  provider: CloudSecretSource;
  updatedAt: string;
};

interface CredRow {
  id: string;
  name: string;
  provider: string;
  encrypted_config: string;
  updated_at: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export function isValidCloudCredentialName(name: string): boolean {
  return NAME_RE.test(name.trim());
}

function validateCredentials(
  provider: CloudSecretSource,
  creds: CloudProviderCredentials
): CloudProviderCredentials {
  if (provider === 'aws') {
    const c = creds as AwsProviderCredentials;
    if (!c.accessKeyId?.trim() || !c.secretAccessKey?.trim()) {
      throw new Error('AWS credentials require accessKeyId and secretAccessKey');
    }
    return {
      accessKeyId: c.accessKeyId.trim(),
      secretAccessKey: c.secretAccessKey.trim(),
      ...(c.sessionToken?.trim() ? { sessionToken: c.sessionToken.trim() } : {}),
      ...(c.region?.trim() ? { region: c.region.trim() } : {}),
    };
  }
  if (provider === 'gcp') {
    const c = creds as GcpProviderCredentials;
    const json = c.serviceAccountJson?.trim();
    const token = c.accessToken?.trim();
    if (!json && !token) {
      throw new Error('GCP credentials require serviceAccountJson or accessToken');
    }
    if (json) {
      try {
        JSON.parse(json);
      } catch {
        throw new Error('GCP serviceAccountJson must be valid JSON');
      }
    }
    return {
      ...(json ? { serviceAccountJson: json } : {}),
      ...(token ? { accessToken: token } : {}),
    };
  }
  const c = creds as AzureProviderCredentials;
  if (!c.tenantId?.trim() || !c.clientId?.trim() || !c.clientSecret?.trim()) {
    throw new Error('Azure credentials require tenantId, clientId, and clientSecret');
  }
  return {
    tenantId: c.tenantId.trim(),
    clientId: c.clientId.trim(),
    clientSecret: c.clientSecret.trim(),
  };
}

function toSummary(row: CredRow): CloudProviderCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as CloudSecretSource,
    updatedAt: row.updated_at,
  };
}

/**
 * Per-user named cloud provider credentials (AWS / GCP / Azure API tokens).
 * Multiple named slots per provider — Secrets picks one from a dropdown to fetch.
 */
export class CloudProviderCredentialsStore {
  async list(scope: WorkspaceScope): Promise<CloudProviderCredentialSummary[]> {
    const store = await getStore();
    const rows = await store.all<CredRow>(
      `SELECT id, name, provider, encrypted_config, updated_at
       FROM cloud_provider_credentials WHERE workspace_id = ?
       ORDER BY name ASC`,
      [scope.workspaceId]
    );
    return rows.map(toSummary);
  }

  async getDecryptedById(
    scope: WorkspaceScope,
    id: string
  ): Promise<{ provider: CloudSecretSource; credentials: CloudProviderCredentials } | null> {
    const store = await getStore();
    const row = await store.get<CredRow>(
      `SELECT id, name, provider, encrypted_config, updated_at
       FROM cloud_provider_credentials WHERE workspace_id = ? AND id = ?`,
      [scope.workspaceId, id]
    );
    if (!row || !isCloudSecretSource(row.provider)) return null;
    try {
      return {
        provider: row.provider,
        credentials: JSON.parse(decryptSecret(row.encrypted_config)) as CloudProviderCredentials,
      };
    } catch {
      throw new Error(`Stored credentials "${row.name}" could not be decrypted`);
    }
  }

  /** Prefer a named credential; else first saved cred for that provider (legacy refs). */
  async resolveCredentials(
    scope: WorkspaceScope,
    provider: CloudSecretSource,
    credentialId?: string
  ): Promise<CloudProviderCredentials | undefined> {
    if (credentialId) {
      const byId = await this.getDecryptedById(scope, credentialId);
      if (!byId) throw new Error('Cloud credential not found');
      if (byId.provider !== provider) {
        throw new Error(
          `Cloud credential is for ${byId.provider}, but secret source is ${provider}`
        );
      }
      return byId.credentials;
    }
    const store = await getStore();
    const row = await store.get<CredRow>(
      `SELECT id, name, provider, encrypted_config, updated_at
       FROM cloud_provider_credentials
       WHERE workspace_id = ? AND provider = ?
       ORDER BY name ASC
       LIMIT 1`,
      [scope.workspaceId, provider]
    );
    if (!row) return undefined;
    try {
      return JSON.parse(decryptSecret(row.encrypted_config)) as CloudProviderCredentials;
    } catch {
      throw new Error(`Stored ${provider} credentials could not be decrypted`);
    }
  }

  async create(
    scope: WorkspaceScope,
    name: string,
    provider: CloudSecretSource,
    credentials: CloudProviderCredentials
  ): Promise<CloudProviderCredentialSummary> {
    if (!isCloudSecretSource(provider)) {
      throw new Error(`Unknown cloud provider: ${provider}`);
    }
    const trimmed = name.trim();
    if (!isValidCloudCredentialName(trimmed)) {
      throw new Error(
        'Invalid credential name — use letters, digits, spaces, ._- (1–64 chars)'
      );
    }
    const normalized = validateCredentials(provider, credentials);
    const encrypted = encryptSecret(JSON.stringify(normalized));
    const updatedAt = new Date().toISOString();
    const id = randomUUID();
    const store = await getStore();
    try {
      await store.run(
        `INSERT INTO cloud_provider_credentials (id, user_id, workspace_id, name, provider, encrypted_config, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, scope.userId, scope.workspaceId, trimmed, provider, encrypted, updatedAt]
      );
    } catch (err: unknown) {
      rethrowUniqueViolation(err, `A cloud credential named "${trimmed}" already exists`);
    }
    return { id, name: trimmed, provider, updatedAt };
  }

  async update(
    scope: WorkspaceScope,
    id: string,
    input: {
      name?: string;
      credentials?: CloudProviderCredentials;
    }
  ): Promise<CloudProviderCredentialSummary | null> {
    const store = await getStore();
    const existing = await store.get<CredRow>(
      `SELECT id, name, provider, encrypted_config, updated_at
       FROM cloud_provider_credentials WHERE workspace_id = ? AND id = ?`,
      [scope.workspaceId, id]
    );
    if (!existing || !isCloudSecretSource(existing.provider)) return null;

    let nextName = existing.name;
    if (input.name !== undefined) {
      nextName = input.name.trim();
      if (!isValidCloudCredentialName(nextName)) {
        throw new Error(
          'Invalid credential name — use letters, digits, spaces, ._- (1–64 chars)'
        );
      }
    }

    let encrypted = existing.encrypted_config;
    if (input.credentials) {
      const normalized = validateCredentials(existing.provider, input.credentials);
      encrypted = encryptSecret(JSON.stringify(normalized));
    }

    const updatedAt = new Date().toISOString();
    try {
      await store.run(
        `UPDATE cloud_provider_credentials
         SET name = ?, encrypted_config = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
        [nextName, encrypted, updatedAt, id, scope.workspaceId]
      );
    } catch (err: unknown) {
      rethrowUniqueViolation(err, `A cloud credential named "${nextName}" already exists`);
    }
    return {
      id,
      name: nextName,
      provider: existing.provider,
      updatedAt,
    };
  }

  async remove(scope: WorkspaceScope, id: string): Promise<boolean> {
    const store = await getStore();
    const result = await store.run(
      'DELETE FROM cloud_provider_credentials WHERE workspace_id = ? AND id = ?',
      [scope.workspaceId, id]
    );
    return (result.changes ?? 0) > 0;
  }
}
