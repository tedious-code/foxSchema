/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The HTTP client every API call goes through.
 *
 * Callers give a path, optionally a body and options, and get parsed JSON back:
 *
 *   const { tables } = await api.post<LoadSchemaResult>('/schema/load', ref);
 *   const info = await api.get<UpdateInfo>('/updates/check');
 *   await api.delete(`/connections/${id}`);
 *   const runs = await api.get<Runs>('/migrations', { query: { limit: 20 } });
 *
 * The base URL, the session cookie, the JSON headers and error handling are
 * applied here so a call site cannot forget one. Omitting `credentials` in
 * particular is invisible in single-user mode and fails only once multi-user
 * auth is switched on.
 *
 * A failed request throws `ApiError`, which carries the server's `code` from
 * `@foxschema/shared` alongside the message, so callers can branch on the kind
 * of failure rather than parsing text.
 *
 * For responses that are not JSON — a streamed NDJSON migration, a file
 * download — use `api.raw`, which returns the `Response` untouched.
 */
import type { ErrorCode } from '@foxschema/shared';
import { getApiBase, parseJsonBody } from './apiBase';
import { activeEditorWorkspaceId } from '../lib/editorWorkspaceStorage';

/** A request that reached the server and came back as a failure. */
export class ApiError extends Error {
  readonly status: number;
  /** The server's error code, when the response carried one. */
  readonly code?: ErrorCode;
  /** Field-level failures, present on validation errors. */
  readonly fields?: readonly { path: string; message: string }[];

  constructor(
    message: string,
    status: number,
    code?: ErrorCode,
    fields?: readonly { path: string; message: string }[]
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Values a query string can carry. `undefined` and `null` entries are dropped. */
export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  /** Appended as a query string, with each value URL-encoded. */
  query?: Record<string, QueryValue>;
  /** Cancels the request; pass an AbortController's signal. */
  signal?: AbortSignal;
  /** Extra headers, merged over the defaults. */
  headers?: Record<string, string>;
  /** Accept an empty response body as `{}` rather than treating it as an error. */
  allowEmpty?: boolean;
  /** Bypass the HTTP cache, for endpoints polled for fresh state. */
  noStore?: boolean;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Build `path?a=1&b=2`, skipping entries with no value. */
function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

/**
 * Send a request and return the raw `Response`.
 *
 * Use this for bodies that are not JSON: a streamed NDJSON response, or a file
 * download. The status is not checked, so the caller decides what to do with a
 * failure.
 */
export async function raw(
  method: Method,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<Response> {
  const hasBody = body !== undefined;
  const workspaceId = activeEditorWorkspaceId();
  return fetch(`${getApiBase()}${withQuery(path, options.query)}`, {
    method,
    // Every API route is same-origin and session-cookie authenticated.
    credentials: 'include',
    ...(options.noStore ? { cache: 'no-store' as const } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(workspaceId ? { 'X-Fox-Workspace': workspaceId } : {}),
      ...options.headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

/** Send a request, parse the JSON response, and throw `ApiError` on failure. */
async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  const res = await raw(method, path, body, options);
  // parseJsonBody turns an empty or non-JSON response into a message that says
  // what to do about it, so those cases are already covered here.
  const data = await parseJsonBody<T & { error?: string; code?: ErrorCode; fields?: never }>(
    res,
    { allowEmpty: options.allowEmpty }
  );
  if (!res.ok) {
    const payload = data as { error?: string; code?: ErrorCode; fields?: never };
    throw new ApiError(
      payload.error || res.statusText || `Request failed (${res.status})`,
      res.status,
      payload.code,
      payload.fields
    );
  }
  return data;
}

/**
 * The API client.
 *
 * Paths are relative to the API base, so pass `/schema/load`, not
 * `/api/schema/load`.
 */
export const api = {
  get: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('GET', path, undefined, options),

  post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('POST', path, body, options),

  put: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('PUT', path, body, options),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('PATCH', path, body, options),

  /** `delete` is a reserved word, so this is written as a property. */
  delete: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('DELETE', path, body, options),

  raw,
};
