/**
 * Disk-backed chunked upload sessions for large Query-files imports.
 * Chunks append to a temp file; commit parses + bulk-loads.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capacityMessage, importCapacity } from './import-capacity';
import {
  fileQueryTempDir,
  type FileQueryFormat,
  type FileQueryImportInput,
  type TextOffsetColumn,
} from './file-query.service';

export type FileUploadSession = {
  id: string;
  userId: string;
  format: FileQueryFormat;
  fileName: string;
  tableName?: string;
  csv?: { delimiter?: string; hasHeader?: boolean };
  json?: { mode?: 'array' | 'ndjson' };
  text?: { skipLines?: number; columns: TextOffsetColumn[] };
  /** Import into an existing saved credential (any dialect). */
  targetConnectionId?: string;
  /** Append a table to an existing Files: SQLite workspace. */
  workspaceConnectionId?: string;
  workspaceName?: string;
  replaceTable?: boolean;
  uploadPath: string;
  bytes: number;
  createdAt: number;
};

const SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Ceiling on the assembled upload, whatever the host reports.
 *
 * The disk write would happily take more, but commit reads the whole file into
 * one string and parses it into a row matrix, so the real limit is memory —
 * see import-capacity.ts for the two measured ceilings.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * What this process will actually accept right now: the lower of the static
 * cap and what the live heap can survive parsing. A 512 MB container and a
 * 16 GB workstation get different, honest answers instead of one constant that
 * is too strict on one and a crash on the other.
 */
export function uploadLimitBytes(): number {
  return Math.min(MAX_UPLOAD_BYTES, importCapacity().maxBytes);
}

const sessions = new Map<string, FileUploadSession>();

function uploadsDir(): string {
  const dir = join(fileQueryTempDir(), 'uploads');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupStaleUploadSessions(now = Date.now()): number {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
        unlinkSync(s.uploadPath);
      } catch {
        /* ignore */
      }
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Delete `.part` files on disk that no live session owns.
 *
 * `sessions` is in-memory, so a restart forgets every in-flight upload while
 * its partial file (up to MAX_UPLOAD_BYTES) stays on disk. Nothing could ever
 * remove those again: the TTL sweep above only walks the map, and the map no
 * longer has the entry. They accumulate for the life of the machine — invisible,
 * because the only record of them was the process that died.
 *
 * Run at startup, which is exactly when the orphans exist and no upload is in
 * flight. `keepMs` still guards the case where a second process is mid-upload
 * against the same temp dir.
 */
export function sweepOrphanedUploadFiles(opts: { keepMs?: number; now?: number } = {}): number {
  const keepMs = opts.keepMs ?? SESSION_TTL_MS;
  const now = opts.now ?? Date.now();
  const live = new Set([...sessions.values()].map((s) => s.uploadPath));
  const dir = uploadsDir();
  let removed = 0;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.part')) continue;
    const full = join(dir, name);
    if (live.has(full)) continue;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
      if (now - statSync(full).mtimeMs <= keepMs) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
      unlinkSync(full);
      removed++;
    } catch {
      /* raced with another sweep, or not ours to delete */
    }
  }
  return removed;
}

export function createUploadSession(
  userId: string,
  meta: {
    format: FileQueryFormat;
    fileName: string;
    tableName?: string;
    csv?: FileUploadSession['csv'];
    json?: FileUploadSession['json'];
    text?: FileUploadSession['text'];
    targetConnectionId?: string;
    workspaceConnectionId?: string;
    workspaceName?: string;
    replaceTable?: boolean;
  }
): FileUploadSession {
  cleanupStaleUploadSessions();
  const id = randomUUID();
  const uploadPath = join(uploadsDir(), `${id}.part`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
  writeFileSync(uploadPath, '');
  const session: FileUploadSession = {
    id,
    userId,
    format: meta.format,
    fileName: meta.fileName,
    tableName: meta.tableName,
    csv: meta.csv,
    json: meta.json,
    text: meta.text,
    targetConnectionId: meta.targetConnectionId,
    workspaceConnectionId: meta.workspaceConnectionId,
    workspaceName: meta.workspaceName,
    replaceTable: meta.replaceTable,
    uploadPath,
    bytes: 0,
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getUploadSession(userId: string, id: string): FileUploadSession | null {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    abortUploadSession(userId, id);
    return null;
  }
  return s;
}

export function appendUploadChunk(userId: string, id: string, chunk: Buffer | string): FileUploadSession {
  const s = getUploadSession(userId, id);
  if (!s) throw new Error('Upload session not found or expired');
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  const limit = uploadLimitBytes();
  if (s.bytes + buf.length > limit) {
    // Fail on the chunk that crosses the line, not after the whole upload:
    // the client can stop immediately, and the message names the real ceiling
    // for this host rather than a constant that may not apply to it.
    throw new Error(
      `Upload too large (max ${Math.round(limit / 1024 / 1024)} MB). ${capacityMessage()}`
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
  appendFileSync(s.uploadPath, buf);
  s.bytes += buf.length;
  return s;
}

export function readUploadSessionContent(userId: string, id: string): string {
  const s = getUploadSession(userId, id);
  if (!s) throw new Error('Upload session not found or expired');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
  if (!existsSync(s.uploadPath)) throw new Error('Upload data missing');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
  return readFileSync(s.uploadPath, 'utf8');
}

export function sessionToImportInput(userId: string, id: string): FileQueryImportInput {
  const s = getUploadSession(userId, id);
  if (!s) throw new Error('Upload session not found or expired');
  return {
    format: s.format,
    fileName: s.fileName,
    content: readUploadSessionContent(userId, id),
    tableName: s.tableName,
    csv: s.csv,
    json: s.json,
    text: s.text,
  };
}

export function abortUploadSession(userId: string, id: string): boolean {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) return false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
    unlinkSync(s.uploadPath);
  } catch {
    /* ignore */
  }
  sessions.delete(id);
  return true;
}

export function completeUploadSession(userId: string, id: string): FileUploadSession | null {
  const s = getUploadSession(userId, id);
  if (!s) return null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload files are randomUUID() names inside uploadsDir() — the caller names the upload, never the path on disk
    unlinkSync(s.uploadPath);
  } catch {
    /* ignore */
  }
  sessions.delete(id);
  return s;
}
