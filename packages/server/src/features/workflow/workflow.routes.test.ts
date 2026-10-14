/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The engine proxy: what reaches the workflow engine, with what, and who may
 * send it. The engine has no authentication of its own, so these routes are the
 * whole access model for it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { AdminConfigPut, WorkflowEngineConfig } from '@foxschema/workflow-contract';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../../platform/http/types';
import { ENGINE_ROUTES, WorkflowEngineProxyService } from './workflow-engine-proxy.service';
import type { WorkflowSettingsService } from './workflow-settings.service';
import { createWorkflowRoutes } from './workflow.routes';

const ENGINE = 'http://engine.test:3080';
const ALL_WORKFLOW: Permission[] = ['workflow.access', 'workflow.design', 'workflow.run', 'workflow.admin'];

type Call = { url: string; init: RequestInit };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(
  permissions: Permission[],
  options: {
    state?: WorkflowEngineConfig['state'];
    respond?: (call: Call) => Response | Promise<Response>;
    listen?: boolean;
    /** Saved connections in a workspace this caller is not a member of. */
    foreignConnections?: string[];
  } = {},
) {
  const calls: Call[] = [];
  const puts: AdminConfigPut[] = [];
  const config = (): WorkflowEngineConfig => ({
    state: options.state ?? 'enabled',
    endpoint: ENGINE,
    maxParallel: 4,
    onOverlap: 'skip',
    processes: [],
    sinks: [],
  });
  const settings = {
    getConfig: async () => config(),
    putConfig: async (body: AdminConfigPut) => {
      puts.push(body);
      return { ...config(), ...body };
    },
  } as unknown as WorkflowSettingsService;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return options.respond ? options.respond(call) : Response.json({ ok: true });
  }) as typeof fetch;

  // Mounted where server.ts mounts it, so path handling is exercised for real.
  const root = Router();
  root.use(
    '/api/workflow',
    createWorkflowRoutes(settings, new WorkflowEngineProxyService(settings, fetchImpl), {
      list: async () => [],
      grant: async () => undefined,
      revoke: async () => false,
      notUsableBy: async (_userId: string, ids: readonly string[]) =>
        ids.filter((id) => (options.foreignConnections ?? []).includes(id)),
    }),
  );

  // Destroy sockets on close rather than wait for them. A client that aborts
  // mid-stream can leave its connection lingering on Linux, and the default
  // graceful close then waits past the hook timeout.
  app = Fastify({ forceCloseConnections: true });
  app.addHook('onRequest', async (req, reply) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'user-1';
    authed.appRole = 'viewer';
    authed.permissions = new Set(permissions);
    // Stand-in for the security headers the real server adds.
    reply.header('x-content-type-options', 'nosniff');
  });
  bindRoutes(app, root.flatten());
  if (options.listen) await app.listen({ port: 0, host: '127.0.0.1' });
  else await app.ready();
  return { server: app, calls, puts };
}

const headersOf = (call: Call) => new Headers(call.init.headers);

/** Read until `marker` has arrived, failing fast rather than hanging the suite. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  ms: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (!text.includes(marker)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`"${JSON.stringify(marker)}" not delivered within ${ms}ms`)),
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return text;
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

describe('engine proxy — what is forwarded', () => {
  it('relays a read to the engine under /api, keeping the query string', async () => {
    const { server, calls } = await serve(['workflow.access']);
    const res = await server.inject({ method: 'GET', url: '/api/workflow/engine/runs/r1/events?after=5' });

    expect(res.statusCode).toBe(200);
    // First the run's snapshot, read to check the connections it used (this
    // stand-in names none), then the relayed read itself.
    expect(calls.map((call) => call.url)).toEqual([
      `${ENGINE}/api/runs/r1/snapshot`,
      `${ENGINE}/api/runs/r1/events?after=5`,
    ]);
    expect(calls[1]!.init.method).toBe('GET');
  });

  it("forwards an edit's JSON body and nothing of the caller's session", async () => {
    const { server, calls } = await serve(['workflow.design']);
    await server.inject({
      method: 'PUT',
      url: '/api/workflow/engine/workflows/wf-1',
      headers: { cookie: 'fox_session=secret', authorization: 'Bearer secret' },
      payload: { id: 'wf-1', pipelines: [] },
    });

    // The stored workflow is read first, so a save cannot drop a connection the
    // caller cannot use. The edit itself is the PUT.
    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
    const put = calls[1]!;
    expect(JSON.parse(String(put.init.body))).toEqual({ id: 'wf-1', pipelines: [] });
    // The FoxSchema session must never travel to another process.
    expect(headersOf(put).get('cookie')).toBeNull();
    expect(headersOf(put).get('authorization')).toBeNull();
    expect(headersOf(put).get('content-type')).toBe('application/json');
  });

  it('sends no content type on a bodyless POST, which the engine would reject', async () => {
    const { server, calls } = await serve(['workflow.design']);
    await server.inject({ method: 'POST', url: '/api/workflow/engine/environments/e1/activate' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headersOf(calls[0]!).get('content-type')).toBeNull();
  });

  it("relays the engine's status and error body unchanged", async () => {
    const { server } = await serve(['workflow.access'], {
      respond: () => Response.json({ error: 'workflow not found' }, { status: 404 }),
    });
    const res = await server.inject({ method: 'GET', url: '/api/workflow/engine/workflows/nope' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'workflow not found' });
  });

  it('delivers run events as they arrive, with the security headers intact', async () => {
    // A relay that buffered the whole response would pass against a stream that
    // closes at once — and hang forever on a real run stream, which only ends
    // with the run. So the engine holds its stream open after the first event,
    // and that event must reach the client before the engine sends another.
    const encoder = new TextEncoder();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const { server } = await serve(['workflow.access'], {
      listen: true,
      // The run itself is read first (JSON), to check its workflow's connections.
      respond: (call) =>
        !call.url.includes('/events/stream') ? Response.json({ id: 'r1' }) : new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"seq":1}\n\n'));
              void released.then(() => {
                controller.enqueue(encoder.encode('data: {"seq":2}\n\n'));
                controller.close();
              });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const { port } = server.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/workflow/engine/runs/r1/events/stream?after=0`);

    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const reader = res.body!.getReader();
    expect(await readUntil(reader, '\n\n', 2000)).toBe('data: {"seq":1}\n\n');
    release();
    expect(await readToEnd(reader)).toBe('data: {"seq":2}\n\n');
  });

  it('stops a slow edit when the client disconnects — and not before', async () => {
    // For a request with a body, Node emits the request's `close` once that
    // body is read, not when the client leaves. A proxy listening there would
    // never cancel a forwarded edit — which a bodyless GET would not show.
    let engineSignal: AbortSignal | undefined;
    let abortedOnArrival: boolean | undefined;
    let arrived!: () => void;
    const engineReached = new Promise<void>((resolve) => (arrived = resolve));
    const { server } = await serve(['workflow.design'], {
      listen: true,
      respond: (call) => {
        // The membership read of the stored workflow answers at once. The edit
        // is the call that must stay open until the client leaves.
        if (call.init.method === 'GET') return Response.json({ id: 'wf-1', pipelines: [] });
        engineSignal = call.init.signal ?? undefined;
        abortedOnArrival = engineSignal?.aborted;
        arrived();
        // A slow engine: it answers only by failing once the call is aborted.
        return new Promise<Response>((_, reject) =>
          engineSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
      },
    });
    const { port } = server.server.address() as { port: number };
    const client = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/workflow/engine/workflows/wf-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'wf-1', pipelines: [] }),
      signal: client.signal,
    }).catch(() => undefined);
    await engineReached;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(abortedOnArrival).toBe(false);
    expect(engineSignal?.aborted).toBe(false);

    client.abort();
    await pending;
    await vi.waitFor(() => expect(engineSignal?.aborted).toBe(true), { timeout: 2000 });
  });

  it('stops the engine call when the client disconnects — and not before', async () => {
    const encoder = new TextEncoder();
    let engineSignal: AbortSignal | undefined;
    const { server } = await serve(['workflow.access'], {
      listen: true,
      respond: (call) => {
        // The run itself is read first (JSON), to check its workflow's connections.
        if (!call.url.includes('/events/stream')) return Response.json({ id: 'r1' });
        engineSignal = call.init.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"seq":1}\n\n'));
              // A real fetch errors its body when aborted; the stream otherwise
              // stays open, like a run that has not finished.
              engineSignal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const { port } = server.server.address() as { port: number };
    const client = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/workflow/engine/runs/r1/events/stream`, {
      signal: client.signal,
    });
    await readUntil(res.body!.getReader(), '\n\n', 2000);

    // Still streaming, so nothing has aborted the engine call yet.
    expect(engineSignal?.aborted).toBe(false);

    client.abort();
    await vi.waitFor(() => expect(engineSignal?.aborted).toBe(true), { timeout: 2000 });
  });
});

describe('engine proxy — who may reach it', () => {
  it('guards every allowlisted route: no permission, no forwarding', async () => {
    const { server, calls } = await serve([]);
    for (const route of ENGINE_ROUTES) {
      const url = `/api/workflow/engine${route.path.replace(/:[A-Za-z]+/g, 'x')}`;
      const res = await server.inject({ method: route.method, url });
      expect(res.statusCode, `${route.method} ${route.path}`).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an edit to a reader and never contacts the engine', async () => {
    const { server, calls } = await serve(['workflow.access']);
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('takes workflow.admin, not design, to store an engine credential', async () => {
    const designer = await serve(['workflow.design']);
    const denied = await designer.server.inject({
      method: 'POST',
      url: '/api/workflow/engine/credentials',
      payload: { name: 'n', kind: 'http', data: {} },
    });
    expect(denied.statusCode).toBe(403);
    expect(designer.calls).toHaveLength(0);
    await app?.close();

    const admin = await serve(['workflow.admin']);
    const allowed = await admin.server.inject({
      method: 'POST',
      url: '/api/workflow/engine/credentials',
      payload: { name: 'n', kind: 'http', data: {} },
    });
    expect(allowed.statusCode).toBe(200);
    expect(admin.calls).toHaveLength(1);
  });

  it('does not expose trigger ingress, or anything else off the allowlist', async () => {
    const { server, calls } = await serve(ALL_WORKFLOW);
    for (const [method, url] of [
      ['POST', '/api/workflow/engine/triggers/wf-1/hook'],
      ['GET', '/api/workflow/engine/setup/credentials'],
      ['POST', '/api/workflow/engine/workflows/wf-1/dry-run'],
    ] as const) {
      const res = await server.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('engine proxy — engine state', () => {
  it('refuses to start a run while the engine is not accepting runs', async () => {
    for (const state of ['draining', 'disabled'] as const) {
      const { server, calls } = await serve(['workflow.run'], { state });
      const res = await server.inject({ method: 'POST', url: '/api/workflow/engine/workflows/wf-1/run' });
      expect(res.statusCode, state).toBe(409);
      expect(res.json().code).toBe('conflict');
      expect(calls).toHaveLength(0);
      await app?.close();
      app = undefined;
    }
  });

  it('still lets other engine calls through while draining — only new runs stop', async () => {
    const { server, calls } = await serve(['workflow.design'], { state: 'draining' });
    const res = await server.inject({ method: 'POST', url: '/api/workflow/engine/environments/e1/activate' });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('answers unavailable when the engine cannot be reached', async () => {
    const { server } = await serve(['workflow.access'], {
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    const res = await server.inject({ method: 'GET', url: '/api/workflow/engine/workflows' });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('unavailable');
  });
});

describe('PUT /api/workflow/settings — engine endpoint', () => {
  const put = (server: FastifyInstance, payload: unknown) =>
    server.inject({ method: 'PUT', url: '/api/workflow/settings', payload: payload as object });

  it('saves an http(s) endpoint in the normalised form the proxy fetches from', async () => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const res = await put(server, { endpoint: '  http://127.0.0.1:3080/  ' });

    expect(res.statusCode).toBe(200);
    expect(puts).toEqual([{ endpoint: 'http://127.0.0.1:3080' }]);
  });

  it.each([
    ['a non-URL', 'not a url'],
    ['a file: URL', 'file:///etc/passwd'],
    ['a data: URL', 'data:text/plain,hi'],
    ['a non-string', 3080],
  ])('refuses %s and saves nothing', async (_label, endpoint) => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const res = await put(server, { endpoint, state: 'enabled' });

    expect(res.statusCode).toBe(400);
    expect(puts).toEqual([]);
  });

  it('leaves the endpoint alone when the body does not mention it', async () => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    await put(server, { state: 'draining' });

    expect(puts).toEqual([{ state: 'draining' }]);
  });

  it('takes workflow.admin — a designer cannot repoint the engine', async () => {
    const { server, puts } = await serve(['workflow.access', 'workflow.design', 'workflow.run']);
    const res = await put(server, { endpoint: 'http://attacker.test' });

    expect(res.statusCode).toBe(403);
    expect(puts).toEqual([]);
  });
});

describe('PUT /api/workflow/settings — values the engines understand', () => {
  const put = (server: FastifyInstance, payload: unknown) =>
    server.inject({ method: 'PUT', url: '/api/workflow/settings', payload: payload as object });

  // Every engine refuses a whole settings refresh on a value it does not know,
  // so one saved typo stopped every later change from reaching them.
  it.each([
    ['an unknown state', { state: 'paused' }],
    ['an unknown overlap policy', { onOverlap: 'replace' }],
    ['an unknown sink kind', { sinks: [{ kind: 'syslog', enabled: true }] }],
    ['sinks that are not an array', { sinks: 'json' }],
  ])('refuses %s and saves nothing', async (_label, payload) => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const res = await put(server, payload);

    expect(res.statusCode).toBe(400);
    expect(puts).toEqual([]);
  });

  it('saves every known value', async () => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const body = { state: 'draining', onOverlap: 'queue', sinks: [{ kind: 'events', enabled: true }] };
    const res = await put(server, body);

    expect(res.statusCode).toBe(200);
    expect(puts).toEqual([body]);
  });
});

describe('engine proxy — steering a run', () => {
  // The Runs panel cancels, resumes, and answers a human gate. Each one is
  // held to the connections in the run's snapshot.
  it.each([
    ['GET', '/api/workflow/engine/runs/r1/inputs'],
    ['POST', '/api/workflow/engine/runs/r1/inputs'],
    ['POST', '/api/workflow/engine/runs/r1/cancel'],
    ['POST', '/api/workflow/engine/runs/r1/resume'],
  ] as const)('forwards %s %s after reading the snapshot', async (method, url) => {
    const { server, calls } = await serve(['workflow.run']);
    const answering = method === 'POST' && url.endsWith('/inputs');
    const res = await server.inject({
      method,
      url,
      ...(answering ? { payload: { key: 'q', values: { a: 1 } } } : {}),
    });
    expect(res.statusCode).toBe(200);
    const enginePath = url.replace('/api/workflow/engine', '/api');
    expect(calls.map((call) => `${call.init.method ?? 'GET'} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/runs/r1/snapshot',
      `${method} ${enginePath}`,
    ]);
    if (method === 'POST' && !answering) {
      expect(calls[1]!.init.body).toBeUndefined();
      expect(headersOf(calls[1]!).get('content-type')).toBeNull();
    }
  });

  it('refuses to steer a run whose snapshot uses a foreign connection', async () => {
    const snapshot = {
      id: 'wf-1',
      pipelines: [{ id: 'main', pipes: [{ id: 'q', type: 'source.db.sql', credentialId: 'foxschema-conn-a', config: {} }] }],
    };
    const { server, calls } = await serve(['workflow.run'], {
      foreignConnections: ['conn-a'],
      respond: (call) => {
        const path = new URL(call.url).pathname;
        if (call.init.method === 'GET' && path === '/api/runs/r1/snapshot') return Response.json(snapshot);
        return Response.json({ ok: true });
      },
    });
    const res = await server.inject({ method: 'POST', url: '/api/workflow/engine/runs/r1/cancel' });
    expect(res.statusCode).toBe(403);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/runs/r1/snapshot']);
  });
});

describe('engine proxy — saved connections stay with their workspace', () => {
  // The engine keeps one install-wide set of workflows. A connection linked by
  // workspace A was otherwise usable by every designer: save a workflow naming
  // its credential, run it, and read A's database with A's saved password.
  const usesForeign = {
    id: 'wf-1',
    pipelines: [{ id: 'main', pipes: [{ id: 'q', type: 'source.db.sql', credentialId: 'foxschema-conn-a', config: {} }] }],
  };
  const engineWith = (workflow: unknown) => (call: Call) => {
    const path = new URL(call.url).pathname;
    if (call.init.method === 'GET' && path === '/api/workflows/wf-1') return Response.json(workflow);
    // What the run executed, which outlives an edit or delete of the live workflow.
    if (call.init.method === 'GET' && path === '/api/runs/r1/snapshot') return Response.json(workflow);
    return Response.json({ ok: true });
  };
  const all = ['workflow.access', 'workflow.design', 'workflow.run'] as Permission[];

  it('refuses to save a workflow that uses another workspace’s connection', async () => {
    const { server, calls } = await serve(all, { foreignConnections: ['conn-a'] });
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: usesForeign });
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['run', 'POST', '/api/workflow/engine/workflows/wf-1/run'],
    ['duplicate', 'POST', '/api/workflow/engine/workflows/wf-1/duplicate'],
    ['read a run of', 'GET', '/api/workflow/engine/runs/r1/events'],
  ] as const)('refuses to %s it, after reading it from the engine', async (_label, method, url) => {
    const { server, calls } = await serve(all, { foreignConnections: ['conn-a'], respond: engineWith(usesForeign) });
    const res = await server.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(res.statusCode).toBe(403);
    // Only the reads the check made reached the engine — never the action.
    expect(calls.every((call) => call.init.method === 'GET')).toBe(true);
    expect(calls.map((call) => new URL(call.url).pathname)).not.toContain(url.replace('/api/workflow/engine', '/api'));
  });

  it('still refuses the run after the live workflow drops the connection', async () => {
    const stripped = {
      id: 'wf-1',
      pipelines: [{ id: 'main', pipes: [{ id: 'h', type: 'source.http', config: {} }] }],
    };
    const { server, calls } = await serve(all, {
      foreignConnections: ['conn-a'],
      respond: (call) => {
        const path = new URL(call.url).pathname;
        if (path === '/api/workflows/wf-1') return Response.json(stripped);
        if (path === '/api/runs/r1/snapshot') return Response.json(usesForeign);
        return Response.json({ ok: true });
      },
    });
    const res = await server.inject({ method: 'GET', url: '/api/workflow/engine/runs/r1/events' });
    expect(res.statusCode).toBe(403);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/runs/r1/snapshot']);
  });

  it('refuses to replace or delete a workflow that already uses the connection', async () => {
    const stripped = {
      id: 'wf-1',
      pipelines: [{ id: 'main', pipes: [{ id: 'h', type: 'source.http', config: {} }] }],
    };
    const { server, calls } = await serve(all, { foreignConnections: ['conn-a'], respond: engineWith(usesForeign) });
    const saved = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: stripped });
    expect(saved.statusCode).toBe(403);
    const deleted = await server.inject({ method: 'DELETE', url: '/api/workflow/engine/workflows/wf-1' });
    expect(deleted.statusCode).toBe(403);
    expect(calls.every((call) => call.init.method === 'GET')).toBe(true);
  });

  it('deletes a workflow the caller may use', async () => {
    const { server, calls } = await serve(all, { respond: engineWith(usesForeign) });
    const res = await server.inject({ method: 'DELETE', url: '/api/workflow/engine/workflows/wf-1' });
    expect(res.statusCode).toBe(200);
    expect(calls.filter((call) => call.init.method !== 'GET').map((call) => call.init.method)).toEqual(['DELETE']);
  });

  it('lets a member of the connection’s workspace through', async () => {
    const { server, calls } = await serve(all, { respond: engineWith(usesForeign) });
    const saved = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: usesForeign });
    expect(saved.statusCode).toBe(200);
    const ran = await server.inject({ method: 'POST', url: '/api/workflow/engine/workflows/wf-1/run' });
    expect(ran.statusCode).toBe(200);
    expect(calls.filter((call) => call.init.method !== 'GET').map((call) => call.init.method)).toEqual(['PUT', 'POST']);
  });

  it('checks nothing for a workflow that uses no saved connection', async () => {
    const { server } = await serve(all, { foreignConnections: ['conn-a'] });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/workflow/engine/workflows/wf-2',
      payload: { id: 'wf-2', pipelines: [{ id: 'main', pipes: [{ id: 'h', type: 'source.http', credentialId: 'api-key-1' }] }] },
    });
    expect(res.statusCode).toBe(200);
  });
});
