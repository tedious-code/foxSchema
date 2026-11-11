/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  mintGcpAccessToken,
  normalizeGcpSecretResource,
  parseGcpServiceAccountJson,
} from './gcp-service-account.js';

describe('GCP service-account helper', () => {
  it('parses an IAM key and expands a short secret name', () => {
    const key = parseGcpServiceAccountJson(
      JSON.stringify({
        type: 'service_account',
        project_id: 'demo-proj',
        client_email: 'sa@demo-proj.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', // gitleaks:allow (fake key: the body is 'abc')
      }),
    );
    expect(key.project_id).toBe('demo-proj');
    expect(normalizeGcpSecretResource('api-token', key.project_id)).toBe(
      'projects/demo-proj/secrets/api-token/versions/latest',
    );
  });

  it('mints an access token via JWT bearer', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      const body = String(init?.body ?? '');
      expect(body).toContain('urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
      expect(body).toContain('assertion=');
      return Response.json({ access_token: 'minted-token' });
    }) as unknown as typeof fetch;

    const token = await mintGcpAccessToken(
      {
        client_email: 'sa@demo-proj.iam.gserviceaccount.com',
        private_key: pem,
      },
      fetchImpl,
      1_700_000_000,
    );
    expect(token).toBe('minted-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
