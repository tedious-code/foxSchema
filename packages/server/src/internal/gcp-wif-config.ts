/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a pasted Workload Identity Federation config may make this server do.
 *
 * An `external_account` config is instructions, and google-auth-library
 * follows them: it reads `credential_source.file`, or fetches
 * `credential_source.url`, and POSTs what it got to `token_url`. The library
 * checks none of it. A config that comes from a user is therefore a way to
 * send any file this process can read — the encryption key in its
 * environment, the metadata database — to any host, or to make the server
 * call an internal address. Google's guidance is to validate such configs
 * before use; this is that validation.
 *
 * Two rules. Every endpoint must be Google's own. And the subject token may
 * come only from a file or URL the person running this install has listed:
 * the token is the host's identity, so who may use it is the host's decision,
 * not a workspace member's.
 */
import { resolve as resolvePath, isAbsolute } from 'node:path';

/** Comma-separated absolute paths a pasted config may read its subject token from. */
export const GCP_WIF_TOKEN_FILES_ENV = 'FOX_GCP_WIF_TOKEN_FILES';
/** Comma-separated URLs a pasted config may fetch its subject token from (exact match). */
export const GCP_WIF_TOKEN_URLS_ENV = 'FOX_GCP_WIF_TOKEN_URLS';

const WIF = 'Workload Identity Federation config';
const HOST_INSTEAD =
  'Set GOOGLE_APPLICATION_CREDENTIALS on the Fox server for that instead of pasting the config here.';

function listFrom(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function text(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** `sts.googleapis.com`, its mTLS twin, or a regional `sts.<location>.rep.googleapis.com`. */
function isGoogleServiceHost(host: string, service: string): boolean {
  if (host === `${service}.googleapis.com` || host === `${service}.mtls.googleapis.com`) return true;
  const prefix = `${service}.`;
  const suffix = '.rep.googleapis.com';
  if (!host.startsWith(prefix) || !host.endsWith(suffix)) return false;
  return /^[a-z0-9-]+$/.test(host.slice(prefix.length, host.length - suffix.length));
}

/** An https URL on a Google service host, default port, no credentials in it. */
function googleUrl(raw: string, field: string, service: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${WIF}: ${field} is not a URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !isGoogleServiceHost(url.hostname, service)
  ) {
    throw new Error(`${WIF}: ${field} must be https://${service}.googleapis.com/…`);
  }
  return url;
}

function assertEndpoints(config: Record<string, unknown>): void {
  const universe = text(config, 'universe_domain');
  if (universe && universe !== 'googleapis.com') {
    throw new Error(`${WIF}: universe_domain must be googleapis.com`);
  }

  const tokenUrl = googleUrl(text(config, 'token_url'), 'token_url', 'sts');
  if (tokenUrl.pathname !== '/v1/token' || tokenUrl.search || tokenUrl.hash) {
    throw new Error(`${WIF}: token_url must be https://sts.googleapis.com/v1/token`);
  }

  const tokenInfo = text(config, 'token_info_url');
  if (tokenInfo) googleUrl(tokenInfo, 'token_info_url', 'sts');

  const impersonation = text(config, 'service_account_impersonation_url');
  if (impersonation) {
    const url = googleUrl(impersonation, 'service_account_impersonation_url', 'iamcredentials');
    const head = '/v1/projects/-/serviceAccounts/';
    const tail = ':generateAccessToken';
    const account = url.pathname.startsWith(head) && url.pathname.endsWith(tail)
      ? url.pathname.slice(head.length, url.pathname.length - tail.length)
      : '';
    if (!account || account.includes('/') || url.search || url.hash) {
      throw new Error(
        `${WIF}: service_account_impersonation_url must be https://iamcredentials.googleapis.com${head}<email>${tail}`
      );
    }
  }
}

function assertSubjectTokenSource(source: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  // Each of these makes the server act with something of its own: run a
  // program, sign with its AWS role, present its client certificate.
  if ('executable' in source) {
    throw new Error(`${WIF}: an executable credential source would run a program on the Fox server. ${HOST_INSTEAD}`);
  }
  if ('environment_id' in source || 'regional_cred_verification_url' in source) {
    throw new Error(`${WIF}: an AWS credential source would use the Fox server's own AWS identity. ${HOST_INSTEAD}`);
  }
  if ('certificate' in source) {
    throw new Error(`${WIF}: a certificate credential source would use the Fox server's own certificate. ${HOST_INSTEAD}`);
  }

  const file = text(source, 'file');
  const url = text(source, 'url');
  if (file && url) throw new Error(`${WIF}: credential_source needs a file or a url, not both`);

  if (file) {
    const allowed = listFrom(env, GCP_WIF_TOKEN_FILES_ENV).filter(isAbsolute).map((p) => resolvePath(p));
    if (!isAbsolute(file) || !allowed.includes(resolvePath(file))) {
      throw new Error(
        `${WIF}: this install does not allow reading a subject token from "${file}". ` +
          `Whoever runs the Fox server lists the allowed files in ${GCP_WIF_TOKEN_FILES_ENV}.`
      );
    }
    return;
  }

  if (url) {
    let wanted: string;
    try {
      wanted = new URL(url).href;
    } catch {
      throw new Error(`${WIF}: credential_source.url is not a URL`);
    }
    const allowed = listFrom(env, GCP_WIF_TOKEN_URLS_ENV).flatMap((item) => {
      try {
        return [new URL(item).href];
      } catch {
        return [];
      }
    });
    if (!allowed.includes(wanted)) {
      throw new Error(
        `${WIF}: this install does not allow fetching a subject token from "${url}". ` +
          `Whoever runs the Fox server lists the allowed URLs in ${GCP_WIF_TOKEN_URLS_ENV}.`
      );
    }
    return;
  }

  throw new Error(`${WIF}: credential_source needs a file or a url`);
}

/**
 * Throws unless `config` only reaches Google's endpoints and takes its subject
 * token from a source this install allows. Called when a config is saved and
 * again before every use, so a stored config stops working the moment its
 * source leaves the allow-list.
 */
export function assertSafeGcpWifConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): void {
  assertEndpoints(config);
  const source = config.credential_source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${WIF} needs credential_source`);
  }
  assertSubjectTokenSource(source as Record<string, unknown>, env);
}
