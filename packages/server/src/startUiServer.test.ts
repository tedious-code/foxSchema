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
 * JSON rather than a page. Also how the build is sent: the compressed copy the
 * browser accepts, a year's cache for hashed assets, and none for index.html.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { startUiServer, type StartedUiServer } from './startUiServer';
import { IMMUTABLE_ASSET, REVALIDATE } from './api/static-assets';

const SCRIPT = `export const app = ${JSON.stringify('fox'.repeat(500))};`;

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
    // What the build's precompress step leaves beside each file.
    writeFileSync(join(staticDir, 'assets', 'app-abc123.js'), SCRIPT);
    writeFileSync(join(staticDir, 'assets', 'app-abc123.js.br'), brotliCompressSync(SCRIPT));
    writeFileSync(join(staticDir, 'assets', 'app-abc123.js.gz'), gzipSync(SCRIPT));
    // Port 0 so this cannot collide with a dev server or another test file.
    started = await startUiServer({ port: 0, host: '127.0.0.1', staticDir });
  }, 120_000);

  afterAll(async () => {
    await started?.close();
  });

  const get = (path: string) => fetch(`http://127.0.0.1:${started.port}${path}`);

  /** The response as sent: fetch would decode it and hide the encoding. */
  const raw = (path: string, acceptEncoding: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
      (done, fail) => {
        const req = request(
          { host: '127.0.0.1', port: started.port, path, headers: { 'accept-encoding': acceptEncoding } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          }
        );
        req.on('error', fail);
        req.end();
      }
    );

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

  it('sends the Brotli copy, else the gzip copy, else the file itself', async () => {
    const br = await raw('/assets/app-abc123.js', 'gzip, deflate, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toMatch(/javascript/);
    expect(br.headers.vary).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(br.body).toString()).toBe(SCRIPT);

    const gz = await raw('/assets/app-abc123.js', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(SCRIPT);

    const plain = await raw('/assets/app-abc123.js', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(SCRIPT);
  });

  it('lets a browser keep hashed assets, and revalidate the page that names them', async () => {
    expect((await raw('/assets/app-abc123.js', 'br')).headers['cache-control']).toBe(IMMUTABLE_ASSET);
    expect((await raw('/assets/app.css', 'br')).headers['cache-control']).toBe(IMMUTABLE_ASSET);
    for (const path of ['/', '/schema/compare']) {
      const page = await get(path);
      expect(page.headers.get('cache-control')).toBe(REVALIDATE);
      expect(page.headers.get('content-security-policy')).toBeTruthy();
    }
    expect((await get('/api/health')).headers.get('cache-control')).toMatch(/no-store/);
  });

  it('answers a missing hashed asset with a 404, not the SPA page', async () => {
    // A tab open across a release asks for chunks the new build does not have;
    // index.html in their place fails to load as a module, with no way to recover.
    const res = await get('/assets/app-old999.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toMatch(/text\/html/);
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
