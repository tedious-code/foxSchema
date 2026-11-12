import { getApiBase } from './apiBase';
import { api } from './client';
import type { CloudSecretProviderId } from '../lib/cloud-provider-settings';

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


export type AzureProviderCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export type CloudProviderCredentials =
  | AwsProviderCredentials
  | GcpProviderCredentials
  | AzureProviderCredentials;

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

