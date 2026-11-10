import { getApiBase, parseJsonResponse } from './apiBase';
import { api } from './client';
import type { CloudSecretProviderId } from '../lib/cloud-provider-settings';

export type AppSecretSource = 'local' | CloudSecretProviderId;

export type AppSecretCloudRef = {
  secretId: string;
  credentialId?: string;
  region?: string;
  vaultUrl?: string;
  version?: string;
};

export type AppSecretSummary = {
  id: string;
  name: string;
  source: AppSecretSource;
  hasValue: boolean;
  cloudRef: AppSecretCloudRef | null;
  updatedAt: string;
};

/** Named cloud credential (Credentials → Cloud providers). Never includes tokens. */
export type CloudProviderCredentialSummary = {
  id: string;
  name: string;
  provider: CloudSecretProviderId;
  updatedAt: string;
  auth?: 'oauth' | 'wif';
  email?: string;
  projectId?: string;
};

export type AwsProviderCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
};

export type GcpProviderCredentials = {
  auth?: 'oauth' | 'wif';
  serviceAccountJson?: string;
  accessToken?: string;
  projectId?: string;
};

export type GcpProjectSummary = { id: string; name: string };
export type GcpSecretSummary = { id: string; name: string };
export type GcpSecretVersionSummary = { id: string; name: string; state: string };

export type AzureProviderCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export type CloudProviderCredentials =
  | AwsProviderCredentials
  | GcpProviderCredentials
  | AzureProviderCredentials;

export async function listAppSecrets(): Promise<AppSecretSummary[]> {
  const data = await api.get<{ secrets: AppSecretSummary[] }>(`/app-secrets`);
  return data.secrets ?? [];
}

export async function createAppSecret(input: {
  name: string;
  source: AppSecretSource;
  value?: string;
  cloudRef?: AppSecretCloudRef;
}): Promise<AppSecretSummary> {
  const data = await api.post<{ secret: AppSecretSummary }>(`/app-secrets`, input);
  return data.secret;
}

export async function deleteAppSecret(id: string): Promise<void> {
  await api.delete<{ ok: boolean }>(`/app-secrets/${encodeURIComponent(id)}`);
}

export async function resolveAppSecrets(names?: string[]): Promise<{
  secrets: Record<string, string>;
  errors: Record<string, string>;
}> {
  const res = await fetch(`${getApiBase()}/app-secrets/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(names ? { names } : {}),
  });
  return parseJsonResponse(res);
}

export async function listCloudProviders(): Promise<CloudProviderCredentialSummary[]> {
  const data = await api.get<{ providers: CloudProviderCredentialSummary[] }>(`/app-secrets/providers`);
  return data.providers ?? [];
}

export async function createCloudProviderCredential(input: {
  name: string;
  provider: CloudSecretProviderId;
  credentials: CloudProviderCredentials;
}): Promise<CloudProviderCredentialSummary> {
  const data = await api.post<{ provider: CloudProviderCredentialSummary }>(`/app-secrets/providers`, input);
  return data.provider;
}

export async function updateCloudProviderCredential(
  id: string,
  input: { name?: string; credentials?: CloudProviderCredentials }
): Promise<CloudProviderCredentialSummary> {
  const data = await api.put<{ provider: CloudProviderCredentialSummary }>(`/app-secrets/providers/${encodeURIComponent(id)}`, input);
  return data.provider;
}

export async function deleteCloudProviderCredential(id: string): Promise<void> {
  await api.delete<{ ok: boolean }>(`/app-secrets/providers/${encodeURIComponent(id)}`);
}

export function gcpOAuthStartUrl(name?: string): string {
  const path = `${getApiBase()}/app-secrets/providers/gcp/oauth/start`;
  const trimmed = name?.trim();
  return trimmed ? `${path}?name=${encodeURIComponent(trimmed)}` : path;
}

export async function disconnectGcpCloudProvider(id: string): Promise<void> {
  await api.post<{ ok: boolean }>(
    `/app-secrets/providers/${encodeURIComponent(id)}/gcp/disconnect`,
    {}
  );
}

export async function listGcpProjects(credentialId: string): Promise<GcpProjectSummary[]> {
  const data = await api.get<{ projects: GcpProjectSummary[] }>(
    `/app-secrets/providers/${encodeURIComponent(credentialId)}/gcp/projects`
  );
  return data.projects ?? [];
}

export async function listGcpSecrets(
  credentialId: string,
  project: string
): Promise<GcpSecretSummary[]> {
  const data = await api.get<{ secrets: GcpSecretSummary[] }>(
    `/app-secrets/providers/${encodeURIComponent(credentialId)}/gcp/secrets`,
    { query: { project } }
  );
  return data.secrets ?? [];
}

export async function listGcpSecretVersions(
  credentialId: string,
  secretId: string,
  project: string
): Promise<GcpSecretVersionSummary[]> {
  const data = await api.get<{ versions: GcpSecretVersionSummary[] }>(
    `/app-secrets/providers/${encodeURIComponent(credentialId)}/gcp/secrets/${encodeURIComponent(secretId)}/versions`,
    { query: { project } }
  );
  return data.versions ?? [];
}
