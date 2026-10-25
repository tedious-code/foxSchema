/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one way a file pipe touches the filesystem.
 *
 * Designing a workflow is an editor-level permission, and a file source or
 * sink names its path in config. Each pipe used to resolve that path inside
 * the files root itself and then call `node:fs` — so the rule that keeps an
 * editor from reading `/etc/passwd` or appending to `authorized_keys` held
 * only while every new file pipe remembered one call, and forgetting it
 * failed open. Here the path is resolved once, inside the root, and the
 * handle that comes back is the only thing that can read or write it. A test
 * (`pipes-fs-boundary.test.ts`) fails the build when anything else under
 * `pipes/` imports `node:fs`.
 */
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkflowFile } from './file-root.js';

/** A configured file, resolved inside the workflow files root. */
export interface WorkflowFile {
  /** The resolved absolute path — for keys and messages, not for `node:fs`. */
  readonly path: string;
  /** The file as a UTF-8 text stream. */
  readStream(): NodeJS.ReadableStream;
  /** The whole file as text. */
  readText(): Promise<string>;
  /**
   * The first `bytes` bytes as text. `truncated` when the file is longer;
   * with `wholeLines`, the last (possibly partial) line is then dropped.
   */
  readHead(bytes: number, options?: { wholeLines?: boolean }): Promise<{ text: string; truncated: boolean }>;
  /** Replace the file's content, creating its folder if needed. */
  write(text: string): Promise<void>;
  /** Add to the end of the file, creating it and its folder if needed. */
  append(text: string): Promise<void>;
  /** True when the file does not exist yet or has no bytes. */
  isEmpty(): Promise<boolean>;
}

/** Resolve `configuredPath` inside the files root (or `root`) and hand back its file. */
export async function openWorkflowFile(configuredPath: string, root?: string): Promise<WorkflowFile> {
  const path = await resolveWorkflowFile(configuredPath, root);
  // Every operation below takes `path` as resolved above, inside the root.
  /* eslint-disable security/detect-non-literal-fs-filename -- confined by resolveWorkflowFile, above */
  return {
    path,
    readStream: () => createReadStream(path, { encoding: 'utf8' }),
    readText: () => readFile(path, 'utf8'),
    async readHead(bytes, options = {}) {
      const handle = await open(path, 'r');
      try {
        const { size } = await handle.stat();
        const buffer = Buffer.alloc(Math.min(size, bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        let text = buffer.toString('utf8', 0, bytesRead);
        const truncated = size > bytes;
        if (truncated && options.wholeLines) {
          const lastNewline = text.lastIndexOf('\n');
          if (lastNewline !== -1) text = text.slice(0, lastNewline);
        }
        return { text, truncated };
      } finally {
        await handle.close();
      }
    },
    async write(text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    async append(text) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text, 'utf8');
    },
    async isEmpty() {
      try {
        return (await stat(path)).size === 0;
      } catch {
        return true; // does not exist yet
      }
    },
  };
  /* eslint-enable security/detect-non-literal-fs-filename */
}
