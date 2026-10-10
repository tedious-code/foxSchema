/**
 * Flat-file import → temp SQLite workspace and/or saved credential (any dialect).
 */
import { scopeOf, type WorkspaceScope } from '../../platform/http/scope';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../auth/auth.routes';
import { denyUnless, requirePermissions } from '../authorization/rbac.guard';
import { capacityMessage, importCapacity } from '../import-process/import-capacity';
import {
  detectDelimitedColumns,
  detectFixedWidthColumns,
  MAX_DETECT_CHARS,
  MAX_DETECT_LINES,
} from '../import-process/text-columns';
import { rateLimit } from '../../platform/guards/rate-limit';
import { ConnectionStore } from '../connections/connection-store.service';
import {
  appendFileToSqliteWorkspace,
  isFileQueryConnectionName,
  isFileQueryDbPath,
  materializeFileToSqlite,
  MAX_CONTENT_CHARS,
  parseFileToTable,
  pruneOrphanFileQueryConnections,
  removeFileQueryDb,
  type FileQueryFormat,
  type FileQueryImportInput,
  type TextOffsetColumn,
} from './file-query.service';
import { bulkLoadIntoConnection } from './file-query-bulk.service';
import { cpuPool } from '../import-process/worker-pool';
import {
  abortUploadSession,
  appendUploadChunk,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  MAX_UPLOAD_BYTES,
  sessionToImportInput,
  uploadLimitBytes,
} from '../files/file-session.service';
import { sendError, sendThrown } from '../../platform/http/respond';
import { quoteSqlIdentifier } from '@foxschema/sql';

const nodeRequire = createRequire(import.meta.url);
const importLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

function asFormat(v: unknown): FileQueryFormat | null {
  return v === 'csv' || v === 'json' || v === 'text' ? v : null;
}

function listTablesInSqliteFile(dbPath: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dbPath has already passed isFileQueryDbPath containment
  if (!dbPath || !existsSync(dbPath)) return [];
  try {
    const Database = nodeRequire('better-sqlite3');
    const Db = (Database.default ?? Database) as new (
      path: string,
      opts?: { readonly?: boolean; fileMustExist?: boolean }
    ) => {
      prepare: (sql: string) => { all: () => { name: string }[] };
      close: () => void;
    };
    const db = new Db(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all();
      return rows.map((r) => r.name);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function listFileImportConnections(connectionStore: ConnectionStore, scope: WorkspaceScope) {
  await pruneOrphanFileQueryConnections(connectionStore, scope).catch(() => undefined);
  const list = await connectionStore.list(scope);
  const out: {
    id: string;
    name: string;
    database?: string;
    createdAt: string;
    tables: string[];
  }[] = [];
  for (const c of list) {
    if (c.dialect !== 'sqlite') continue;
    if (!isFileQueryConnectionName(c.name) && !isFileQueryDbPath(c.database)) continue;
    const resolved = await connectionStore.resolve(scope, c.id);
    const dbPath = resolved?.option.connectionString || resolved?.option.database || c.database;
    out.push({
      id: c.id,
      name: c.name,
      database: dbPath,
      createdAt: c.createdAt,
      tables: dbPath ? listTablesInSqliteFile(dbPath) : [],
    });
  }
  return out;
}

async function clearPreviousFileImports(
  connectionStore: ConnectionStore,
  scope: WorkspaceScope,
  keepId?: string
): Promise<{ removedConnectionIds: string[]; removedFiles: number }> {
  const list = await connectionStore.list(scope);
  const removedConnectionIds: string[] = [];
  let removedFiles = 0;
  for (const c of list) {
    if (keepId && c.id === keepId) continue;
    if (c.dialect !== 'sqlite') continue;
    if (!isFileQueryConnectionName(c.name) && !isFileQueryDbPath(c.database)) continue;
    const resolved = await connectionStore.resolve(scope, c.id);
    const dbPath = resolved?.option.connectionString || resolved?.option.database || c.database;
    const ok = await connectionStore.remove(scope, c.id);
    if (ok) {
      removedConnectionIds.push(c.id);
      if (dbPath && removeFileQueryDb(dbPath)) removedFiles++;
    }
  }
  return { removedConnectionIds, removedFiles };
}

function parseImportBody(body: Record<string, unknown>): {
  input: FileQueryImportInput;
  replacePrevious: boolean;
  targetConnectionId?: string;
  workspaceConnectionId?: string;
  workspaceName?: string;
  replaceTable: boolean;
} {
  const format = asFormat(body.format);
  if (!format) throw new Error('format must be csv, json, or text');
  let content = typeof body.content === 'string' ? body.content : '';
  if (!content && typeof body.contentBase64 === 'string') {
    content = Buffer.from(body.contentBase64, 'base64').toString('utf8');
  }
  if (!content) throw new Error('content (or contentBase64) is required');

  const text = body.text as FileQueryImportInput['text'] | undefined;
  return {
    input: {
      format,
      fileName: String(body.fileName || 'data').slice(0, 240),
      content,
      tableName: body.tableName ? String(body.tableName) : undefined,
      csv: body.csv as FileQueryImportInput['csv'],
      json: body.json as FileQueryImportInput['json'],
      text: text
        ? {
            skipLines: text.skipLines,
            columns: (text.columns || []) as TextOffsetColumn[],
          }
        : undefined,
    },
    replacePrevious: body.replacePrevious === true,
    targetConnectionId: body.targetConnectionId
      ? String(body.targetConnectionId)
      : undefined,
    workspaceConnectionId: body.workspaceConnectionId
      ? String(body.workspaceConnectionId)
      : undefined,
    workspaceName: body.workspaceName ? String(body.workspaceName).slice(0, 120) : undefined,
    replaceTable: body.replaceTable === true,
  };
}

async function resolveWorkspaceDbPath(
  connectionStore: ConnectionStore,
  scope: WorkspaceScope,
  workspaceConnectionId: string
): Promise<{ connectionId: string; dbPath: string; name: string }> {
  const resolved = await connectionStore.resolve(scope, workspaceConnectionId);
  if (!resolved || resolved.dialect !== 'sqlite') {
    throw new Error('Workspace connection not found');
  }
  const dbPath = resolved.option.connectionString || resolved.option.database;
  if (!dbPath || !isFileQueryDbPath(dbPath)) {
    throw new Error('Not a Query-files workspace');
  }
  const list = await connectionStore.list(scope);
  const meta = list.find((c) => c.id === workspaceConnectionId);
  return {
    connectionId: workspaceConnectionId,
    dbPath,
    name: meta?.name || 'Files: workspace',
  };
}

export function createFileQueryRoutes(connectionStore: ConnectionStore): Router {
  const router = Router();

  router.get(
    '/imports',
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const imports = await listFileImportConnections(connectionStore, scope);
        res.send({ imports });
      } catch (error: unknown) {
        sendThrown(res, error, 'List failed');
      }
    }
  );

  /**
   * GET /api/files/capacity
   * What this server can actually take, so the UI can warn before a long
   * upload rather than after. Measured from live heap, not a constant.
   */
  router.get('/capacity', requirePermissions('editor.access'), (_req: AppRequest, res: FastifyReply) => {
    const cap = importCapacity();
    res.send({
      maxBytes: uploadLimitBytes(),
      limitedBy: cap.limitedBy,
      heapLimitBytes: cap.heapLimitBytes,
      message: capacityMessage(cap),
    });
  });

  /**
   * POST /api/files/detect-columns
   * Fill in the text-offset form from a sample instead of making the user
   * count characters. Pure analysis — reads nothing, writes nothing.
   */
  router.post(
    '/detect-columns',
    requirePermissions('editor.access'),
    (req: AppRequest, res: FastifyReply) => {
      const body = req.body as {
        sample?: unknown;
        mode?: unknown;
        delimiters?: unknown;
        skipLines?: unknown;
        minGap?: unknown;
        collapse?: unknown;
        useHeader?: unknown;
      };
      if (typeof body.sample !== 'string' || !body.sample.trim()) {
        sendError(res, 'invalid_input', 'sample must be a non-empty string.');
        return;
      }
      // Bound the work: detection only needs a few hundred lines, and the
      // endpoint should not become a way to spend server CPU on a huge paste.
      if (body.sample.length > MAX_DETECT_CHARS) {
        sendError(res, 'invalid_input', `sample must be under ${MAX_DETECT_CHARS} characters — send the first few hundred lines.`);
        return;
      }
      const skip = Math.max(0, Math.min(1000, Number(body.skipLines) || 0));
      const all = body.sample.replace(/\r/g, '').split('\n');
      const useHeader = body.useHeader === true;
      // The header is the last line skipped, which is where it sits in a report.
      const headerLine = useHeader && skip > 0 ? all[skip - 1] : undefined;
      const sampleLines = all.slice(skip, skip + MAX_DETECT_LINES);

      try {
        const columns =
          body.mode === 'delimited'
            ? detectDelimitedColumns(
                sampleLines,
                Array.isArray(body.delimiters)
                  ? body.delimiters.filter((d): d is string => typeof d === 'string')
                  : ['|'],
                { collapse: body.collapse === true, headerLine }
              )
            : detectFixedWidthColumns(sampleLines, {
                minGap: Number(body.minGap) || 1,
                headerLine,
              });
        res.send({ columns, sampledLines: sampleLines.length });
      } catch (error: unknown) {
        sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Detection failed');
      }
    }
  );

  /**
   * POST /api/files/import
   * Small paste / JSON body import.
   * - default: new temp SQLite Files credential
   * - workspaceConnectionId: add table to existing Files DB
   * - targetConnectionId: bulk-load into a saved credential (any dialect)
   */
  router.post(
    '/import',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const parsed = parseImportBody(req.body as Record<string, unknown>);
        // Credential bulk-load runs DROP/CREATE/INSERT — same bar as /sql/execute writes.
        if (parsed.targetConnectionId && denyUnless(req as AuthedRequest, res, 'editor.write')) {
          return;
        }
        const result = await runImport(connectionStore, scope, parsed);
        res.send(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Import failed';
        sendError(res, 'invalid_input', message);
      }
    }
  );

  /** Start a disk-backed chunked upload (large files). */
  router.post(
    '/sessions',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const body = req.body as Record<string, unknown>;
        const format = asFormat(body.format);
        if (!format) {
          sendError(res, 'invalid_input', 'format must be csv, json, or text');
          return;
        }
        const targetConnectionId = body.targetConnectionId
          ? String(body.targetConnectionId)
          : undefined;
        if (targetConnectionId && denyUnless(req as AuthedRequest, res, 'editor.write')) {
          return;
        }
        const session = createUploadSession(userId, {
          format,
          fileName: String(body.fileName || 'data').slice(0, 240),
          tableName: body.tableName ? String(body.tableName) : undefined,
          csv: body.csv as FileUploadCsv,
          json: body.json as FileUploadJson,
          text: body.text as FileUploadText,
          targetConnectionId,
          workspaceConnectionId: body.workspaceConnectionId
            ? String(body.workspaceConnectionId)
            : undefined,
          workspaceName: body.workspaceName
            ? String(body.workspaceName).slice(0, 120)
            : undefined,
          replaceTable: body.replaceTable === true,
        });
        res.send({
          ok: true,
          sessionId: session.id,
          maxBytes: MAX_UPLOAD_BYTES,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Session create failed';
        sendError(res, 'invalid_input', message);
      }
    }
  );

  /** Append a UTF-8 or base64 chunk to an upload session. */
  router.put(
    '/sessions/:id/chunk',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const id = String(req.params.id || '');
        const body = req.body as { data?: string; encoding?: 'utf8' | 'base64' };
        if (typeof body.data !== 'string' || !body.data) {
          sendError(res, 'invalid_input', 'data is required');
          return;
        }
        const buf =
          body.encoding === 'base64'
            ? Buffer.from(body.data, 'base64')
            : Buffer.from(body.data, 'utf8');
        const session = appendUploadChunk(userId, id, buf);
        res.send({ ok: true, bytes: session.bytes, maxBytes: MAX_UPLOAD_BYTES });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Chunk failed';
        sendError(res, 'invalid_input', message);
      }
    }
  );

  /** Finalize chunked upload → same import pipeline as POST /import. */
  router.post(
    '/sessions/:id/commit',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const id = String(req.params.id || '');
        const session = getUploadSession(userId, id);
        if (!session) {
          sendError(res, 'not_found', 'Upload session not found or expired');
          return;
        }
        // Re-check at commit: session may have been created before a role change.
        if (
          session.targetConnectionId &&
          denyUnless(req as AuthedRequest, res, 'editor.write')
        ) {
          return;
        }
        const input = sessionToImportInput(userId, id);
        const body = (req.body || {}) as Record<string, unknown>;
        const result = await runImport(connectionStore, scope, {
          input,
          replacePrevious: body.replacePrevious === true,
          targetConnectionId: session.targetConnectionId,
          workspaceConnectionId: session.workspaceConnectionId,
          workspaceName: session.workspaceName,
          replaceTable: session.replaceTable === true,
          maxChars: MAX_UPLOAD_BYTES,
        });
        completeUploadSession(userId, id);
        res.send(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Commit failed';
        sendError(res, 'invalid_input', message);
      }
    }
  );

  router.delete(
    '/sessions/:id',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      const userId = (req as AuthedRequest).userId!;
      const scope = scopeOf(req as AuthedRequest)!;
      const ok = abortUploadSession(userId, String(req.params.id || ''));
      res.send({ ok });
    }
  );

  router.delete(
    '/imports/:id',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const id = String(req.params.id || '');
        const resolved = await connectionStore.resolve(scope, id);
        if (!resolved || resolved.dialect !== 'sqlite') {
          sendError(res, 'not_found', 'File import not found');
          return;
        }
        const dbPath = resolved.option.connectionString || resolved.option.database;
        const list = await connectionStore.list(scope);
        const meta = list.find((c) => c.id === id);
        if (!isFileQueryConnectionName(meta?.name) && !isFileQueryDbPath(dbPath)) {
          sendError(res, 'invalid_input', 'Not a Query-files import');
          return;
        }
        const ok = await connectionStore.remove(scope, id);
        if (!ok) {
          sendError(res, 'not_found', 'File import not found');
          return;
        }
        const removedFile = dbPath ? removeFileQueryDb(dbPath) : false;
        res.send({ ok: true, removedConnectionIds: [id], removedFiles: removedFile ? 1 : 0 });
      } catch (error: unknown) {
        sendThrown(res, error, 'Delete failed');
      }
    }
  );

  router.delete(
    '/imports',
    importLimiter,
    requirePermissions('editor.access'),
    async (req: AppRequest, res: FastifyReply) => {
      try {
        const userId = (req as AuthedRequest).userId!;
        const scope = scopeOf(req as AuthedRequest)!;
        const cleared = await clearPreviousFileImports(connectionStore, scope);
        res.send({
          ok: true,
          removedConnectionIds: cleared.removedConnectionIds,
          removedFiles: cleared.removedFiles,
        });
      } catch (error: unknown) {
        sendThrown(res, error, 'Clear failed');
      }
    }
  );

  return router;
}

type FileUploadCsv = FileQueryImportInput['csv'];
type FileUploadJson = FileQueryImportInput['json'];
type FileUploadText = FileQueryImportInput['text'];


/**
 * Parse an upload without freezing the server.
 *
 * Measured: a 22MB CSV blocks the event loop for 784ms with zero ticks on the
 * main thread — every other request, including health checks, stalls for that
 * whole stretch. In a worker the same parse leaves the loop free.
 *
 * Small inputs stay on the main thread: below this size the structured-clone
 * round trip costs more than the parse it avoids.
 */
const WORKER_PARSE_MIN_CHARS = 512 * 1024;

async function parseUpload(
  input: FileQueryImportInput,
  maxChars: number
): Promise<ReturnType<typeof parseFileToTable>> {
  if ((input.content?.length ?? 0) < WORKER_PARSE_MIN_CHARS) {
    return parseFileToTable(input, { maxChars });
  }
  return cpuPool.run<{ input: FileQueryImportInput; maxChars: number }, ReturnType<typeof parseFileToTable>>({
    script: new URL('../import-process/parse-file.worker.ts', import.meta.url),
    input: { input, maxChars },
    timeoutMs: 120_000,
  }).promise;
}

async function runImport(
  connectionStore: ConnectionStore,
  scope: WorkspaceScope,
  parsed: {
    input: FileQueryImportInput;
    replacePrevious: boolean;
    targetConnectionId?: string;
    workspaceConnectionId?: string;
    workspaceName?: string;
    replaceTable: boolean;
    maxChars?: number;
  }
) {
  const maxChars = parsed.maxChars ?? MAX_CONTENT_CHARS;

  // --- Remote / saved credential target (dialect bulk) ---
  if (parsed.targetConnectionId) {
    const resolved = await connectionStore.resolve(scope, parsed.targetConnectionId);
    if (!resolved) throw new Error('Target credential not found');
    const table = await parseUpload(parsed.input, maxChars);
    const load = await bulkLoadIntoConnection({
      dialect: resolved.dialect,
      option: resolved.option,
      tableName: table.tableName,
      columns: table.columns,
      matrix: table.matrix,
      types: table.types,
      replaceTable: parsed.replaceTable,
    });
    const list = await connectionStore.list(scope);
    const connection = list.find((c) => c.id === parsed.targetConnectionId);
    return {
      ok: true,
      mode: 'credential' as const,
      connection,
      connectionId: parsed.targetConnectionId,
      tableName: table.tableName,
      rowCount: load.rowCount,
      columns: table.columns,
      chunks: load.chunks,
      dialect: resolved.dialect,
      // Quoted for the target engine and with no LIMIT: `/sql/execute` wraps a
      // SELECT in the dialect's own paging, as it does for data peek. This used
      // to be `SELECT * FROM "t" LIMIT 100` for every engine — a string literal
      // on MySQL/TiDB and a syntax error on SQL Server and Oracle (no LIMIT).
      sampleSql: `SELECT * FROM ${quoteSqlIdentifier(table.tableName, resolved.dialect)};`,
      replacedPrevious: false,
      removedConnectionIds: [] as string[],
      removedFiles: 0,
    };
  }

  // --- Append to existing Files workspace ---
  if (parsed.workspaceConnectionId) {
    const ws = await resolveWorkspaceDbPath(
      connectionStore,
      scope,
      parsed.workspaceConnectionId
    );
    // Parsed off the event loop when it is big enough to matter; the SQLite
    // write itself is fast and stays here.
    const appended = appendFileToSqliteWorkspace(ws.dbPath, parsed.input, {
      maxChars,
      replaceTable: parsed.replaceTable,
      parsed: await parseUpload(parsed.input, maxChars),
    });
    const list = await connectionStore.list(scope);
    const connection = list.find((c) => c.id === ws.connectionId);
    return {
      ok: true,
      mode: 'workspace' as const,
      connection,
      connectionId: ws.connectionId,
      tableName: appended.tableName,
      rowCount: appended.rowCount,
      columns: appended.columns,
      sampleSql: `SELECT * FROM ${quoteSqlIdentifier(appended.tableName, 'sqlite')} LIMIT 100;`,
      replacedPrevious: false,
      removedConnectionIds: [] as string[],
      removedFiles: 0,
    };
  }

  // --- New temp SQLite workspace ---
  const workspaceLabel =
    parsed.workspaceName?.trim() ||
    (parsed.input.fileName || parsed.input.tableName || 'workspace')
      .split(/[/\\]/)
      .pop() ||
    'workspace';
  const result = materializeFileToSqlite(parsed.input, {
    maxChars,
    connectionName: `Files: ${workspaceLabel}`,
    parsed: await parseUpload(parsed.input, maxChars),
  });
  const connection = await connectionStore.create(scope, {
    name: result.connectionName,
    dialect: 'sqlite',
    schema: '',
    option: {
      database: result.dbPath,
      connectionString: result.dbPath,
      password: 'file-query',
    },
    savePassword: true,
  });

  const cleared = parsed.replacePrevious
    ? await clearPreviousFileImports(connectionStore, scope, connection.id)
    : { removedConnectionIds: [] as string[], removedFiles: 0 };

  return {
    ok: true,
    mode: 'workspace' as const,
    connection,
    connectionId: connection.id,
    tableName: result.tableName,
    rowCount: result.rowCount,
    columns: result.columns,
    dbPath: result.dbPath,
    sampleSql: `SELECT * FROM ${quoteSqlIdentifier(result.tableName, 'sqlite')} LIMIT 100;`,
    replacedPrevious: parsed.replacePrevious,
    removedConnectionIds: cleared.removedConnectionIds,
    removedFiles: cleared.removedFiles,
  };
}
