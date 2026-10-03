/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pino configuration for the API.
 *
 * Three destinations, chosen by environment rather than by code:
 *
 *   development   pretty-printed to the terminal
 *   production    structured JSON on stdout
 *   FOX_LOG_FILE  structured JSON to a file, asynchronously
 *
 * The file destination exists because Fox Schema also ships as a desktop app
 * and a CLI, where there is no platform collector to catch stdout and "send me
 * the log" is a real support request. In a container prefer stdout and let the
 * platform handle rotation and shipping — a Node process managing its own log
 * files is a worse version of what Docker already does.
 *
 * Whichever destination is used, writes are asynchronous. A synchronous file
 * write on the request path blocks the event loop, which is the same failure
 * this codebase already measured with CSV parsing.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger } from 'pino';
import type { AppLogger } from '@foxschema/db';

/**
 * Values that must never reach a log line.
 *
 * Fox Schema holds database credentials, so this is not a formality. The paths
 * cover the shapes those values actually travel in: a saved connection's
 * `option.password`, a session password on the request body, an auth header.
 */
const REDACT_PATHS = [
  'password',
  '*.password',
  '*.*.password',
  'option.password',
  'connectionString',
  '*.connectionString',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

/**
 * Query parameters whose values are one-time credentials: an OAuth `code` and
 * `state`, the Fox sign-in service's signed `assertion`, and tokens a provider
 * may put in a URL. A browser brings them back on a GET redirect, so without
 * this they land in the access log with the rest of the URL.
 */
const SECRET_QUERY_PARAMS = new Set([
  'assertion',
  'code',
  'state',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'code_verifier',
]);

/**
 * A query parameter's name, decoded for comparison. A serializer must never
 * throw, and `decodeURIComponent` does on malformed escapes (`%E0%A4%A`), so
 * an undecodable name is compared as written.
 */
function decodeName(raw: string): string {
  const spaced = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced).toLowerCase();
  } catch {
    return spaced.toLowerCase();
  }
}

/** `url` with the value of every secret query parameter replaced by `[REDACTED]`. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = decodeName(eq === -1 ? pair : pair.slice(0, eq));
      return SECRET_QUERY_PARAMS.has(name) && eq !== -1 ? `${pair.slice(0, eq)}=[REDACTED]` : pair;
    })
    .join('&');
  return `${url.slice(0, q)}?${query}`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/** The fields Fastify logs for a request, with secrets taken out of the URL. */
function serializeRequest(req: LoggedRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

export interface LoggerOptions {
  level?: string;
  /** Write JSON to this path instead of stdout. */
  file?: string;
  /** Force pretty output; defaults to on outside production. */
  pretty?: boolean;
}

function resolveLevel(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/**
 * The Pino options object, separated so the Fastify server can hand it to
 * `Fastify({ logger })` and get request logging and correlation ids for free
 * rather than building a second logger beside it.
 */
export function loggerConfig(options: LoggerOptions = {}): pino.LoggerOptions {
  const level = resolveLevel(options.level);
  const file = options.file ?? process.env.FOX_LOG_FILE;
  const pretty = options.pretty ?? (!file && process.env.NODE_ENV !== 'production');

  const base: pino.LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { req: serializeRequest },
    // A request id per line is what makes a failure traceable across the
    // handler, the service and the driver.
    base: { service: 'foxschema-api' },
  };

  if (file) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the log file path is the operator's own configuration (FOX_LOG_FILE), not a request value
    mkdirSync(dirname(file), { recursive: true });
    return {
      ...base,
      transport: {
        // A transport runs on its own thread, so a slow disk cannot stall the
        // request path.
        target: 'pino/file',
        options: { destination: file, mkdir: true },
      },
    };
  }

  if (pretty) {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:standard', ignore: 'pid,hostname,service' },
      },
    };
  }

  // Production default: JSON on stdout for the platform collector to pick up.
  return base;
}

let rootLogger: Logger | null = null;

/**
 * The process-wide logger.
 *
 * Used for lifecycle events that happen outside any request — startup,
 * shutdown, background sweeps. Request-scoped code should use the child logger
 * Fastify attaches to the request instead, so lines carry a correlation id.
 */
export function getLogger(options: LoggerOptions = {}): Logger {
  if (!rootLogger) rootLogger = pino(loggerConfig(options));
  return rootLogger;
}

/** Narrow the Pino logger to the shape the packages accept. */
export function asAppLogger(logger: Logger): AppLogger {
  return logger as unknown as AppLogger;
}
