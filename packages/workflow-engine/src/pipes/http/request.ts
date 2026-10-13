/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/http/src/request.ts).
 */
import {
  HttpBodyValidationError,
  composeBodyFields,
  httpKvQueryKey,
  parseHttpRequest,
  validateAgainstSchema,
  type CredentialStore,
  type HttpKv,
  type HttpRequestDef,
  type HttpTokenRefresh,
  getPath,
} from '../../common/index.js';
import {
  collectSetCookies,
  cookieHeader,
  cookiesFromSecret,
  mergeCookies,
  type StoredCookie,
} from './cookies.js';
import { interpolate, interpolateDeep } from '../../sdk/index.js';

export interface HttpExecuteOptions {
  request: unknown;
  /** Revealed credential payload when auth.type === 'credential' or pipe credentialId. */
  secret?: Record<string, unknown>;
  /** Extra credential id applied when request.auth is none (pipe-level credentialId). */
  credentialSecret?: Record<string, unknown>;
  /** Credential id used to persist cookies / refreshed tokens. */
  credentialId?: string;
  credentials?: CredentialStore;
  /**
   * Runtime variables for `{{…}}` templates. Merged as:
   * `{ ...variables, vars: variables, secrets, trigger }`.
   */
  variables?: Record<string, unknown>;
  /** Trigger invocation payload exposed as `{{trigger.*}}`. */
  trigger?: Record<string, unknown>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface HttpExecuteResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when content-type is JSON; otherwise raw text. */
  body: unknown;
  /** The address requested, safe to report: a query-string API key is redacted. */
  url: string;
  /** Cookies after this response (including newly set). */
  cookies: StoredCookie[];
}

/** Longest excerpt of a failed response's body carried into an error. */
const FAILURE_BODY_CHARS = 200;

/**
 * `returned 400: idempotency key is required` rather than `returned 400`.
 *
 * The status alone rarely says what to fix; the server usually does, in the
 * body. JSON bodies contribute their `error`/`message` field when they have
 * one, anything else a single-line excerpt, capped so a returned HTML page
 * does not become the run's error message.
 */
export function describeHttpFailure(result: Pick<HttpExecuteResult, 'status' | 'body'>): string {
  const { body } = result;
  let detail = '';
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const named = record.error ?? record.message;
    detail = typeof named === 'string' ? named : JSON.stringify(body);
  } else if (typeof body === 'string') {
    detail = body;
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > FAILURE_BODY_CHARS) detail = `${detail.slice(0, FAILURE_BODY_CHARS)}…`;
  return detail ? `returned ${result.status}: ${detail}` : `returned ${result.status}`;
}

/** Build URL + init from a resolved (already-interpolated) request def. */
export function buildHttpRequest(
  request: HttpRequestDef,
  secret?: Record<string, unknown>,
  cookies: StoredCookie[] = [],
): { url: string; init: RequestInit } {
  // Query array is authoritative — drop any search already baked into the URL
  // (designer auto-maps Params ↔ URL, which would otherwise duplicate keys).
  const url = new URL(request.url);
  url.search = '';
  for (const param of resolveKv(request.query)) {
    // Condition operators use bracket style: `price[gte]=100`; eq stays plain.
    url.searchParams.append(httpKvQueryKey(param), param.value);
  }

  const headers = new Headers();
  for (const header of resolveKv(request.headers)) {
    headers.set(header.key, header.value);
  }

  const cookie = cookieHeader(cookies);
  if (cookie && !headers.has('cookie')) {
    headers.set('cookie', cookie);
  }

  applyAuth(url, headers, request.auth, secret);

  let body: string | undefined;
  // GET/HEAD send no body — skip composition AND schema validation, so a
  // stale body config left over from a POST can't fail a request that would
  // never carry it (and no body content-type header is set).
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { url: url.toString(), init: { method: request.method, headers } };
  }
  switch (request.body.mode) {
    case 'none':
      break;
    case 'json':
      assertBodySchema(request.body.schema, request.body.json ?? null);
      body = JSON.stringify(request.body.json ?? null);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      break;
    case 'raw':
      if (request.body.schema) {
        assertBodySchema(request.body.schema, parseRawForSchema(request.body.raw));
      }
      body = request.body.raw;
      if (!headers.has('content-type')) {
        headers.set('content-type', request.body.contentType);
      }
      break;
    case 'form': {
      const rows = resolveKv(request.body.form);
      if (request.body.schema) {
        assertBodySchema(
          request.body.schema,
          Object.fromEntries(rows.map((row) => [row.key, row.value])),
        );
      }
      const params = new URLSearchParams();
      for (const field of rows) {
        params.append(field.key, field.value);
      }
      body = params.toString();
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded');
      }
      break;
    }
    case 'fields': {
      // Compose typed rows, then enforce the schema — both fail app-side,
      // before any request leaves the process.
      const composed = composeBodyFields(request.body.fields);
      assertBodySchema(request.body.schema, composed);
      body = JSON.stringify(composed);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      break;
    }
  }

  return {
    url: url.toString(),
    init: {
      method: request.method,
      headers,
      body,
    },
  };
}

export async function executeHttpRequest(
  options: HttpExecuteOptions,
): Promise<HttpExecuteResult> {
  let secret = { ...(options.secret ?? options.credentialSecret ?? {}) };
  const request = parseHttpRequest(options.request);
  const credentialId =
    options.credentialId ??
    (request.auth.type === 'credential' ? request.auth.credentialId : undefined);

  let cookies = request.session.enabled ? cookiesFromSecret(secret) : [];
  const variables = buildVariables(request, secret, options);

  if (request.tokenRefresh?.enabled && credentialId) {
    secret = await maybeRefreshToken({
      refresh: request.tokenRefresh,
      secret,
      credentialId,
      credentials: options.credentials,
      variables,
      fetch: options.fetch,
      signal: options.signal,
      proactive: true,
    });
    cookies = request.session.enabled ? cookiesFromSecret(secret) : cookies;
  }

  const resolved = resolveRequest(request, {
    ...variables,
    secrets: flattenSecrets(secret),
  });

  let result = await dispatch(resolved, secret, cookies, options);
  cookies = request.session.enabled
    ? mergeCookies(cookies, result.setCookies)
    : cookies;

  if (
    request.tokenRefresh?.enabled &&
    credentialId &&
    request.tokenRefresh.onStatus.includes(result.status)
  ) {
    secret = await maybeRefreshToken({
      refresh: request.tokenRefresh,
      secret,
      credentialId,
      credentials: options.credentials,
      variables: buildVariables(request, secret, options),
      fetch: options.fetch,
      signal: options.signal,
      proactive: false,
    });
    cookies = request.session.enabled ? cookiesFromSecret(secret) : cookies;
    const retried = resolveRequest(request, {
      ...buildVariables(request, secret, options),
      secrets: flattenSecrets(secret),
    });
    result = await dispatch(retried, secret, cookies, options);
    cookies = request.session.enabled
      ? mergeCookies(cookies, result.setCookies)
      : cookies;
  }

  if (
    request.session.enabled &&
    request.session.persistToCredential &&
    credentialId &&
    options.credentials?.updateSecret
  ) {
    await options.credentials.updateSecret(credentialId, { cookies });
  }

  const { setCookies: _setCookies, ...publicResult } = result;
  return { ...publicResult, cookies };
}

async function dispatch(
  request: HttpRequestDef,
  secret: Record<string, unknown>,
  cookies: StoredCookie[],
  options: HttpExecuteOptions,
): Promise<Omit<HttpExecuteResult, 'cookies'> & { setCookies: StoredCookie[] }> {
  const { url, init } = buildHttpRequest(request, secret, cookies);
  const requestFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  try {
    const response = await requestFn(url, {
      ...init,
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let body: unknown = text;
    if (contentType.includes('application/json') || looksLikeJson(text)) {
      try {
        body = text.length ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers,
      body,
      url: reportableUrl(url, request.auth),
      setCookies: collectSetCookies(response.headers),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function resolveRequest(
  request: HttpRequestDef,
  variables: Record<string, unknown>,
): HttpRequestDef {
  return {
    ...request,
    url: interpolate(request.url, variables),
    query: resolveKvTemplates(request.query, variables),
    headers: resolveKvTemplates(request.headers, variables),
    auth: interpolateDeep(request.auth, variables),
    body: resolveBody(request.body, variables),
  };
}

function resolveBody(
  body: HttpRequestDef['body'],
  variables: Record<string, unknown>,
): HttpRequestDef['body'] {
  switch (body.mode) {
    case 'none':
      return body;
    case 'json':
      return {
        mode: 'json',
        json: interpolateDeep(body.json, variables),
        // The schema is a static contract — never interpolated.
        ...(body.schema ? { schema: body.schema } : {}),
      };
    case 'raw':
      return {
        mode: 'raw',
        raw: interpolate(body.raw, variables),
        contentType: interpolate(body.contentType, variables),
        ...(body.schema ? { schema: body.schema } : {}),
      };
    case 'form':
      return {
        mode: 'form',
        form: resolveKvTemplates(body.form, variables),
        ...(body.schema ? { schema: body.schema } : {}),
      };
    case 'fields':
      return {
        mode: 'fields',
        fields: body.fields.map((field) => ({
          ...field,
          value: interpolate(field.value, variables),
        })),
        ...(body.schema ? { schema: body.schema } : {}),
      };
  }
}

/** Validate a body payload against its JSON Schema; throws before any fetch. */
function assertBodySchema(
  schema: Record<string, unknown> | undefined,
  payload: unknown,
): void {
  if (!schema) return;
  const errors = validateAgainstSchema(schema, payload);
  if (errors !== null) {
    throw new HttpBodyValidationError(`request body invalid: ${errors}`);
  }
}

/** Raw bodies validate against their parsed JSON form. */
function parseRawForSchema(raw: string): unknown {
  try {
    return JSON.parse(raw || 'null') as unknown;
  } catch {
    throw new HttpBodyValidationError(
      'request body invalid: raw body is not valid JSON, cannot check schema',
    );
  }
}

function resolveKvTemplates(
  rows: HttpKv[],
  variables: Record<string, unknown>,
): HttpKv[] {
  return rows.map((row) => {
    const key = row.keyFrom
      ? String(getPath(variables, row.keyFrom) ?? '')
      : interpolate(row.key, variables);
    const value = row.valueFrom
      ? String(getPath(variables, row.valueFrom) ?? '')
      : interpolate(row.value, variables);
    return { ...row, key, value };
  });
}

function resolveKv(
  rows: HttpKv[],
): Array<{ key: string; value: string; op?: HttpKv['op'] }> {
  return rows
    .filter((row) => row.enabled && row.key.length > 0)
    .map((row) => ({
      key: row.key,
      value: row.value,
      ...(row.op ? { op: row.op } : {}),
    }));
}

function buildVariables(
  request: HttpRequestDef,
  secret: Record<string, unknown>,
  options: HttpExecuteOptions,
): Record<string, unknown> {
  const vars = {
    ...(request.variables ?? {}),
    ...(options.variables ?? {}),
  };
  return {
    ...vars,
    vars,
    secrets: flattenSecrets(secret),
    trigger: options.trigger ?? {},
  };
}

function flattenSecrets(
  secret: Record<string, unknown>,
): Record<string, unknown> {
  const accessToken =
    (typeof secret.accessToken === 'string' && secret.accessToken) ||
    (typeof secret.bearerToken === 'string' && secret.bearerToken) ||
    undefined;
  return {
    ...secret,
    ...(accessToken ? { accessToken, bearerToken: accessToken } : {}),
  };
}

/**
 * The requested address as it may be shown, with an API key sent in the query
 * string replaced. A failed HTTP sink or transform reports this URL in its
 * error, and a run's errors are read by anyone who can open the run — the key
 * itself stays with whoever holds the credential.
 */
function reportableUrl(url: string, auth: HttpRequestDef['auth']): string {
  if (auth.type !== 'apiKey' || auth.in !== 'query') return url;
  const shown = new URL(url);
  if (shown.searchParams.has(auth.key)) shown.searchParams.set(auth.key, 'REDACTED');
  return shown.toString();
}

function applyAuth(
  url: URL,
  headers: Headers,
  auth: HttpRequestDef['auth'],
  secret?: Record<string, unknown>,
): void {
  switch (auth.type) {
    case 'none':
      applyCredentialSecret(headers, secret);
      return;
    case 'bearer':
      headers.set('authorization', `Bearer ${auth.token}`);
      return;
    case 'basic': {
      const token = Buffer.from(`${auth.username}:${auth.password}`).toString(
        'base64',
      );
      headers.set('authorization', `Basic ${token}`);
      return;
    }
    case 'apiKey':
      if (auth.in === 'query') {
        url.searchParams.set(auth.key, auth.value);
      } else {
        headers.set(auth.key, auth.value);
      }
      return;
    case 'credential':
      applyCredentialSecret(headers, secret);
      return;
  }
}

/** Same shapes as CredentialStore `http` / webhook secrets. */
export function applyCredentialSecret(
  headers: Headers,
  secret: Record<string, unknown> | undefined,
): void {
  if (!secret) return;
  const bearer =
    (typeof secret.bearerToken === 'string' && secret.bearerToken) ||
    (typeof secret.accessToken === 'string' && secret.accessToken) ||
    undefined;
  if (bearer) {
    headers.set('authorization', `Bearer ${bearer}`);
  }
  if (
    typeof secret.apiKey === 'string' &&
    typeof secret.headerName === 'string'
  ) {
    headers.set(secret.headerName, secret.apiKey);
  }
  if (secret.headers && typeof secret.headers === 'object') {
    for (const [name, value] of Object.entries(secret.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
  }
}

async function maybeRefreshToken(options: {
  refresh: HttpTokenRefresh;
  secret: Record<string, unknown>;
  credentialId: string;
  credentials?: CredentialStore;
  variables: Record<string, unknown>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  proactive: boolean;
}): Promise<Record<string, unknown>> {
  const { refresh, secret } = options;
  if (!refresh.enabled) return secret;

  const needsRefresh =
    !options.proactive ||
    shouldRefreshProactively(secret, refresh.skewSeconds);
  if (!needsRefresh) return secret;

  const variables = {
    ...options.variables,
    secrets: flattenSecrets(secret),
  };
  const url = interpolate(refresh.url, variables);
  const headers = new Headers();
  for (const header of resolveKvTemplates(refresh.headers, variables)) {
    if (!header.enabled) continue;
    headers.set(header.key, header.value);
  }

  let body: string | undefined;
  if (refresh.body.mode === 'form') {
    const params = new URLSearchParams();
    for (const field of resolveKvTemplates(refresh.body.form, variables)) {
      if (!field.enabled) continue;
      params.append(field.key, field.value);
    }
    body = params.toString();
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
  } else {
    body = JSON.stringify(
      interpolateDeep(
        refresh.body.json ?? {
          refresh_token: '{{secrets.refreshToken}}',
          grant_type: 'refresh_token',
        },
        variables,
      ),
    );
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  const requestFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await requestFn(url, {
    method: refresh.method,
    headers,
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`token refresh returned ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const accessToken = getPath(payload, refresh.accessTokenPath);
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error(
      `token refresh missing access token at ${refresh.accessTokenPath}`,
    );
  }
  const patch: Record<string, unknown> = {
    accessToken,
    bearerToken: accessToken,
  };
  if (refresh.refreshTokenPath) {
    const nextRefresh = getPath(payload, refresh.refreshTokenPath);
    if (typeof nextRefresh === 'string') patch.refreshToken = nextRefresh;
  }
  if (refresh.expiresInPath) {
    const expiresIn = Number(getPath(payload, refresh.expiresInPath));
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      patch.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    }
  }

  const next = { ...secret, ...patch };
  if (options.credentials?.updateSecret) {
    await options.credentials.updateSecret(options.credentialId, patch);
  }
  return next;
}

function shouldRefreshProactively(
  secret: Record<string, unknown>,
  skewSeconds: number,
): boolean {
  const token =
    (typeof secret.accessToken === 'string' && secret.accessToken) ||
    (typeof secret.bearerToken === 'string' && secret.bearerToken);
  if (!token) return true;
  if (typeof secret.expiresAt !== 'string') return false;
  const expiresAt = new Date(secret.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() <= skewSeconds * 1000;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}
