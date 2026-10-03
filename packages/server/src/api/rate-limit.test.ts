import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../platform/http/types';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rateLimit } from '../platform/guards/rate-limit';

/** Minimal request/reply doubles — the limiter only touches these. */
function reqOf(over: Partial<AppRequest> & { userId?: string } = {}) {
  return { ip: '1.2.3.4', ...over } as AppRequest;
}
function resOf() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 0,
    body: null as unknown,
    header(k: string, v: string) { headers[k] = v; return res; },
    status(code: number) { res.statusCode = code; return res; },
    send(payload: unknown) { res.body = payload; return res; },
  };
  return res as unknown as FastifyReply & { headers: Record<string, string>; statusCode: number; body: unknown };
}

const run = (mw: ReturnType<typeof rateLimit>, req: AppRequest) => {
  const res = resOf();
  const next = vi.fn();
  mw(req, res, next);
  return { res, passed: next.mock.calls.length === 1 };
};

describe('rate limit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows up to the limit and blocks the next one', () => {
    const mw = rateLimit({ windowMs: 1000, max: 3, name: 't' });
    for (let i = 0; i < 3; i++) expect(run(mw, reqOf()).passed).toBe(true);
    const { res, passed } = run(mw, reqOf());
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it('does not allow a double burst across the window edge', () => {
    // The fixed-window bug: max at the end of one window plus max at the start
    // of the next is twice the intended rate, back to back.
    const mw = rateLimit({ windowMs: 1000, max: 2, name: 't' });
    vi.advanceTimersByTime(900);
    expect(run(mw, reqOf()).passed).toBe(true);
    expect(run(mw, reqOf()).passed).toBe(true);
    vi.advanceTimersByTime(200); // a fixed window would have reset here
    expect(run(mw, reqOf()).passed).toBe(false);
  });

  it('lets requests through again as individual hits age out', () => {
    const mw = rateLimit({ windowMs: 1000, max: 2, name: 't' });
    expect(run(mw, reqOf()).passed).toBe(true);
    vi.advanceTimersByTime(600);
    expect(run(mw, reqOf()).passed).toBe(true);
    expect(run(mw, reqOf()).passed).toBe(false);
    // Only the first hit has aged out, so exactly one slot opens.
    vi.advanceTimersByTime(401);
    expect(run(mw, reqOf()).passed).toBe(true);
    expect(run(mw, reqOf()).passed).toBe(false);
  });

  it('charges an authenticated user, not their IP', () => {
    // Otherwise one heavy user behind a shared address locks out everyone else.
    const mw = rateLimit({ windowMs: 1000, max: 1, name: 't' });
    const shared = '10.0.0.1';
    expect(run(mw, reqOf({ ip: shared, userId: 'alice' })).passed).toBe(true);
    expect(run(mw, reqOf({ ip: shared, userId: 'bob' })).passed).toBe(true);
    expect(run(mw, reqOf({ ip: shared, userId: 'alice' })).passed).toBe(false);
  });

  it('falls back to IP when there is no session', () => {
    const mw = rateLimit({ windowMs: 1000, max: 1, name: 't' });
    expect(run(mw, reqOf({ ip: '9.9.9.9' })).passed).toBe(true);
    expect(run(mw, reqOf({ ip: '9.9.9.9' })).passed).toBe(false);
    expect(run(mw, reqOf({ ip: '8.8.8.8' })).passed).toBe(true);
  });

  it('keeps named limiters independent', () => {
    // One endpoint's flood must not spend another endpoint's allowance.
    const a = rateLimit({ windowMs: 1000, max: 1, name: 'a' });
    const b = rateLimit({ windowMs: 1000, max: 1, name: 'b' });
    expect(run(a, reqOf()).passed).toBe(true);
    expect(run(a, reqOf()).passed).toBe(false);
    expect(run(b, reqOf()).passed).toBe(true);
  });

  it('tells the caller when to retry, and how much is left', () => {
    const mw = rateLimit({ windowMs: 2000, max: 1, name: 't' });
    const first = run(mw, reqOf());
    expect(first.res.headers['RateLimit-Limit']).toBe('1');
    expect(first.res.headers['RateLimit-Remaining']).toBe('0');

    vi.advanceTimersByTime(500);
    const blocked = run(mw, reqOf());
    expect(blocked.res.statusCode).toBe(429);
    // 2000ms window, 500ms elapsed → ~1.5s until the oldest hit ages out.
    expect(Number(blocked.res.headers['Retry-After'])).toBe(2);
    expect(blocked.res.headers['RateLimit-Remaining']).toBe('0');
  });

  it('never advertises a Retry-After of zero', () => {
    // A client reading 0 would retry instantly and be refused again.
    const mw = rateLimit({ windowMs: 1000, max: 1, name: 't' });
    run(mw, reqOf());
    vi.advanceTimersByTime(999);
    expect(Number(run(mw, reqOf()).res.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it('does not count a blocked request against the caller again', () => {
    // Otherwise a client that keeps retrying extends its own penalty forever.
    const mw = rateLimit({ windowMs: 1000, max: 1, name: 't' });
    run(mw, reqOf());
    for (let i = 0; i < 5; i++) run(mw, reqOf());
    vi.advanceTimersByTime(1001);
    expect(run(mw, reqOf()).passed).toBe(true);
  });

  it('charges the connection too when it claims a forwarded address', () => {
    // One private-network peer claiming a fresh X-Forwarded-For each time.
    const mw = rateLimit({ windowMs: 1000, max: 2, name: 't' });
    const viaPeer = (n: number) => reqOf({ ip: `10.9.0.${n}`, raw: { socket: { remoteAddress: '192.168.1.50' } } } as never);
    let passed = 0;
    for (let n = 0; n < 40; n++) if (run(mw, viaPeer(n)).passed) passed += 1;
    expect(passed).toBe(20); // PEER_FACTOR × max, not 40
  });

  it('leaves direct clients and signed-in users to their own buckets', () => {
    const mw = rateLimit({ windowMs: 1000, max: 2, name: 't' });
    const direct = (n: number) => reqOf({ ip: `10.9.1.${n}`, raw: { socket: { remoteAddress: `10.9.1.${n}` } } } as never);
    for (let n = 0; n < 40; n++) expect(run(mw, direct(n)).passed).toBe(true);
    const user = (n: number) => reqOf({ userId: `u${n}`, ip: `10.9.2.${n}`, raw: { socket: { remoteAddress: '192.168.1.51' } } } as never);
    for (let n = 0; n < 40; n++) expect(run(mw, user(n)).passed).toBe(true);
  });
});
