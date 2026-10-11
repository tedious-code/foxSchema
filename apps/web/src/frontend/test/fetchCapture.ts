/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A fetch stand-in for API-client tests: records each request and answers
 * `{"ok":true,"removed":0}` with 200. Call `restoreFetch` in `afterEach`.
 */
const realFetch = globalThis.fetch;

export interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** Replaces `fetch`; the returned list fills as requests are made. */
export function captureRequests(): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, statusText: '', text: async () => '{"ok":true,"removed":0}' } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}
