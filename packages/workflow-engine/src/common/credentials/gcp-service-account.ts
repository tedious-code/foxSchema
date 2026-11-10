/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mint a GCP access token from an IAM service-account JSON key (JWT bearer).
 * The workflow engine has no @google-cloud SDK; this is the same grant the
 * Secret Manager REST API expects.
 */
import { createSign } from 'node:crypto';

export type GcpServiceAccountKey = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

const GCP_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCP_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GCP_SECRET_ID_HINT =
  'GCP secret id must be the secret name, or projects/<project>/secrets/<name>';

function jsonString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

export function parseGcpServiceAccountJson(raw: string): GcpServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('GCP service account JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GCP service account JSON must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  const type = jsonString(obj, 'type').trim();
  if (type && type !== 'service_account') {
    throw new Error(
      'GCP JSON must be a service_account key (IAM → Service accounts → Keys)',
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
  version?: string,
): string {
  const id = secretId.trim().replace(/\/+$/g, '');
  if (!id) throw new Error('GCP secret id is required');

  if (id.startsWith('projects/')) {
    const parsed = parseGcpResourcePath(id);
    return `projects/${parsed.project}/secrets/${parsed.name}/versions/${version?.trim() || parsed.pathVersion || 'latest'}`;
  }
  if (id.includes('/')) {
    throw new Error(GCP_SECRET_ID_HINT);
  }
  const project = projectId?.trim();
  if (!project) {
    throw new Error(
      'GCP secret fetch needs a project id — set it on the credential or paste projects/<project>/secrets/<name>',
    );
  }
  return `projects/${project}/secrets/${id}/versions/${version?.trim() || 'latest'}`;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Exchange a service-account key for a short-lived access token. */
export async function mintGcpAccessToken(
  key: GcpServiceAccountKey,
  fetchImpl: typeof fetch,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      sub: key.client_email,
      aud: GCP_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
      scope: GCP_CLOUD_SCOPE,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  sign.end();
  let signature: string;
  try {
    signature = base64url(sign.sign(key.private_key));
  } catch {
    throw new Error('GCP service account private_key could not sign a JWT');
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`,
  });
  const response = await fetchImpl(GCP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `GCP service-account token ${response.status}: ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('GCP service-account token response had no access_token');
  }
  return json.access_token;
}
