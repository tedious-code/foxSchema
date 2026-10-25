/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The designer's preview exists to show what a run will read. Both now read
 * through the same row reader; these read one file both ways and compare.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipeContext, RecordBatch } from '../../registry/index.js';
import { CsvSourcePipe, parseCsvRecords } from './csv.js';
import { parseTextRows } from './delimited.js';
import { FILES_DIR_ENV } from './file-root.js';
import { TextSourcePipe, textConfigFields } from './text.js';

let root = '';
let previous: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fox-preview-run-'));
  previous = process.env[FILES_DIR_ENV];
  process.env[FILES_DIR_ENV] = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env[FILES_DIR_ENV];
  else process.env[FILES_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
});

async function runRecords(pipe: { read(context: PipeContext): AsyncIterable<RecordBatch> }, config: Record<string, unknown>) {
  const records: Record<string, unknown>[] = [];
  const context = { pipe: { id: 'src', config } } as unknown as PipeContext;
  for await (const batch of pipe.read(context)) if (!batch.port) records.push(...batch.records);
  return records;
}

describe('preview and run read the same rows', () => {
  it('for text: offset, header, empty lines, a flat map and typed columns', async () => {
    const text = 'exported yesterday\nname|qty\n\nada|2::grace|3\r\nlinus|x\n';
    await writeFile(join(root, 'in.txt'), text);
    const config = {
      path: 'in.txt',
      offset: 1,
      header: 'auto',
      delimiters: ['|'],
      recordDelimiter: '::',
      fields: ['name', 'qty'],
      rules: [{ name: 'qty', type: 'integer' }],
      onInvalid: 'skip',
    };
    // The preview parses with the source's own schema and defaults.
    const preview = parseTextRows(text, textConfigFields.parse(config));
    const valid = preview.records.filter((_, index) => !preview.invalid.some((failure) => failure.index === index));
    expect(await runRecords(new TextSourcePipe(), config)).toEqual(valid);
    expect(valid).toEqual([
      { name: 'ada', qty: 2 },
      { name: 'grace', qty: 3 },
    ]);
  });

  it('for CSV: a preamble, and quoted fields that span lines', async () => {
    const text = 'exported yesterday\nid,note\n1,"two\nlines"\n2,"three\nmore\nlines"\n3,plain\n';
    await writeFile(join(root, 'in.csv'), text);
    const config = { path: 'in.csv', skipLines: 1 };
    const preview = await parseCsvRecords(text, { skipLines: 1 });
    expect(await runRecords(new CsvSourcePipe(), config)).toEqual(preview.records);
    expect(preview.records.map((record) => record.note)).toEqual(['two\nlines', 'three\nmore\nlines', 'plain']);
  });
});
