/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/preview.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext } from './context.js';

function api() {
  return buildApp(
    createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) }),
  );
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function parse(payload: Record<string, unknown>) {
  const app = api();
  const res = await app.inject({
    method: 'POST',
    url: '/api/preview/parse',
    payload,
  });
  expect(res.statusCode, res.body).toBe(200);
  await app.close();
  return res.json() as {
    fields: string[];
    records: Record<string, unknown>[];
    lines: number[];
    invalid: { index: number; line?: number; message: string }[];
    total: number;
    truncated: boolean;
    error: string | null;
  };
}

describe('POST /api/preview/parse', () => {
  // The preview exists to show what a run would do, so it parses the pipes'
  // own config schemas with `path` relaxed. These two pin that relationship:
  // a config the pipe accepts must preview, and a config the pipe rejects must
  // not quietly preview as if it were fine.
  it('accepts a full pipe config, including run-only fields', async () => {
    const result = await parse({
      kind: 'text',
      sample: 'a|1\nb|2\n',
      config: {
        format: 'delimited',
        delimiters: ['|'],
        fields: ['name', 'value'],
        // Only meaningful at run time; the preview must not choke on them.
        batchSize: 500,
        onInvalid: 'reject',
        schemaSource: 'z.object({})',
      },
    });

    expect(result.error).toBeNull();
    expect(result.records).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('rejects a config the pipe would reject, with the same rule', async () => {
    // `fixed` with no columns fails the pipe's cross-field refine.
    const result = await parse({
      kind: 'text',
      sample: 'anything\n',
      config: { format: 'fixed', columns: [] },
    });

    expect(result.error).toContain('fixed format needs columns');
    expect(result.records).toEqual([]);
  });

  it('previews a CSV sample and flags the rows the schema rejects', async () => {
    const result = await parse({
      kind: 'csv',
      config: {
        skipLines: 1,
        schema: {
          type: 'object',
          properties: { email: { type: 'string', pattern: '^\\S+@\\S+$' } },
        },
      },
      sample:
        'exported yesterday\nid,email\n1,ada@example.com\n2,not-an-email\n',
    });
    expect(result.error).toBeNull();
    expect(result.fields).toEqual(['id', 'email']);
    expect(result.total).toBe(2);
    expect(result.lines).toEqual([3, 4]);
    expect(result.invalid).toEqual([
      { index: 1, line: 4, message: expect.stringMatching(/pattern/) },
    ]);
  });

  it('numbers CSV records by the line they start on, past a quoted field that spans lines', async () => {
    // preamble + header + index put the third record on line 5; it starts on 7.
    const result = await parse({
      kind: 'csv',
      config: { skipLines: 1 },
      sample: 'exported yesterday\nid,note\n1,"two\nlines"\n2,"three\nmore\nlines"\n3,plain\n',
    });
    expect(result.error).toBeNull();
    expect(result.records.map((record) => record.id)).toEqual(['1', '2', '3']);
    expect(result.lines).toEqual([3, 5, 8]);
  });

  it('previews multi-delimiter text with offset and flat map', async () => {
    const result = await parse({
      kind: 'text',
      config: {
        offset: 1,
        delimiters: [';', '::'],
        recordDelimiter: '|',
        fields: ['id', 'name'],
      },
      sample: 'HEADER\n1;ada|2::grace\n3;linus\n',
    });
    expect(result.error).toBeNull();
    expect(result.fields).toEqual(['id', 'name']);
    expect(result.records).toEqual([
      { id: '1', name: 'ada' },
      { id: '2', name: 'grace' },
      { id: '3', name: 'linus' },
    ]);
  });

  it('previews fixed-width text with header auto-detection', async () => {
    const columns = [
      { name: 'id', start: 1, length: 6 },
      { name: 'name', start: 7, length: 19 },
      { name: 'gender', start: 26, length: 1 },
      { name: 'birthdate', start: 27, length: 8 },
      { name: 'phone', start: 35, length: 10 },
      { name: 'email', start: 45, length: 28 },
      { name: 'city', start: 73, length: 19 },
      { name: 'province', start: 92, length: 2 },
    ];
    const sample = [
      'ID    NAME               GBIRTHDATPHONE     EMAIL                       CITY               PR',
      '000001John Smith         M198810151234567890john@email.com              Toronto            ON',
      '000002Mary Johnson       F199203205678901234mary@gmail.com              Calgary            AB',
    ].join('\n');
    const result = await parse({
      kind: 'text',
      config: { format: 'fixed', columns, header: 'auto' },
      sample,
    });
    expect(result.error).toBeNull();
    expect(result.fields).toEqual([
      'id', 'name', 'gender', 'birthdate', 'phone', 'email', 'city', 'province',
    ]);
    // The header line was detected and dropped; padding trimmed.
    expect(result.records).toEqual([
      {
        id: '000001', name: 'John Smith', gender: 'M', birthdate: '19881015',
        phone: '1234567890', email: 'john@email.com', city: 'Toronto', province: 'ON',
      },
      {
        id: '000002', name: 'Mary Johnson', gender: 'F', birthdate: '19920320',
        phone: '5678901234', email: 'mary@gmail.com', city: 'Calgary', province: 'AB',
      },
    ]);
  });

  it('reports column type/regex failures and returns converted values', async () => {
    const result = await parse({
      kind: 'text',
      config: {
        format: 'fixed',
        columns: [
          { name: 'id', start: 1, length: 6, type: 'integer' },
          { name: 'name', start: 7, length: 19, required: true },
          { name: 'birthdate', start: 27, length: 8, type: 'date' },
          { name: 'email', start: 45, length: 28, pattern: '^\\S+@\\S+$' },
        ],
      },
      sample: [
        '000001John Smith         M198810151234567890john@email.com              Toronto            ON',
        'ABCDEFMary Johnson       F199203205678901234not-an-email                Calgary            AB',
      ].join('\n'),
    });
    expect(result.error).toBeNull();
    // Valid row comes back typed, not as strings.
    expect(result.records[0]).toEqual({
      id: 1,
      name: 'John Smith',
      birthdate: '1988-10-15',
      email: 'john@email.com',
    });
    expect(result.lines).toEqual([1, 2]);
    expect(result.invalid).toEqual([
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/id .*integer.*email .*match/),
      },
    ]);
  });

  it('ignores blank staged regex checks in preview config', async () => {
    const result = await parse({
      kind: 'text',
      config: {
        delimiters: [';'],
        fields: ['email'],
        rules: [
          {
            name: 'email',
            checks: [
              { kind: 'format', pattern: '' },
              { kind: 'format', pattern: '^\\S+@\\S+$' },
            ],
          },
        ],
      },
      sample: 'ada@example.com\nbad',
    });
    expect(result.error).toBeNull();
    expect(result.invalid).toEqual([
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/email format:/),
      },
    ]);
  });

  it('applies multi-regex column checks (null / length / format) on delimited text', async () => {
    const result = await parse({
      kind: 'text',
      config: {
        delimiters: [';'],
        fields: ['email'],
        rules: [
          {
            name: 'email',
            checks: [
              {
                kind: 'null',
                pattern: '^(?!(?:NULL|N/?A)$).+$',
                message: 'must not be a null token',
              },
              { kind: 'length', pattern: '^.{3,50}$' },
              { kind: 'format', pattern: '^\\S+@\\S+$' },
            ],
          },
        ],
      },
      sample: 'ada@example.com\nNULL\nx',
    });
    expect(result.error).toBeNull();
    expect(result.records[0]).toEqual({ email: 'ada@example.com' });
    expect(result.lines).toEqual([1, 2, 3]);
    expect(result.invalid).toEqual([
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/must not be a null token.*format:/),
      },
      {
        index: 2,
        line: 3,
        message: expect.stringMatching(/length:.*format:/),
      },
    ]);
  });

  it('reports shared source lines for flat-mapped failures after an offset', async () => {
    const result = await parse({
      kind: 'text',
      config: {
        offset: 1,
        delimiters: [';'],
        recordDelimiter: '|',
        fields: ['id', 'email'],
        rules: [
          { name: 'id', type: 'integer' },
          {
            name: 'email',
            checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }],
          },
        ],
      },
      sample: [
        'HEADER',
        '1;ada@example.com|x;nope|2;grace@example.com',
        '3;linus@example.com',
      ].join('\n'),
    });
    expect(result.error).toBeNull();
    expect(result.total).toBe(4);
    expect(result.lines).toEqual([2, 2, 2, 3]);
    expect(result.invalid).toEqual([
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/id .*integer; email format:/),
      },
    ]);
  });

  it('converts types in preview when multi-regex checks all pass', async () => {
    const result = await parse({
      kind: 'text',
      config: {
        delimiters: [';'],
        fields: ['id', 'active', 'score'],
        rules: [
          {
            name: 'id',
            type: 'integer',
            checks: [{ kind: 'length', pattern: '^.{3}$' }],
          },
          { name: 'active', type: 'boolean' },
          {
            name: 'score',
            type: 'number',
            checks: [{ kind: 'format', pattern: '^-?\\d+(\\.\\d+)?$' }],
          },
        ],
      },
      // Row 3 passes length but fails integer conversion; row 4 fails length.
      sample: '042;yes;3.5\n043;no;-1\n12a;yes;2\nab;yes;1',
    });
    expect(result.error).toBeNull();
    expect(result.records.slice(0, 2)).toEqual([
      { id: 42, active: true, score: 3.5 },
      { id: 43, active: false, score: -1 },
    ]);
    expect(result.invalid).toEqual([
      {
        index: 2,
        line: 3,
        message: expect.stringMatching(/id .*not an integer/),
      },
      {
        index: 3,
        line: 4,
        message: expect.stringMatching(/id length:/),
      },
    ]);
  });

  it('does not double-report a row that already failed column rules via schema', async () => {
    const config = {
      delimiters: [';'],
      fields: ['email'],
      rules: [
        {
          name: 'email',
          checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }],
        },
      ],
      schema: {
        type: 'object',
        properties: { email: { type: 'string', minLength: 20 } },
      },
    };
    // Row 1 passes column rules but fails schema minLength; row 2 fails
    // format first — schema must not add a second reason for that row.
    const result = await parse({
      kind: 'text',
      config,
      sample: 'ada@example.com\nbad',
    });
    expect(result.invalid).toEqual([
      {
        index: 0,
        line: 1,
        message: expect.stringMatching(/email/i),
      },
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/email format:/),
      },
    ]);
    expect(result.invalid[1]!.message).not.toMatch(/minLength|fewer than/i);

    const schemaOnly = await parse({
      kind: 'text',
      config,
      sample: 'ada@example.com',
    });
    expect(schemaOnly.invalid).toEqual([
      {
        index: 0,
        line: 1,
        message: expect.stringMatching(/email/i),
      },
    ]);
  });

  it('reads the head of the configured file when no sample is given', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foxflow-preview-'));
    cleanup.push(directory);
    const path = join(directory, 'people.csv');
    await writeFile(path, 'id,name\n1,Ada\n2,Grace\n');
    const result = await parse({ kind: 'csv', config: { path } });
    expect(result.error).toBeNull();
    expect(result.total).toBe(2);
    expect(result.records[0]).toEqual({ id: '1', name: 'Ada' });
  });

  it('caps the rows at the limit and reports truncation', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `${i};x`).join('\n');
    const result = await parse({
      kind: 'text',
      config: { delimiters: [';'] },
      sample: rows,
      limit: 3,
    });
    expect(result.records).toHaveLength(3);
    expect(result.total).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('returns parse and config problems as messages, not crashes', async () => {
    const noDelims = await parse({ kind: 'text', config: {}, sample: 'a;b' });
    expect(noDelims.error).toMatch(/delimiters/);

    const dupHeaders = await parse({
      kind: 'csv',
      config: {},
      sample: 'id,id\n1,2\n',
    });
    expect(dupHeaders.error).toMatch(/unique/);

    const missing = await parse({
      kind: 'csv',
      config: { path: '/nonexistent/foxflow-preview.csv' },
    });
    expect(missing.error).toMatch(/read/);
  });
});
