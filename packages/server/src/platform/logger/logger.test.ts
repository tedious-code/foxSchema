/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-time sign-in values arrive in URLs (OAuth `code`/`state`, the Fox
 * sign-in service's `assertion`) and must not reach the request log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { loggerConfig, redactUrl } from './logger';

describe('redactUrl', () => {
  it('blanks one-time sign-in values and keeps the rest of the URL', () => {
    expect(redactUrl('/api/auth/sso/broker/callback?assertion=eyJ.abc.def&state=n0nce')).toBe(
      '/api/auth/sso/broker/callback?assertion=[REDACTED]&state=[REDACTED]'
    );
    expect(redactUrl('/api/auth/sso/github/callback?code=gh-code&state=s&scope=read')).toBe(
      '/api/auth/sso/github/callback?code=[REDACTED]&state=[REDACTED]&scope=read'
    );
    expect(redactUrl('/cb?ID_TOKEN=x&Access_Token=y')).toBe('/cb?ID_TOKEN=[REDACTED]&Access_Token=[REDACTED]');
  });

  it('leaves URLs without secrets alone', () => {
    expect(redactUrl('/api/health')).toBe('/api/health');
    expect(redactUrl('/?sso_error=No%20account')).toBe('/?sso_error=No%20account');
    expect(redactUrl('/x?error=cancelled&page=2')).toBe('/x?error=cancelled&page=2');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('the request log', () => {
  const lines: string[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const config = loggerConfig({ pretty: false, level: 'info' });
    delete (config as { transport?: unknown }).transport;
    app = Fastify({ logger: { ...config, stream } });
    app.get('/api/auth/sso/broker/callback', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs the sign-in callback without its assertion or state', async () => {
    await app.inject({ url: '/api/auth/sso/broker/callback?assertion=eyJSECRET.part.sig&state=NONCE123' });
    const logged = lines.join('\n');
    expect(logged).toContain('/api/auth/sso/broker/callback?assertion=[REDACTED]&state=[REDACTED]');
    expect(logged).not.toContain('eyJSECRET');
    expect(logged).not.toContain('NONCE123');
  });
});
