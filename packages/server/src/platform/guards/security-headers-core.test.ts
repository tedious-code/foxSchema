/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which headers the policy decides on, for a given path.
 *
 * This used to run through a middleware wrapper with a hand-rolled response
 * fake. The wrapper had no callers — the server applies this policy from an
 * `onRequest` hook — so the fake was asserting against a shape nothing served.
 * The policy is a pure function of the path, so it is called as one; that the
 * hook actually sets these on a live response is asserted in
 * `api/http-contract.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { securityHeadersFor, type SecurityHeaderOptions } from './security-headers-core';

const run = (path: string, opts: SecurityHeaderOptions = {}) => securityHeadersFor(path, opts);

describe('security headers', () => {
  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ])('sets %s on every response', (h, v) => {
    expect(run('/api/health')[h]).toBe(v);
    expect(run('/index.html')[h]).toBe(v);
  });

  it('forbids caching of API responses', () => {
    // These carry schema data and connection metadata; a shared cache holding
    // them would outlive the session that was allowed to see them.
    const headers = run('/api/connections');
    expect(headers['Cache-Control']).toMatch(/no-store/);
    expect(headers['Cache-Control']).toMatch(/private/);
  });

  it('leaves static assets cacheable', () => {
    // The SPA bundle is content-hashed; forbidding its cache would make every
    // page load re-download the app for no benefit.
    expect(run('/assets/app-abc123.js')['Cache-Control']).toBeUndefined();
  });

  it('sends a CSP for UI routes but not for API responses', () => {
    expect(run('/index.html')['Content-Security-Policy']).toBeTruthy();
    // A CSP on a JSON body does nothing; it would just be noise.
    expect(run('/api/health')['Content-Security-Policy']).toBeUndefined();
  });

  it('the CSP blocks framing, plugins and stray form posts', () => {
    const csp = run('/index.html')['Content-Security-Policy'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('the CSP allows the dev HMR socket in dev and drops wildcard ws:/wss: in production', () => {
    // Otherwise local development breaks in a way that invites turning the
    // whole header off.
    expect(run('/index.html', { isProduction: false })['Content-Security-Policy']).toMatch(/connect-src[^;]*ws:/);
    expect(run('/index.html', { isProduction: true })['Content-Security-Policy']).toContain("connect-src 'self';");
    expect(run('/index.html', { isProduction: true })['Content-Security-Policy']).not.toMatch(/ws:/);
  });

  it('omits HSTS by default', () => {
    // On plain-HTTP localhost this would pin a developer's browser to https
    // for a year — a self-inflicted outage that is awkward to undo.
    expect(run('/index.html')['Strict-Transport-Security']).toBeUndefined();
    expect(run('/index.html', { hsts: true })['Strict-Transport-Security']).toMatch(/max-age=/);
  });

  it('can be told it is not serving a UI', () => {
    expect(run('/index.html', { servesUi: false })['Content-Security-Policy']).toBeUndefined();
  });
});
