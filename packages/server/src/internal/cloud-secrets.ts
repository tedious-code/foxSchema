/**
 * Resolve secrets from AWS Secrets Manager / GCP Secret Manager / Azure Key Vault.
 * Prefer stored per-user provider credentials. Host default chains are only
 * allowed in single-user mode (or when ALLOW_HOST_CLOUD_CREDENTIALS=true).
 */
import { assertSafeGcpWifConfig } from './gcp-wif-config';

export type CloudSecretSource = 'aws' | 'gcp' | 'azure';

/** Ordered registry of cloud secret backends — extend when adding a provider. */
export const CLOUD_SECRET_SOURCES: readonly CloudSecretSource[] = [
  'aws',
  'gcp',
  'azure',
] as const;

export function isCloudSecretSource(value: string): value is CloudSecretSource {
  return (CLOUD_SECRET_SOURCES as readonly string[]).includes(value);
}

export type CloudSecretRef = {
  secretId: string;
  /** Named cloud credential id from Credentials → Cloud providers. */
  credentialId?: string;
  region?: string;
  vaultUrl?: string;
  version?: string;
};

/** Stored AWS access keys (optional session token + default region). */
export type AwsProviderCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
};

/** Parsed Google Cloud service-account key (IAM → Keys JSON). Legacy resolve only. */
export type GcpServiceAccountKey = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

export const GCP_AVOID_SA_KEYS =
  'Service account keys could pose a security risk if compromised. Use Connect Google Cloud, or a Workload Identity Federation client config (JSON with type "external_account"). Do not download a service account key.';

export type GcpCredentialJson =
  | { kind: 'wif'; config: Record<string, unknown> }
  | { kind: 'service_account'; key: GcpServiceAccountKey };

/**
 * GCP credentials: user OAuth (refresh token), Workload Identity Federation
 * client config, or a short-lived access token. Host ADC (including WIF via
 * GOOGLE_APPLICATION_CREDENTIALS) is used only when none of these are set.
 */
export type GcpProviderCredentials = {
  /** Present when connected via “Connect Google Cloud” (refresh token stored). */
  auth?: 'oauth' | 'wif';
  refreshToken?: string;
  /** Google account email from the OAuth userinfo call (display only). */
  email?: string;
  /** WIF `external_account` client config, or a legacy service-account key. */
  serviceAccountJson?: string;
  accessToken?: string;
  /** Used to expand a short Secret Manager name into projects/…/secrets/…. */
  projectId?: string;
};

const GCP_SECRET_ID_HINT =
  'GCP secret id must be the secret name, or projects/<project>/secrets/<name>';

function jsonString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function parseGcpJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('GCP credential JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GCP credential JSON must be an object');
  }
  return parsed as Record<string, unknown>;
}

export function parseGcpServiceAccountJson(raw: string): GcpServiceAccountKey {
  const obj = parseGcpJsonObject(raw);
  const type = jsonString(obj, 'type').trim();
  if (type && type !== 'service_account') {
    throw new Error(
      'GCP JSON must be a service_account key (IAM → Service accounts → Keys)'
    );
  }
  const client_email = jsonString(obj, 'client_email').trim();
  const private_key = jsonString(obj, 'private_key');
  if (!client_email || !private_key.trim()) {
    throw new Error('GCP service account JSON needs client_email and private_key');
  }
  const project_id = jsonString(obj, 'project_id').trim() || undefined;
  return { project_id, client_email, private_key };
}

/** Classify pasted GCP JSON: WIF client config vs a downloaded service-account key. */
export function classifyGcpCredentialJson(raw: string): GcpCredentialJson {
  const obj = parseGcpJsonObject(raw);
  const type = jsonString(obj, 'type').trim();
  if (type === 'external_account') {
    if (!jsonString(obj, 'audience').trim() || !jsonString(obj, 'token_url').trim()) {
      throw new Error('Workload Identity Federation config needs audience and token_url');
    }
    // A pasted config tells the server which file to read and where to send
    // it: only Google's endpoints, and only a token source this install lists.
    assertSafeGcpWifConfig(obj);
    return { kind: 'wif', config: obj };
  }
  if (type === 'service_account' || (jsonString(obj, 'client_email') && jsonString(obj, 'private_key'))) {
    return { kind: 'service_account', key: parseGcpServiceAccountJson(raw) };
  }
  throw new Error(GCP_AVOID_SA_KEYS);
}

/** New credentials must be OAuth or WIF — never a downloaded JSON key. */
export function assertGcpJsonAllowedForStore(raw: string): { kind: 'wif' } {
  const classified = classifyGcpCredentialJson(raw);
  if (classified.kind !== 'wif') {
    throw new Error(GCP_AVOID_SA_KEYS);
  }
  return { kind: 'wif' };
}

function parseGcpResourcePath(id: string): {
  project: string;
  name: string;
  pathVersion?: string;
} {
  const parts = id.split('/');
  if (parts[0] !== 'projects' || parts[2] !== 'secrets' || !parts[1] || !parts[3]) {
    throw new Error(GCP_SECRET_ID_HINT);
  }
  if (parts.length === 4) {
    return { project: parts[1], name: parts[3] };
  }
  if (parts[4] === 'versions' && parts.length >= 6) {
    return {
      project: parts[1],
      name: parts[3],
      pathVersion: parts.slice(5).join('/'),
    };
  }
  throw new Error(GCP_SECRET_ID_HINT);
}

export function normalizeGcpSecretResource(
  secretId: string,
  projectId?: string,
  version?: string
): string {
  const id = secretId.trim().replace(/\/+$/g, '');
  if (!id) throw new Error('GCP secret id is required');

  if (id.startsWith('projects/')) {
    const parsed = parseGcpResourcePath(id);
    return `projects/${parsed.project}/secrets/${parsed.name}/versions/${
      version?.trim() || parsed.pathVersion || 'latest'
    }`;
  }
  if (id.includes('/')) {
    throw new Error(GCP_SECRET_ID_HINT);
  }
  const project = projectId?.trim();
  if (!project) {
    throw new Error(
      'GCP secret fetch needs a project id — set it on the credential or paste projects/<project>/secrets/<name>'
    );
  }
  return `projects/${project}/secrets/${id}/versions/${version?.trim() || 'latest'}`;
}

/** Azure service principal (client credentials). */
export type AzureProviderCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export type CloudProviderCredentials =
  | AwsProviderCredentials
  | GcpProviderCredentials
  | AzureProviderCredentials;

/** True when host IAM / ADC / DefaultAzureCredential may be used without user keys. */
export function allowHostCloudCredentials(): boolean {
  if (process.env.ALLOW_HOST_CLOUD_CREDENTIALS === 'true') return true;
  // LOCAL_SINGLE_USER defaults to true (desktop / personal CLI).
  return process.env.LOCAL_SINGLE_USER !== 'false';
}

/**
 * Azure Key Vault URLs only — HTTPS + known vault hostnames (blocks SSRF /
 * token exfiltration via attacker-controlled vaultUrl).
 */
export function assertAzureVaultUrl(vaultUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(vaultUrl);
  } catch {
    throw new Error('Invalid Azure Key Vault URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Azure Key Vault URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Azure Key Vault URL must not include credentials');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Azure Key Vault URL must use the default HTTPS port');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1'
  ) {
    throw new Error('Azure Key Vault URL hostname is not allowed');
  }
  // Reject raw IPv4 / IPv6. Split rather than match `^\d{1,3}(\.\d{1,3}){3}$`:
  // that pattern is linear in practice (every quantifier is bounded and both
  // ends anchored), but security/detect-unsafe-regex flags the repeated group
  // and failed CI on every PR. Splitting states the same rule with no regex
  // ambiguity to argue about.
  const octets = host.split('.');
  const isRawIpv4 = octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o));
  if (isRawIpv4 || host.includes(':')) {
    throw new Error('Azure Key Vault URL must use a vault hostname, not an IP');
  }
  const allowedSuffixes = [
    '.vault.azure.net',
    '.vault.azure.cn',
    '.vault.usgovcloudapi.net',
    '.vault.microsoftazure.de',
  ];
  if (!allowedSuffixes.some((sfx) => host.endsWith(sfx) && host.length > sfx.length)) {
    throw new Error(
      'Azure Key Vault URL hostname must be *.vault.azure.net (or a known sovereign-cloud vault endpoint)'
    );
  }
}

export function parseCloudRef(raw: string | null | undefined): CloudSecretRef | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CloudSecretRef>;
    if (typeof parsed.secretId !== 'string' || !parsed.secretId.trim()) return null;
    return {
      secretId: parsed.secretId.trim(),
      credentialId:
        typeof parsed.credentialId === 'string' ? parsed.credentialId.trim() || undefined : undefined,
      region: typeof parsed.region === 'string' ? parsed.region.trim() || undefined : undefined,
      vaultUrl: typeof parsed.vaultUrl === 'string' ? parsed.vaultUrl.trim() || undefined : undefined,
      version: typeof parsed.version === 'string' ? parsed.version.trim() || undefined : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeCloudRef(ref: CloudSecretRef): string {
  return JSON.stringify({
    secretId: ref.secretId,
    ...(ref.credentialId ? { credentialId: ref.credentialId } : {}),
    ...(ref.region ? { region: ref.region } : {}),
    ...(ref.vaultUrl ? { vaultUrl: ref.vaultUrl } : {}),
    ...(ref.version ? { version: ref.version } : {}),
  });
}

function requireProviderCreds(
  providerCreds: CloudProviderCredentials | undefined,
  source: CloudSecretSource
): void {
  if (providerCreds) return;
  if (allowHostCloudCredentials()) return;
  throw new Error(
    `Cloud secret resolve for ${source} requires saved Credentials → Cloud providers credentials ` +
      `(host IAM is disabled on multi-user hosts; set ALLOW_HOST_CLOUD_CREDENTIALS=true only if intentional)`
  );
}

async function resolveAws(
  ref: CloudSecretRef,
  providerCreds?: CloudProviderCredentials
): Promise<string> {
  requireProviderCreds(providerCreds, 'aws');
  let SecretsManagerClient: typeof import('@aws-sdk/client-secrets-manager').SecretsManagerClient;
  let GetSecretValueCommand: typeof import('@aws-sdk/client-secrets-manager').GetSecretValueCommand;
  try {
    const mod = await import('@aws-sdk/client-secrets-manager');
    SecretsManagerClient = mod.SecretsManagerClient;
    GetSecretValueCommand = mod.GetSecretValueCommand;
  } catch {
    throw new Error(
      'AWS Secrets Manager SDK not installed — add @aws-sdk/client-secrets-manager to the FoxSchema host'
    );
  }
  const aws = providerCreds as AwsProviderCredentials | undefined;
  const region = ref.region || aws?.region;
  const client = new SecretsManagerClient({
    ...(region ? { region } : {}),
    ...(aws?.accessKeyId && aws?.secretAccessKey
      ? {
          credentials: {
            accessKeyId: aws.accessKeyId,
            secretAccessKey: aws.secretAccessKey,
            ...(aws.sessionToken ? { sessionToken: aws.sessionToken } : {}),
          },
        }
      : {}),
  });
  const out = await client.send(
    new GetSecretValueCommand({
      SecretId: ref.secretId,
      ...(ref.version ? { VersionId: ref.version } : {}),
    })
  );
  if (typeof out.SecretString === 'string') return out.SecretString;
  if (out.SecretBinary) {
    const buf = Buffer.from(out.SecretBinary as Uint8Array);
    return buf.toString('utf8');
  }
  throw new Error(`AWS secret "${ref.secretId}" has no string/binary payload`);
}

function googleOAuthClientFromEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.SSO_GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.SSO_GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGcpOAuthCredentials(creds: GcpProviderCredentials | undefined): boolean {
  return !!creds && (creds.auth === 'oauth' || !!creds.refreshToken?.trim());
}

type GcpAccessTokenClient = {
  getAccessToken: () => Promise<string | { token?: string | null } | null | undefined>;
};

async function readGcpAccessToken(client: GcpAccessTokenClient): Promise<string | undefined> {
  const got = await client.getAccessToken();
  if (typeof got === 'string' && got.trim()) return got;
  if (got && typeof got === 'object' && typeof got.token === 'string' && got.token.trim()) {
    return got.token;
  }
  return undefined;
}

/** Mint a short-lived token from a WIF `external_account` client config. */
export async function mintGcpWifAccessToken(config: Record<string, unknown>): Promise<string> {
  // Checked here as well as on save: this is where the library acts on the
  // config, and a row saved before the allow-list changed must not slip by.
  assertSafeGcpWifConfig(config);
  try {
    const { IdentityPoolClient, GoogleAuth } = await import('google-auth-library');
    const token =
      (await readGcpAccessToken(
        await new GoogleAuth({
          credentials: config,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        }).getClient()
      )) ??
      // The shape was checked by assertSafeGcpWifConfig above; the library's
      // options type cannot be named from a plain record without this cast.
      (await readGcpAccessToken(
        new IdentityPoolClient(config as unknown as ConstructorParameters<typeof IdentityPoolClient>[0])
      ));
    if (token) return token;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot find module|MODULE_NOT_FOUND/i.test(msg)) {
      throw new Error(
        'Workload Identity Federation needs @google-cloud/secret-manager on the FoxSchema host'
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  throw new Error('Workload Identity Federation did not return an access token');
}

async function resolveGcp(
  ref: CloudSecretRef,
  providerCreds?: CloudProviderCredentials
): Promise<string> {
  requireProviderCreds(providerCreds, 'gcp');
  const gcp = (providerCreds ?? {}) as GcpProviderCredentials;
  const json = gcp.serviceAccountJson?.trim();
  const classified = json ? classifyGcpCredentialJson(json) : undefined;
  const projectId =
    gcp.projectId?.trim() ||
    (classified?.kind === 'service_account' ? classified.key.project_id : undefined);
  const name = normalizeGcpSecretResource(ref.secretId, projectId, ref.version);

  if (isGcpOAuthCredentials(gcp) || classified?.kind === 'wif') {
    const { accessGcpSecretVersionRest, refreshGcpAccessToken } = await import('./gcp-oauth');
    let accessToken = gcp.accessToken?.trim() ?? '';
    if (!accessToken && classified?.kind === 'wif') {
      accessToken = await mintGcpWifAccessToken(classified.config);
    }
    const refreshToken = gcp.refreshToken?.trim() ?? '';
    if (!accessToken && refreshToken) {
      const client = googleOAuthClientFromEnv();
      if (!client) {
        throw new Error(
          'Google Cloud OAuth credential needs a refreshed access token (configure this install’s Google OAuth client)'
        );
      }
      accessToken = await refreshGcpAccessToken(refreshToken, client);
    }
    if (!accessToken) {
      throw new Error(
        classified?.kind === 'wif'
          ? 'Workload Identity Federation did not return an access token'
          : 'Google Cloud OAuth credential needs a refreshed access token'
      );
    }
    return accessGcpSecretVersionRest(accessToken, name);
  }

  let SecretManagerServiceClient: typeof import('@google-cloud/secret-manager').SecretManagerServiceClient;
  try {
    const mod = await import('@google-cloud/secret-manager');
    SecretManagerServiceClient = mod.SecretManagerServiceClient;
  } catch {
    throw new Error(
      'GCP Secret Manager SDK not installed — add @google-cloud/secret-manager to the FoxSchema host'
    );
  }
  const client =
    gcp.accessToken && !json
      ? new SecretManagerServiceClient({
          authClient: {
            getAccessToken: async () => ({ token: gcp.accessToken }),
            getRequestHeaders: async () => ({ Authorization: `Bearer ${gcp.accessToken}` }),
          } as never,
        })
      : new SecretManagerServiceClient(
          json ? { credentials: JSON.parse(json) as object } : undefined
        );

  const [version] = await client.accessSecretVersion({ name });
  const data = version.payload?.data;
  if (!data) throw new Error(`GCP secret "${ref.secretId}" has empty payload`);
  if (typeof data === 'string') return data;
  return Buffer.from(data as Uint8Array).toString('utf8');
}

async function resolveAzure(
  ref: CloudSecretRef,
  providerCreds?: CloudProviderCredentials
): Promise<string> {
  if (!ref.vaultUrl) {
    throw new Error('Azure Key Vault secrets require cloud_ref.vaultUrl');
  }
  assertAzureVaultUrl(ref.vaultUrl);
  requireProviderCreds(providerCreds, 'azure');
  let SecretClient: typeof import('@azure/keyvault-secrets').SecretClient;
  let DefaultAzureCredential: typeof import('@azure/identity').DefaultAzureCredential;
  let ClientSecretCredential: typeof import('@azure/identity').ClientSecretCredential;
  try {
    const secretsMod = await import('@azure/keyvault-secrets');
    const identityMod = await import('@azure/identity');
    SecretClient = secretsMod.SecretClient;
    DefaultAzureCredential = identityMod.DefaultAzureCredential;
    ClientSecretCredential = identityMod.ClientSecretCredential;
  } catch {
    throw new Error(
      'Azure Key Vault SDKs not installed — add @azure/keyvault-secrets and @azure/identity to the FoxSchema host'
    );
  }
  const azure = providerCreds as AzureProviderCredentials | undefined;
  const credential =
    azure?.tenantId && azure?.clientId && azure?.clientSecret
      ? new ClientSecretCredential(azure.tenantId, azure.clientId, azure.clientSecret)
      : new DefaultAzureCredential();
  const client = new SecretClient(ref.vaultUrl, credential);
  const secret = await client.getSecret(ref.secretId, ref.version ? { version: ref.version } : undefined);
  if (secret.value === undefined) {
    throw new Error(`Azure secret "${ref.secretId}" has no value`);
  }
  return secret.value;
}

/** Fetch a cloud secret; callers should catch and surface the message. */
export async function resolveCloudSecret(
  source: CloudSecretSource,
  ref: CloudSecretRef,
  providerCreds?: CloudProviderCredentials
): Promise<string> {
  if (source === 'aws') return resolveAws(ref, providerCreds);
  if (source === 'gcp') return resolveGcp(ref, providerCreds);
  if (source === 'azure') return resolveAzure(ref, providerCreds);
  throw new Error(`Unknown cloud secret source: ${source}`);
}
