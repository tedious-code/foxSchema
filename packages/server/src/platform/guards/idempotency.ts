import type { FastifyReply } from 'fastify';
import type { AppRequest, Middleware, NextFunction } from '../../platform/http/types';
import { createHash } from 'node:crypto';
import { sendError } from '../../platform/http/respond';

/**
 * Idempotency for the endpoints that change something.
 *
 * The dangerous case is a retry the caller did not intend: a dropped response,
 * a double-click, a proxy timeout, or an offline banner prompting someone to
 * press Run again. The request already reached the database — the *reply* is
 * what went missing — so retrying applies the migration or the GRANT twice.
 *
 * A caller supplies `Idempotency-Key` on a mutating request. The first one runs
 * and its response is remembered; a repeat with the same key returns that
 * remembered response instead of executing again.
 *
 * Two properties worth stating, because they are what make this safe rather
 * than merely convenient:
 *
 * - **In-flight requests are held, not waved through.** A duplicate arriving
 *   while the first is still running waits for it. Returning "in progress"
 *   would leave the caller to retry, which is the thing being prevented.
 * - **The key is bound to the request body.** Reusing a key with a different
 *   payload is a client bug, and replaying the old response would hide it. That
 *   is rejected loudly instead.
 *
 * Per-process and in-memory, like the rest of this app's middleware: it makes a
 * single server's retries safe. It is not a distributed transaction log.
 */
import { headerOf } from '../../platform/http/reply';

export interface IdempotencyOptions {
  /** How long a completed response stays replayable. */
  ttlMs?: number;
  /** Cap on remembered entries, so a long-lived server cannot grow forever. */
  maxEntries?: number;
}

interface Completed {
  kind: 'done';
  status: number;
  body: unknown;
  fingerprint: string;
  storedAt: number;
}

interface InFlight {
  kind: 'running';
  fingerprint: string;
  storedAt: number;
  waiters: Array<(entry: Completed) => void>;
}

type Entry = Completed | InFlight;

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

/** Body + actor hash, so the same key across users, workspaces, or payloads cannot replay. */
function fingerprintOf(req: AppRequest): string {
  const authed = req as { userId?: string; workspaceId?: string };
  const material = JSON.stringify({
    path: req.url,
    userId: authed.userId ?? null,
    workspaceId: authed.workspaceId ?? null,
    body: req.body ?? null,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function idempotency(options: IdempotencyOptions = {}): Middleware {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, Entry>();

  const sweep = (now: number) => {
    for (const [k, e] of entries) {
      // Never evict something still running — a waiter is depending on it.
      if (e.kind === 'done' && now - e.storedAt > ttlMs) entries.delete(k);
    }
    if (entries.size <= maxEntries) return;
    // Oldest-first eviction; Map preserves insertion order.
    for (const [k, e] of entries) {
      if (entries.size <= maxEntries) break;
      if (e.kind === 'done') entries.delete(k);
    }
  };

  return (req: AppRequest, res: FastifyReply, next: NextFunction): void => {
    const header = headerOf(req, 'Idempotency-Key');
    const key = typeof header === 'string' ? header.trim() : '';
    // Opt-in: without a key this behaves exactly as before.
    if (!key) return next();
    if (key.length > 200) {
      sendError(res, 'invalid_input', 'Idempotency-Key must be 200 characters or fewer.');
      return;
    }

    const now = Date.now();
    sweep(now);

    const authed = req as { userId?: string; workspaceId?: string };
    const scopedKey = `${authed.userId ?? 'anon'}:${authed.workspaceId ?? ''}:${key}`;
    const fingerprint = fingerprintOf(req);
    const existing = entries.get(scopedKey);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        // Silently replaying the first response here would hide a real client
        // bug and could return someone else's result.
        sendError(res, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
        return;
      }
      if (existing.kind === 'done') {
        res.header('Idempotency-Replayed', 'true');
        res.status(existing.status).send(existing.body);
        return;
      }
      // Still running: wait for the original rather than sending the caller
      // away to retry — retrying is exactly what this exists to prevent.
      existing.waiters.push((done) => {
        res.header('Idempotency-Replayed', 'true');
        res.status(done.status).send(done.body);
      });
      return;
    }

    const inFlight: InFlight = { kind: 'running', fingerprint, storedAt: now, waiters: [] };
    entries.set(scopedKey, inFlight);

    // Capture the response so it can be replayed, without changing how any
    // handler writes it.
    const originalSend = res.send.bind(res);
    let settled = false;

    const settle = (status: number, body: unknown) => {
      if (settled) return;
      settled = true;
      const done: Completed = {
        kind: 'done',
        status,
        body,
        fingerprint,
        storedAt: Date.now(),
      };
      entries.set(scopedKey, done);
      for (const waiter of inFlight.waiters) waiter(done);
      inFlight.waiters.length = 0;
    };

    res.send = ((body: unknown) => {
      settle(res.statusCode, body);
      return originalSend(body);
    }) as typeof res.send;

    // /migration/execute streams NDJSON via write/end and never calls send().
    // Without settling on a completed stream, `close` frees the key and a
    // retry with the same Idempotency-Key re-applies the DDL.
    res.raw.on('finish', () => {
      settle(res.statusCode || 200, { ok: true, streamed: true });
    });

    // A handler that throws, or a socket that closes before finish, must not
    // leave the key wedged in-flight — the next attempt would hang behind a
    // request that is never going to answer.
    res.raw.on('close', () => {
      if (settled) return;
      settled = true;
      entries.delete(scopedKey);
      const failed: Completed = {
        kind: 'done',
        status: 500,
        body: { ok: false, error: 'The original request ended without a response.' },
        fingerprint,
        storedAt: Date.now(),
      };
      for (const waiter of inFlight.waiters) waiter(failed);
      inFlight.waiters.length = 0;
    });

    next();
  };
}
