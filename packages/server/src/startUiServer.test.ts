/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single-origin server: frontend and API on one port.
 *
 * This file exists because of a bug nothing else could have caught. The HTTP
 * contract suite builds the API app; it never builds *this* one. When static
 * serving moved to Fastify, both `createFastifyApp` and `startUiServer` called
 * `setNotFoundHandler` — and Fastify allows exactly one per instance, so the
 * process threw on boot. Typecheck passed, 2448 tests passed, and the server
 * could not start.
 *
 * So the assertions here are about assembly and routing rules, not payloads:
 * that it boots at all, that a real file wins over the SPA fallback, that an
 * unknown app path gets index.html, and that an unknown API path still gets
 * JSON rather than a page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUiServer, type StartedUiServer } from './startUiServer';

describe('single-origin server', () => {
  let started: StartedUiServer;
  let staticDir: string;

  beforeAll(async () => {
    process.env.LOCAL_SINGLE_USER = 'true';
    process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);
    staticDir = mkdtempSync(join(tmpdir(), 'foxschema-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Fox Schema</title>');
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'assets', 'app.css'), 'body{color:red}');
    // Port 0 so this cannot collide with a dev server or another test file.
    started = await startUiServer({ port: 0, host: '127.0.0.1', staticDir });
  }, 120_000);

  afterAll(async () => {
    await started?.close();
  });

  const get = (path: string) => fetch(`http://127.0.0.1:${started.port}${path}`);

  it('boots and serves the API', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('serves the frontend at the root', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('serves a real static file rather than the fallback', async () => {
    const res = await get('/assets/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
    expect(await res.text()).toContain('color:red');
  });

  it('hands an unknown app path to the client-side router', async () => {
    const res = await get('/schema/compare');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('answers an unknown API path with JSON, not the SPA page', async () => {
    // Returning index.html here would make every mistyped endpoint look like a
    // success to a client that only checks the status.
    const res = await get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('will not listen on the network outside production', async () => {
    expect(process.env.NODE_ENV).not.toBe('production');
    await expect(startUiServer({ port: 0, host: '0.0.0.0', staticDir })).rejects.toThrow(/will not listen on 0\.0\.0\.0/);
  });

  it('refuses to start without a frontend to serve', async () => {
    const previous = process.env.STATIC_DIR;
    delete process.env.STATIC_DIR;
    try {
      await expect(startUiServer({ port: 0 })).rejects.toThrow(/staticDir/);
    } finally {
      if (previous !== undefined) process.env.STATIC_DIR = previous;
    }
  });
});
