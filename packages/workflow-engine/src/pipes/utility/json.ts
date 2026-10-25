/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/json.ts).
 */
import * as z from 'zod';
import type {
  PipeContext,
  RecordBatch,
  SourcePipe,
} from '../../registry/index.js';
import {
  REJECTS_PORT,
  batchSizeField,
  definePipeMetadata,
  recordContractFields,
  rejectPolicyField,
  type PipeMetadata,
} from '../../sdk/index.js';
import { BatchEmitter } from './delimited.js';
import { readLines } from './text.js';
import { openWorkflowFile, type WorkflowFile } from './workflow-files.js';

const configSchema = z.object({
  path: z.string().min(1),
  // `array` parses one JSON array; `ndjson` streams one JSON value per line;
  // `auto` peeks at the first byte (`[` → array, else ndjson).
  format: z.enum(['auto', 'array', 'ndjson']).default('auto'),
  ...batchSizeField(),
  ...recordContractFields,
  ...rejectPolicyField,
});

type Config = z.infer<typeof configSchema>;

/**
 * JSON file source: a JSON array (loaded whole — bounded by file size) or
 * NDJSON (streamed line by line). Scalars and arrays become `{value: …}` so
 * the stream stays a stream of records. A malformed NDJSON line is treated
 * exactly like a schema-invalid record: fail, skip, or dead-letter by
 * `onInvalid` — a bad line and a bad row are the same problem to a pipeline.
 */
export class JsonSourcePipe implements SourcePipe {
  readonly type = 'source.file.json';
  readonly role = 'source';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'JSON file',
      category: 'Source/File',
      family: 'file',
      version: '0.1.0',
      role: 'source',
      inputs: [],
      outputs: [
        { name: 'out', type: 'records' },
        { name: REJECTS_PORT, type: 'records' },
      ],
      configSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    configSchema.parse(config);
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    const config = configSchema.parse(context.pipe.config);
    const file = await openWorkflowFile(config.path);
    const format =
      config.format === 'auto' ? await detectFormat(file) : config.format;
    yield* format === 'array'
      ? this.readArray(context, config, file)
      : this.readNdjson(context, config, file);
  }

  private async *readArray(
    context: PipeContext,
    config: Config,
    file: WorkflowFile,
  ): AsyncIterable<RecordBatch> {
    const parsed: unknown = JSON.parse(await file.readText());
    if (!Array.isArray(parsed)) {
      throw new Error(`${file.path}: expected a top-level JSON array`);
    }
    const resumeAfter = Number(context.checkpoint?.cursor.index ?? 0);
    const emitter = new BatchEmitter(context.pipe.id, config, {
      cursorKey: 'index',
      positionKey: '_index',
      label: 'index',
      cut: 'record',
    });
    for (let i = 0; i < parsed.length; i++) {
      const position = i + 1; // 1-based, matching row/line cursors
      if (position <= resumeAfter) continue;
      emitter.add(toRecord(parsed[i]), position);
    }
    yield* emitter.flush(parsed.length);
  }

  private async *readNdjson(
    context: PipeContext,
    config: Config,
    file: WorkflowFile,
  ): AsyncIterable<RecordBatch> {
    const resumeAfter = Number(context.checkpoint?.cursor.line ?? 0);
    const emitter = new BatchEmitter(context.pipe.id, config, {
      cursorKey: 'line',
      positionKey: '_line',
      label: 'line',
      cut: 'record',
    });
    let lineNumber = 0;
    for await (const line of readLines(file.readStream())) {
      lineNumber++;
      if (lineNumber <= resumeAfter) continue;
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        emitter.add({ _raw: line }, lineNumber, { reason: 'to parse', message: (error as Error).message });
        yield* emitter.drain();
        continue;
      }
      emitter.add(toRecord(value), lineNumber);
      yield* emitter.drain();
    }
    yield* emitter.flush(lineNumber);
  }
}

/** Objects pass through; scalars/arrays/null wrap as `{value}`. */
function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value: value ?? null };
}

async function detectFormat(file: WorkflowFile): Promise<'array' | 'ndjson'> {
  const head = (await file.readHead(1024)).text.replace(/^\uFEFF/, '');
  return head.trimStart().startsWith('[') ? 'array' : 'ndjson';
}
