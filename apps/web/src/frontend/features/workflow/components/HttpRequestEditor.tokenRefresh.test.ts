/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The editor re-reads a request on every edit; a token refresh's headers and
 * body, which it does not edit, must survive that.
 */
import { describe, expect, it } from 'vitest';
import { toHttpRequestValue } from './HttpRequestEditor';

describe('token refresh through the HTTP editor', () => {
  it('keeps the hand-written headers and body', () => {
    const headers = [{ key: 'x-client', value: 'fox', enabled: true }];
    const body = { mode: 'form', form: [{ key: 'grant_type', value: 'refresh_token', enabled: true }] };
    const value = toHttpRequestValue({
      url: 'https://api.test/x',
      method: 'GET',
      tokenRefresh: { enabled: true, url: 'https://api.test/token', headers, body },
    });
    expect(value.tokenRefresh).toMatchObject({ headers, body });
  });
});
