/**
 * Registry of cloud secret backends (AWS / GCP / Azure today).
 * Add a new entry here when supporting another secrets manager — UI + Secrets
 * dropdown pick up the provider automatically.
 */

export type CloudSecretProviderId = 'aws' | 'gcp' | 'azure';

export type CloudProviderField = {
  key: string;
  label: string;
  kind: 'password' | 'text' | 'textarea';
  required?: boolean;
  placeholder?: string;
  rows?: number;
};

export type CloudSecretProviderSettings = {
  id: CloudSecretProviderId;
  label: string;
  shortLabel: string;
  description: string;
  /** Tailwind badge classes (match Database credential dialect chips). */
  badge: string;
  dot: string;
  fields: CloudProviderField[];
};

export const CLOUD_SECRET_PROVIDERS: Record<CloudSecretProviderId, CloudSecretProviderSettings> = {
  aws: {
    id: 'aws',
    label: 'Amazon Web Services',
    shortLabel: 'AWS',
    description: 'Secrets Manager — access key credentials',
    badge: 'bg-orange-950/60 text-orange-300 border-orange-700/50',
    dot: 'bg-orange-400',
    fields: [
      {
        key: 'accessKeyId',
        label: 'Access key ID',
        kind: 'password',
        required: true,
        placeholder: 'AKIA…',
      },
      {
        key: 'secretAccessKey',
        label: 'Secret access key',
        kind: 'password',
        required: true,
      },
      {
        key: 'sessionToken',
        label: 'Session token',
        kind: 'password',
        placeholder: 'Optional',
      },
      {
        key: 'region',
        label: 'Default region',
        kind: 'text',
        placeholder: 'e.g. us-east-1',
      },
    ],
  },
  gcp: {
    id: 'gcp',
    label: 'Google Cloud',
    shortLabel: 'GCP',
    description: 'Secret Manager — Connect Google Cloud, or Workload Identity Federation',
    badge: 'bg-blue-950/60 text-blue-300 border-blue-700/50',
    dot: 'bg-blue-400',
    fields: [
      {
        key: 'projectId',
        label: 'GCP project id',
        kind: 'text',
        placeholder: 'my-gcp-project',
      },
      {
        key: 'serviceAccountJson',
        label: 'Workload Identity Federation config',
        kind: 'textarea',
        rows: 4,
        placeholder:
          'Paste type "external_account" client config (no private key). Prefer Connect Google Cloud for interactive use.',
      },
      {
        key: 'accessToken',
        label: 'OAuth access token',
        kind: 'password',
        placeholder: 'Or a short-lived bearer token',
      },
    ],
  },
  azure: {
    id: 'azure',
    label: 'Microsoft Azure',
    shortLabel: 'Azure',
    description: 'Key Vault — service principal',
    badge: 'bg-sky-950/60 text-sky-300 border-sky-700/50',
    dot: 'bg-sky-400',
    fields: [
      {
        key: 'tenantId',
        label: 'Tenant ID',
        kind: 'text',
        required: true,
      },
      {
        key: 'clientId',
        label: 'Client ID',
        kind: 'text',
        required: true,
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        kind: 'password',
        required: true,
      },
    ],
  },
};

export const CLOUD_SECRET_PROVIDER_LIST = Object.values(CLOUD_SECRET_PROVIDERS);

export function getCloudSecretProvider(
  id: string
): CloudSecretProviderSettings | undefined {
  return CLOUD_SECRET_PROVIDERS[id as CloudSecretProviderId];
}

export function isCloudSecretProviderId(id: string): id is CloudSecretProviderId {
  return id in CLOUD_SECRET_PROVIDERS;
}
