/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which response headers to set, with no framework in it.
 *
 * Applied by the server's `onRequest` hook, which is early enough to cover
 * 404s, rate-limit rejections and error responses — the places per-route
 * middleware tends to miss.
 */

export interface SecurityHeaderOptions {
  /** Serving the built UI from this origin, so a CSP applies. */
  servesUi?: boolean;
  /**
   * Send HSTS. Off by default: this usually runs on plain-HTTP localhost, and
   * the header there pins a developer's browser to https://localhost for
   * months — a self-inflicted outage that is awkward to undo.
   */
  hsts?: boolean;
  /** Tighter production CSP (omits dev HMR wildcard ws:/wss:). Defaults to NODE_ENV === 'production'. */
  isProduction?: boolean;
}

function cspFor(isProduction: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Required by Tailwind runtime theming, which sets CSS variables inline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Same-origin XHR; dev also permits ws:/wss: for Vite HMR.
    isProduction ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The headers for one request path.
 *
 * `path` decides two things: API responses must never sit in a shared cache
 * (they carry schema data and connection metadata), while the UI's
 * content-hashed assets are meant to be cached; and a CSP on a JSON body does
 * nothing, so it is sent only for UI routes.
 */
export function securityHeadersFor(
  path: string,
  options: SecurityHeaderOptions = {}
): Record<string, string> {
  const {
    servesUi = true,
    hsts = false,
    isProduction = process.env.NODE_ENV === 'production',
  } = options;
  const isApi = path.startsWith('/api');

  const headers: Record<string, string> = {
    // Stop a browser second-guessing a JSON response into something executable.
    'X-Content-Type-Options': 'nosniff',
    // Clickjacking a page that can run migrations is a real risk, not a
    // theoretical one.
    'X-Frame-Options': 'DENY',
    // Referrers can carry connection names and object paths.
    'Referrer-Policy': 'no-referrer',
    // Isolate browsing context and block cross-origin resource reads.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy':
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()',
  };

  if (isApi) {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private';
    headers.Pragma = 'no-cache';
  }
  if (hsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  if (servesUi && !isApi) {
    headers['Content-Security-Policy'] = cspFor(isProduction);
  }
  return headers;
}
