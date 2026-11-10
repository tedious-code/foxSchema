/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/common/src/credentials/providers.ts).
 */
import { z } from 'zod';
import {
  WORKFLOW_CONNECTION_RESOLVE_PATH,
  WORKFLOW_ENGINE_TOKEN_ENV,
  foxSchemaEndpoint,
  type ResolvedWorkflowConnection,
} from '@foxschema/workflow-contract';
import {
  mintGcpAccessToken,
  normalizeGcpSecretResource,
  parseGcpServiceAccountJson,
} from './gcp-service-account.js';

/** Where credential secret material is resolved from at run time. */
export const credentialSourceSchema = z.enum([
  'local',
  'env',
  'gcp',
  'aws',
  'azure',
  /** A saved FoxSchema connection its owner granted to workflows. */
  'foxschema',
]);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

/**
 * Encrypted-at-rest payload. `local` embeds values; other sources store a
 * reference and resolve via the matching secret service / process env.
 */
export type StoredSecretPayload = {
  source: CredentialSource;
  /** Local values, or a merge overlay after remote resolve (cookies, tokens). */
  values?: Record<string, unknown>;
  /** field → env var name (source=env). */
  mapping?: Record<string, string>;
  /** GCP Secret Manager */
  projectId?: string;
  secretId?: string;
  version?: string;
  /** Legacy IAM key JSON (encrypted). Prefer metadata identity / WIF on the host. */
  serviceAccountJson?: string;
  /** AWS Secrets Manager */
  region?: string;
  versionId?: string;
  /** Azure Key Vault */
  vaultUrl?: string;
  secretName?: string;
  /**
   * How to interpret the remote secret string.
   * `json` — parse object and merge keys; `text` — single field via valueKey.
   * Default: try JSON, else text.
   */
  format?: 'json' | 'text';
  /** Field name for text secrets (default `value`). */
  valueKey?: string;
  /** FoxSchema saved connection (source=foxschema). The secret never leaves FoxSchema at rest. */
  connectionId?: string;
};

export function isStoredSecretPayload(
  value: unknown,
): value is StoredSecretPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'source' in value &&
    credentialSourceSchema.safeParse(
      (value as StoredSecretPayload).source,
    ).success
  );
}

/**
 * Normalize create-API `data` into a stored payload for the given source.
 * Local: `data` is the secret bag. Env: `data` maps field → env var name.
 * Cloud: `data` is the reference config (ids, region, vault URL, …).
 */
export function buildStoredSecret(
  source: CredentialSource,
  data: Record<string, unknown>,
): StoredSecretPayload {
  if (source === 'local') {
    return { source: 'local', values: { ...data } };
  }
  if (source === 'env') {
    const mapping: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.trim()) {
        mapping[key] = value.trim();
      }
    }
    if (Object.keys(mapping).length === 0) {
      throw new Error(
        'Env credentials need at least one field mapped to an environment variable name',
      );
    }
    return { source: 'env', mapping };
  }

  const str = (key: string): string | undefined => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const format =
    data.format === 'json' || data.format === 'text' ? data.format : undefined;

  if (source === 'foxschema') {
    const connectionId = str('connectionId');
    if (!connectionId) {
      throw new Error('FoxSchema credentials require connectionId');
    }
    // Only the reference is stored: FoxSchema keeps the password, encrypted,
    // and hands it over per run while the grant stands.
    return { source: 'foxschema', connectionId };
  }

  if (source === 'gcp') {
    const secretId = str('secretId');
    if (!secretId) {
      throw new Error('GCP credentials require secretId');
    }
    const serviceAccountJson = str('serviceAccountJson');
    const projectId =
      str('projectId') ||
      (serviceAccountJson && !gcpJsonIsExternalAccount(serviceAccountJson)
        ? parseGcpServiceAccountJson(serviceAccountJson).project_id
        : undefined);
    if (!projectId && !secretId.startsWith('projects/')) {
      throw new Error(
        'GCP credentials require projectId and secretId (set projectId when using Workload Identity Federation)',
      );
    }
    return {
      source: 'gcp',
      ...(projectId ? { projectId } : {}),
      secretId,
      version: str('version') ?? 'latest',
      ...(serviceAccountJson ? { serviceAccountJson } : {}),
      format,
      valueKey: str('valueKey'),
    };
  }

  if (source === 'aws') {
    const secretId = str('secretId');
    if (!secretId) {
      throw new Error('AWS credentials require secretId');
    }
    return {
      source: 'aws',
      secretId,
      region: str('region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
      versionId: str('versionId'),
      format,
      valueKey: str('valueKey'),
    };
  }

  // azure
  const vaultUrl = str('vaultUrl')?.replace(/\/$/, '');
  const secretName = str('secretName');
  if (!vaultUrl || !secretName) {
    throw new Error('Azure credentials require vaultUrl and secretName');
  }
  return {
    source: 'azure',
    vaultUrl,
    secretName,
    version: str('version'),
    format,
    valueKey: str('valueKey'),
  };
}

/**
 * Decode a decrypted JSON blob into a stored payload.
 * Legacy credentials (no `source`) are treated as local values.
 */
export function parseStoredSecret(raw: Record<string, unknown>): StoredSecretPayload {
  if (isStoredSecretPayload(raw)) {
    return raw;
  }
  return { source: 'local', values: raw };
}

/** Expand a remote secret string into a field bag. */
export function expandSecretString(
  text: string,
  options: {
    format?: 'json' | 'text';
    valueKey?: string;
    mapping?: Record<string, string>;
  },
): Record<string, unknown> {
  const trimmed = text.trim();
  const preferJson = options.format !== 'text';
  if (preferJson) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const bag = { ...(parsed as Record<string, unknown>) };
        if (options.mapping) {
          const remapped: Record<string, unknown> = {};
          for (const [field, remoteKey] of Object.entries(options.mapping)) {
            if (remoteKey in bag) remapped[field] = bag[remoteKey];
          }
          return Object.keys(remapped).length > 0 ? remapped : bag;
        }
        return bag;
      }
    } catch {
      if (options.format === 'json') {
        throw new Error('Remote secret is not valid JSON');
      }
    }
  }
  const key = options.valueKey?.trim() || 'value';
  return { [key]: trimmed };
}

export async function resolveStoredSecret(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let resolved: Record<string, unknown>;

  switch (payload.source) {
    case 'local':
      resolved = { ...(payload.values ?? {}) };
      break;
    case 'env':
      resolved = resolveEnvSecret(payload, env);
      break;
    case 'gcp':
      resolved = await resolveGcpSecret(payload, env, fetchImpl);
      break;
    case 'aws':
      resolved = await resolveAwsSecret(payload, env, fetchImpl);
      break;
    case 'azure':
      resolved = await resolveAzureSecret(payload, env, fetchImpl);
      break;
    case 'foxschema':
      resolved = await resolveFoxSchemaConnection(payload, env, fetchImpl);
      break;
    default: {
      const _exhaustive: never = payload.source;
      throw new Error(`Unknown credential source: ${String(_exhaustive)}`);
    }
  }

  // Local overlay (cookie sessions / token refresh) wins over remote values.
  if (payload.values && payload.source !== 'local') {
    return { ...resolved, ...payload.values };
  }
  return resolved;
}

function resolveEnvSecret(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const mapping = payload.mapping ?? {};
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [field, envName] of Object.entries(mapping)) {
    const value = env[envName];
    if (value === undefined || value === '') {
      missing.push(envName);
      continue;
    }
    out[field] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `Environment secret missing: ${missing.map((name) => `$${name}`).join(', ')}`,
    );
  }
  return out;
}

function gcpJsonIsExternalAccount(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { type?: string }).type === 'external_account'
    );
  } catch {
    return false;
  }
}

function gcpServiceAccountJson(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    payload.serviceAccountJson?.trim() ||
    env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    env.GCP_SERVICE_ACCOUNT_JSON ||
    undefined
  );
}

async function resolveGcpSecret(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const secretId = payload.secretId;
  if (!secretId) {
    throw new Error('GCP secret reference is incomplete (secretId)');
  }
  const json = gcpServiceAccountJson(payload, env);
  const projectId =
    payload.projectId ||
    (json && !gcpJsonIsExternalAccount(json)
      ? parseGcpServiceAccountJson(json).project_id
      : undefined);
  const resource = normalizeGcpSecretResource(secretId, projectId, payload.version);
  const token = await getGcpAccessToken(json, env, fetchImpl);
  const response = await fetchImpl(
    `https://secretmanager.googleapis.com/v1/${resource}:access`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(
      `GCP Secret Manager ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    payload?: { data?: string };
  };
  const encoded = body.payload?.data;
  if (!encoded) {
    throw new Error('GCP Secret Manager returned an empty payload');
  }
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  return expandSecretString(text, payload);
}

async function getGcpAccessToken(
  json: string | undefined,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  const fromEnv = env.GOOGLE_ACCESS_TOKEN || env.GCP_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  if (json && !gcpJsonIsExternalAccount(json)) {
    return mintGcpAccessToken(parseGcpServiceAccountJson(json), fetchImpl);
  }

  // GCE / Cloud Run / GKE metadata server (attached identity — no downloaded key).
  try {
    const response = await fetchImpl(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (response.ok) {
      const body = (await response.json()) as { access_token?: string };
      if (body.access_token) return body.access_token;
    }
  } catch {
    // Not on GCP — fall through.
  }

  throw new Error(
    'GCP credentials need Workload Identity Federation (GOOGLE_APPLICATION_CREDENTIALS), GOOGLE_ACCESS_TOKEN, or a GCP metadata identity. Do not download a service account key.',
  );
}

async function resolveAwsSecret(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const secretId = payload.secretId;
  if (!secretId) {
    throw new Error('AWS secret reference is incomplete (secretId)');
  }
  const region =
    payload.region ||
    env.AWS_REGION ||
    env.AWS_DEFAULT_REGION ||
    'us-east-1';
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials need AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    );
  }

  const body: Record<string, string> = { SecretId: secretId };
  if (payload.versionId) body.VersionId = payload.versionId;

  const host = `secretsmanager.${region}.amazonaws.com`;
  const amzTarget = 'secretsmanager.GetSecretValue';
  const payloadJson = JSON.stringify(body);
  const headers = await signAwsHeaders({
    method: 'POST',
    host,
    region,
    service: 'secretsmanager',
    amzTarget,
    body: payloadJson,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN,
  });

  const response = await fetchImpl(`https://${host}/`, {
    method: 'POST',
    headers,
    body: payloadJson,
  });
  if (!response.ok) {
    throw new Error(
      `AWS Secrets Manager ${response.status}: ${await response.text()}`,
    );
  }
  const result = (await response.json()) as {
    SecretString?: string;
    SecretBinary?: string;
  };
  const text =
    result.SecretString ??
    (result.SecretBinary
      ? Buffer.from(result.SecretBinary, 'base64').toString('utf8')
      : undefined);
  if (text === undefined) {
    throw new Error('AWS Secrets Manager returned an empty secret');
  }
  return expandSecretString(text, payload);
}

async function resolveAzureSecret(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const vaultUrl = payload.vaultUrl?.replace(/\/$/, '');
  const secretName = payload.secretName;
  if (!vaultUrl || !secretName) {
    throw new Error(
      'Azure secret reference is incomplete (vaultUrl, secretName)',
    );
  }
  const token = await getAzureAccessToken(env, fetchImpl);
  const version = payload.version ? `/${payload.version}` : '';
  const url = `${vaultUrl}/secrets/${encodeURIComponent(secretName)}${version}?api-version=7.4`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Azure Key Vault ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { value?: string };
  if (typeof body.value !== 'string') {
    throw new Error('Azure Key Vault returned an empty secret');
  }
  return expandSecretString(body.value, payload);
}

async function getAzureAccessToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (env.AZURE_ACCESS_TOKEN) return env.AZURE_ACCESS_TOKEN;

  const tenantId = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Azure credentials need AZURE_ACCESS_TOKEN or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://vault.azure.net/.default',
  });
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Azure AD token ${response.status}: ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Azure AD did not return an access_token');
  }
  return json.access_token;
}

/** Minimal SigV4 for Secrets Manager GetSecretValue (no AWS SDK). */
async function signAwsHeaders(input: {
  method: string;
  host: string;
  region: string;
  service: string;
  amzTarget: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): Promise<Record<string, string>> {
  const { createHash, createHmac } = await import('node:crypto');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(input.body, 'utf8').digest('hex');

  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: input.host,
    'x-amz-date': amzDate,
    'x-amz-target': input.amzTarget,
  };
  if (input.sessionToken) {
    headers['x-amz-security-token'] = input.sessionToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderKeys
    .map((key) => `${key}:${headers[key]!.trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalRequest = [
    input.method,
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data, 'utf8').digest();
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return headers;
}

/**
 * Ask FoxSchema for a saved connection its owner granted to workflows.
 *
 * Resolved per run rather than copied in: revoking the grant, or changing the
 * password in FoxSchema, takes effect on the next run with nothing to re-sync.
 */
async function resolveFoxSchemaConnection(
  payload: StoredSecretPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const connectionId = payload.connectionId;
  if (!connectionId) {
    throw new Error('FoxSchema connection reference is incomplete (connectionId)');
  }
  const { url, token } = foxSchemaEndpoint(WORKFLOW_CONNECTION_RESOLVE_PATH, env);
  if (!token) {
    throw new Error(
      `${WORKFLOW_ENGINE_TOKEN_ENV} is not set, so saved FoxSchema connections cannot be resolved`,
    );
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ connectionId }),
  });
  if (!response.ok) {
    const reason =
      response.status === 404
        ? 'it is not granted to workflows, or no longer exists'
        : `FoxSchema answered HTTP ${response.status}`;
    throw new Error(`Saved connection ${connectionId} could not be resolved: ${reason}`);
  }
  const body = (await response.json()) as ResolvedWorkflowConnection;
  return {
    dialect: body.dialect,
    ...(body.schema ? { schema: body.schema } : {}),
    option: body.option,
  };
}
