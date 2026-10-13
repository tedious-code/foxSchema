/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/delimited.test.ts).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { PipeContext, RecordBatch } from '../../registry/index.js';
import {
  CsvSourcePipe,
  TextSourcePipe,
  applyColumnRules,
  columnRuleFieldsSchema,
  compileColumnRules,
  describeFailures,
  invalidRecords,
  isHeaderRecord,
  lineToRecords,
  parseCsvRecords,
  parseTextRecords,
  parseTextRows,
  resolveColumnChecks,
  sliceFixedLine,
} from './index.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function tempFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'foxflow-delimited-'));
  cleanup.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

function context(type: string, config: Record<string, unknown>): PipeContext {
  return {
    workflowRunId: 'run',
    pipelineId: 'pipeline',
    pipe: { id: type, type, role: 'source', config, concurrency: 1 },
  };
}

async function collect(
  source: CsvSourcePipe | TextSourcePipe,
  ctx: PipeContext,
): Promise<RecordBatch[]> {
  const batches: RecordBatch[] = [];
  for await (const batch of source.read(ctx)) batches.push(batch);
  return batches;
}

describe('lineToRecords', () => {
  it('splits fields on any configured delimiter, longest first', () => {
    expect(
      lineToRecords('a;b::c', { delimiters: ['::', ';'] }),
    ).toEqual([{ field_1: 'a', field_2: 'b', field_3: 'c' }]);
  });

  it('flat-maps one line into records via the record delimiter', () => {
    expect(
      lineToRecords('1;ada|2;grace|3;linus', {
        delimiters: [';'],
        recordDelimiter: '|',
        fields: ['id', 'name'],
      }),
    ).toEqual([
      { id: '1', name: 'ada' },
      { id: '2', name: 'grace' },
      { id: '3', name: 'linus' },
    ]);
  });

  it('fills missing named fields with "" and names extras field_N', () => {
    expect(
      lineToRecords('only', { delimiters: [';'], fields: ['a', 'b'] }),
    ).toEqual([{ a: 'only', b: '' }]);
    expect(
      lineToRecords('1;2;3', { delimiters: [';'], fields: ['a'] }),
    ).toEqual([{ a: '1', field_2: '2', field_3: '3' }]);
  });

  it('respects trim and skipEmpty settings', () => {
    expect(
      lineToRecords(' a ; b ', { delimiters: [';'], trim: false }),
    ).toEqual([{ field_1: ' a ', field_2: ' b ' }]);
    expect(
      lineToRecords('a|  |b', {
        delimiters: [';'],
        recordDelimiter: '|',
      }),
    ).toEqual([{ field_1: 'a' }, { field_1: 'b' }]);
    expect(
      lineToRecords('a||b', {
        delimiters: [';'],
        recordDelimiter: '|',
        skipEmpty: false,
      }),
    ).toHaveLength(3);
  });
});

describe('parseTextRecords', () => {
  it('applies the line offset and handles CRLF + blank lines', () => {
    const text = 'REPORT 2026\r\n\r\n1;ada\r\n2;grace\r\n';
    expect(
      parseTextRecords(text, {
        offset: 1,
        delimiters: [';'],
        fields: ['id', 'name'],
      }),
    ).toEqual([
      { id: '1', name: 'ada' },
      { id: '2', name: 'grace' },
    ]);
  });

  it('flat-maps across every line', () => {
    expect(
      parseTextRecords('1;a|2;b\n3;c', {
        delimiters: [';'],
        recordDelimiter: '|',
        fields: ['id', 'v'],
      }),
    ).toEqual([
      { id: '1', v: 'a' },
      { id: '2', v: 'b' },
      { id: '3', v: 'c' },
    ]);
  });
});

// Mainframe-style flat file: every field at a fixed 1-based position.
const PEOPLE_COLUMNS = [
  { name: 'id', start: 1, length: 6 },
  { name: 'name', start: 7, length: 19 },
  { name: 'gender', start: 26, length: 1 },
  { name: 'birthdate', start: 27, length: 8 },
  { name: 'phone', start: 35, length: 10 },
  { name: 'email', start: 45, length: 28 },
  { name: 'city', start: 73, length: 19 },
  { name: 'province', start: 92, length: 2 },
];
const PEOPLE_LINE =
  '000001John Smith         M198810151234567890john@email.com              Toronto            ON';

describe('fixed-width parsing', () => {
  it('slices 1-based positional columns and trims padding', () => {
    expect(sliceFixedLine(PEOPLE_LINE, PEOPLE_COLUMNS)).toEqual({
      id: '000001',
      name: 'John Smith',
      gender: 'M',
      birthdate: '19881015',
      phone: '1234567890',
      email: 'john@email.com',
      city: 'Toronto',
      province: 'ON',
    });
  });

  it('keeps padding when trim is off and blanks columns past line end', () => {
    const raw = sliceFixedLine(PEOPLE_LINE, PEOPLE_COLUMNS, false);
    expect(raw.name).toBe('John Smith         ');
    const short = sliceFixedLine('000002Mary', [
      ...PEOPLE_COLUMNS.slice(0, 2),
      { name: 'gender', start: 26, length: 1 },
    ]);
    expect(short).toEqual({ id: '000002', name: 'Mary', gender: '' });
  });

  it('parses a fixed-width block through parseTextRecords', () => {
    const text = `${PEOPLE_LINE}\n000002Mary Johnson       F199203205678901234mary@gmail.com              Calgary            AB\n`;
    const records = parseTextRecords(text, {
      format: 'fixed',
      columns: PEOPLE_COLUMNS,
      delimiters: [],
    });
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      id: '000002',
      name: 'Mary Johnson',
      city: 'Calgary',
      province: 'AB',
    });
  });
});

describe('header handling', () => {
  const opts = {
    format: 'fixed' as const,
    columns: PEOPLE_COLUMNS,
    delimiters: [],
  };
  // A header line laid out in the same fixed positions as the data.
  const HEADER_LINE =
    'ID    NAME               GBIRTHDATPHONE     EMAIL                       CITY               PR';

  it('isHeaderRecord matches when values name their own columns', () => {
    const names = PEOPLE_COLUMNS.map((column) => column.name);
    // Realistic header: most labels equal their column name, some truncated.
    expect(isHeaderRecord(sliceFixedLine(HEADER_LINE, PEOPLE_COLUMNS), names)).toBe(true);
    // A data line never names its columns.
    expect(isHeaderRecord(sliceFixedLine(PEOPLE_LINE, PEOPLE_COLUMNS), names)).toBe(false);
    // Fixed-width headers get truncated to the column width, so a label that
    // is a prefix of its column name still counts (found live: a 5-column
    // subset saw ID/G/BIRTHDAT/EMAIL/PR and missed the header without this).
    const narrow = [
      { name: 'id', start: 1, length: 6 },
      { name: 'gender', start: 26, length: 1 },
      { name: 'birthdate', start: 27, length: 8 },
      { name: 'email', start: 45, length: 28 },
      { name: 'province', start: 92, length: 2 },
    ];
    const narrowNames = narrow.map((column) => column.name);
    expect(isHeaderRecord(sliceFixedLine(HEADER_LINE, narrow), narrowNames)).toBe(true);
    expect(isHeaderRecord(sliceFixedLine(PEOPLE_LINE, narrow), narrowNames)).toBe(false);
    // 2 of 3 non-empty values name their columns — enough to call it a header.
    expect(
      isHeaderRecord({ id: 'ID', name: ' Name ', email: 'x' }, ['id', 'name', 'email']),
    ).toBe(true);
  });

  it('auto drops a header line only when present', () => {
    const withHeader = `id    name               \n${PEOPLE_LINE}`;
    const without = PEOPLE_LINE;
    const auto = { ...opts, header: 'auto' as const };
    expect(parseTextRecords(withHeader, auto)).toHaveLength(1);
    expect(parseTextRecords(without, auto)).toHaveLength(1);
    expect(parseTextRecords(without, auto)[0]!.id).toBe('000001');
  });

  it('skip always drops the first content line, none keeps it', () => {
    const text = `${PEOPLE_LINE}\n${PEOPLE_LINE}`;
    expect(parseTextRecords(text, { ...opts, header: 'skip' })).toHaveLength(1);
    expect(parseTextRecords(text, { ...opts, header: 'none' })).toHaveLength(2);
  });

  it('applies header handling to delimited format too', () => {
    const text = 'id;email\n1;ada@example.com\n';
    const records = parseTextRecords(text, {
      delimiters: [';'],
      fields: ['id', 'email'],
      header: 'auto',
    });
    expect(records).toEqual([{ id: '1', email: 'ada@example.com' }]);
  });
});

describe('column rules (type + regex)', () => {
  it('converts declared types instead of leaving everything a string', () => {
    const { record, failures } = applyColumnRules(
      { id: '42', score: '3.5', active: 'yes', born: '19881015', name: 'Ada' },
      [
        { name: 'id', type: 'integer' },
        { name: 'score', type: 'number' },
        { name: 'active', type: 'boolean' },
        { name: 'born', type: 'date' },
        { name: 'name', type: 'string' },
      ],
    );
    expect(failures).toEqual([]);
    expect(record).toEqual({
      id: 42,
      score: 3.5,
      active: true,
      born: '1988-10-15',
      name: 'Ada',
    });
  });

  it('reports every failing column at once, naming the column', () => {
    const { failures } = applyColumnRules(
      { id: 'x', active: 'maybe', email: 'nope' },
      [
        { name: 'id', type: 'integer' },
        { name: 'active', type: 'boolean' },
        { name: 'email', pattern: '^\\S+@\\S+$' },
      ],
    );
    expect(failures.map((failure) => failure.column)).toEqual([
      'id',
      'active',
      'email',
    ]);
    expect(failures[0]!.message).toMatch(/not an integer/);
    expect(failures[2]!.message).toMatch(/does not match/);
  });

  it('checks the regex before converting, and reports only one reason', () => {
    const { failures } = applyColumnRules({ id: '12ab' }, [
      { name: 'id', type: 'integer', pattern: '^\\d{6}$' },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toMatch(/does not match/);
  });

  it('runs multi-regex checks (null, length, format) and labels failures', () => {
    const nullToken = applyColumnRules({ email: 'NULL' }, [
      {
        name: 'email',
        checks: [
          {
            kind: 'null',
            pattern: '^(?!(?:NULL|N/?A)$).+$',
            message: 'must not be a null token',
          },
          { kind: 'format', pattern: '^\\S+@\\S+$' },
        ],
      },
    ]);
    expect(nullToken.failures.map((failure) => failure.message)).toEqual([
      'must not be a null token',
      expect.stringMatching(/^format: /),
    ]);

    const short = applyColumnRules({ email: 'x' }, [
      {
        name: 'email',
        checks: [
          { kind: 'length', pattern: '^.{3,50}$' },
          { kind: 'format', pattern: '^\\S+@\\S+$' },
        ],
      },
    ]);
    expect(short.failures.map((failure) => failure.message)).toEqual([
      expect.stringMatching(/^length: /),
      expect.stringMatching(/^format: /),
    ]);
  });

  it('accepts a value that passes every multi-regex check, then converts type', () => {
    const { record, failures } = applyColumnRules({ id: '000042' }, [
      {
        name: 'id',
        type: 'integer',
        checks: [
          { kind: 'null', pattern: '^(?!(?:NULL|N/?A)$).+$' },
          { kind: 'length', pattern: '^\\d{6}$' },
          { kind: 'format', pattern: '^\\d+$' },
        ],
      },
    ]);
    expect(failures).toEqual([]);
    expect(record.id).toBe(42);
  });

  it('still honors the legacy single pattern alongside checks', () => {
    const { failures } = applyColumnRules({ code: 'AB' }, [
      {
        name: 'code',
        pattern: '^[A-Z]+$',
        checks: [{ kind: 'length', pattern: '^.{3,}$' }],
      },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toMatch(/^length: /);
  });

  it('ignores blank check patterns so staged designer rows are inert', () => {
    const { failures } = applyColumnRules({ id: '1' }, [
      {
        name: 'id',
        type: 'integer',
        checks: [{ kind: 'format', pattern: '   ' }],
      },
    ]);
    expect(failures).toEqual([]);
  });

  it('treats empty values as absent unless the column is required', () => {
    expect(applyColumnRules({ note: '' }, [{ name: 'note', type: 'integer' }]).failures)
      .toEqual([]);
    const required = applyColumnRules({ note: '' }, [
      { name: 'note', required: true },
    ]);
    expect(required.failures).toEqual([
      { column: 'note', message: 'is required' },
    ]);
  });

  it('rejects integers outside the safe range rather than silently rounding', () => {
    const { failures } = applyColumnRules({ id: '9007199254740993' }, [
      { name: 'id', type: 'integer' },
    ]);
    expect(failures[0]!.message).toMatch(/safe integer range/);
  });

  it('fails the run on a malformed pattern (config error, not data error)', () => {
    expect(() =>
      applyColumnRules({ id: '1' }, [{ name: 'id', pattern: '([' }]),
    ).toThrow(/invalid pattern/);
  });

  it('applies rules through parseTextRows for both formats', () => {
    const fixed = parseTextRows(PEOPLE_LINE, {
      format: 'fixed',
      delimiters: [],
      columns: [
        { name: 'id', start: 1, length: 6, type: 'integer' },
        { name: 'name', start: 7, length: 19 },
        { name: 'birthdate', start: 27, length: 8, type: 'date' },
      ],
    });
    expect(fixed.invalid).toEqual([]);
    expect(fixed.records[0]).toEqual({
      id: 1,
      name: 'John Smith',
      birthdate: '1988-10-15',
    });

    const delimited = parseTextRows('1;ada@example.com\nx;nope', {
      delimiters: [';'],
      fields: ['id', 'email'],
      rules: [
        { name: 'id', type: 'integer' },
        { name: 'email', pattern: '^\\S+@\\S+$' },
      ],
    });
    expect(delimited.records[0]).toEqual({ id: 1, email: 'ada@example.com' });
    expect(delimited.lines).toEqual([1, 2]);
    expect(delimited.invalid).toEqual([
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/id .*integer; email .*match/),
      },
    ]);
  });

  it('reports the source line for each failing row', () => {
    const { invalid, lines } = parseTextRows(
      'skip\nada@example.com\nNULL\nx',
      {
        offset: 1,
        delimiters: [';'],
        fields: ['email'],
        rules: [
          {
            name: 'email',
            checks: [
              { kind: 'null', pattern: '^(?!(?:NULL|N/?A)$).+$' },
              { kind: 'format', pattern: '^\\S+@\\S+$' },
            ],
          },
        ],
      },
    );
    expect(lines).toEqual([2, 3, 4]);
    expect(invalid).toEqual([
      {
        index: 1,
        line: 3,
        message: expect.stringMatching(/null:.*format:/),
      },
      {
        index: 2,
        line: 4,
        message: expect.stringMatching(/format:/),
      },
    ]);
  });

  it('accepts every boolean true/false token and rejects unknowns', () => {
    for (const token of ['true', 'TRUE', '1', 'yes', 'Y', 't']) {
      expect(applyColumnRules({ ok: token }, [{ name: 'ok', type: 'boolean' }]))
        .toEqual({ record: { ok: true }, failures: [] });
    }
    for (const token of ['false', 'FALSE', '0', 'no', 'N', 'f']) {
      expect(applyColumnRules({ ok: token }, [{ name: 'ok', type: 'boolean' }]))
        .toEqual({ record: { ok: false }, failures: [] });
    }
    expect(
      applyColumnRules({ ok: 'maybe' }, [{ name: 'ok', type: 'boolean' }]).failures,
    ).toEqual([{ column: 'ok', message: '"maybe" is not a boolean' }]);
  });

  it('normalizes compact and ISO dates, rejects garbage', () => {
    expect(
      applyColumnRules({ d: '19881015' }, [{ name: 'd', type: 'date' }]).record.d,
    ).toBe('1988-10-15');
    expect(
      applyColumnRules({ d: '1988-10-15' }, [{ name: 'd', type: 'date' }]).record.d,
    ).toBe('1988-10-15');
    expect(
      applyColumnRules({ d: 'not-a-date' }, [{ name: 'd', type: 'date' }]).failures,
    ).toEqual([{ column: 'd', message: '"not-a-date" is not a date' }]);
  });

  it('parses signed integers and rejects decimals for integer type', () => {
    expect(
      applyColumnRules({ n: '-12' }, [{ name: 'n', type: 'integer' }]).record.n,
    ).toBe(-12);
    expect(
      applyColumnRules({ n: '+7' }, [{ name: 'n', type: 'integer' }]).record.n,
    ).toBe(7);
    expect(
      applyColumnRules({ n: '3.14' }, [{ name: 'n', type: 'integer' }]).failures[0]!
        .message,
    ).toMatch(/not an integer/);
    expect(
      applyColumnRules({ n: '3.14' }, [{ name: 'n', type: 'number' }]).record.n,
    ).toBe(3.14);
    expect(
      applyColumnRules({ n: 'NaN' }, [{ name: 'n', type: 'number' }]).failures[0]!
        .message,
    ).toMatch(/not a number/);
  });

  it('treats null/undefined cells like empty text for required checks', () => {
    expect(
      applyColumnRules({ a: null, b: undefined }, [
        { name: 'a', required: true },
        { name: 'b', required: true },
      ]).failures,
    ).toEqual([
      { column: 'a', message: 'is required' },
      { column: 'b', message: 'is required' },
    ]);
  });

  it('rejects common null tokens via a null-kind regex', () => {
    const rule = {
      name: 'code',
      checks: [
        {
          kind: 'null',
          pattern: '^(?!(?:NULL|N/?A|—|-)$).+$',
        },
      ],
    };
    for (const token of ['NULL', 'N/A', 'NA', '—', '-']) {
      const { failures } = applyColumnRules({ code: token }, [rule]);
      expect(failures[0]!.message).toMatch(/^null: /);
    }
    expect(applyColumnRules({ code: 'OK' }, [rule]).failures).toEqual([]);
  });

  it('enforces length bounds with a length-kind regex', () => {
    const rule = {
      name: 'sku',
      checks: [{ kind: 'length', pattern: '^.{4,8}$' }],
    };
    expect(applyColumnRules({ sku: 'AB' }, [rule]).failures[0]!.message)
      .toMatch(/^length: /);
    expect(applyColumnRules({ sku: 'ABCDEFGHI' }, [rule]).failures[0]!.message)
      .toMatch(/^length: /);
    expect(applyColumnRules({ sku: 'ABCD' }, [rule]).failures).toEqual([]);
    expect(applyColumnRules({ sku: 'ABCDEFGH' }, [rule]).failures).toEqual([]);
  });

  it('uses a custom kind label when it is not one of the suggested kinds', () => {
    const { failures } = applyColumnRules({ zip: '12' }, [
      {
        name: 'zip',
        checks: [{ kind: 'postal', pattern: '^\\d{5}$' }],
      },
    ]);
    expect(failures[0]!.message).toMatch(/^postal: /);
  });

  it('prefers a custom message over the default kind-prefixed text', () => {
    const { failures } = applyColumnRules({ id: 'x' }, [
      {
        name: 'id',
        checks: [
          {
            kind: 'format',
            pattern: '^\\d+$',
            message: 'id must be digits only',
          },
        ],
      },
    ]);
    expect(failures).toEqual([
      { column: 'id', message: 'id must be digits only' },
    ]);
  });

  it('merges legacy pattern before checks, skipping blank entries', () => {
    expect(
      resolveColumnChecks({
        name: 'x',
        pattern: '^[A-Z]+$',
        checks: [
          { kind: 'length', pattern: '' },
          { kind: 'format', pattern: '^.{2,}$' },
          { pattern: '   ' },
        ],
      }),
    ).toEqual([
      { pattern: '^[A-Z]+$' },
      { kind: 'format', pattern: '^.{2,}$' },
    ]);
  });

  it('dedupes the same pattern when listed as both legacy and checks', () => {
    expect(
      resolveColumnChecks({
        name: 'code',
        pattern: '^[A-Z]+$',
        checks: [{ kind: 'format', pattern: '^[A-Z]+$' }],
      }),
    ).toEqual([{ pattern: '^[A-Z]+$' }]);
  });

  it('strips blank staged checks when the shared zod schema parses', () => {
    const schema = z.object({
      name: z.string(),
      ...columnRuleFieldsSchema,
    });
    const parsed = schema.parse({
      name: 'email',
      type: 'string',
      checks: [
        { kind: 'format', pattern: '' },
        { kind: 'format', pattern: '^\\S+@\\S+$' },
        { pattern: '   ' },
      ],
    });
    expect(parsed.checks).toEqual([
      { kind: 'format', pattern: '^\\S+@\\S+$' },
    ]);
  });

  it('compiles patterns once and fails fast on malformed regex', () => {
    const compiled = compileColumnRules([
      { name: 'id', pattern: '^\\d+$' },
      { name: 'email', checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }] },
    ]);
    expect(compiled.get('id')![0]!.regex.test('42')).toBe(true);
    expect(compiled.get('email')![0]!.regex.test('a@b.c')).toBe(true);
    expect(() =>
      compileColumnRules([{ name: 'id', pattern: '([' }]),
    ).toThrow(/invalid pattern/);
  });

  it('reuses precompiled regexes in applyColumnRules', () => {
    const rules = [
      {
        name: 'email',
        checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }],
      },
    ];
    const compiled = compileColumnRules(rules);
    expect(applyColumnRules({ email: 'bad' }, rules, compiled).failures).toEqual([
      {
        column: 'email',
        message: expect.stringMatching(/^format: /),
      },
    ]);
    expect(applyColumnRules({ email: 'a@b.c' }, rules, compiled).failures).toEqual(
      [],
    );
  });

  it('joins multi-column failures into one human-readable line', () => {
    expect(
      describeFailures([
        { column: 'id', message: 'is required' },
        { column: 'email', message: 'format: "x" does not match ^\\S+@\\S+$' },
      ]),
    ).toBe('id is required; email format: "x" does not match ^\\S+@\\S+$');
  });

  it('shares one source line across flat-mapped records that fail', () => {
    const { records, invalid, lines } = parseTextRows(
      '1;ada@example.com|x;nope|2;linus@example.com',
      {
        delimiters: [';'],
        recordDelimiter: '|',
        fields: ['id', 'email'],
        rules: [
          { name: 'id', type: 'integer' },
          { name: 'email', pattern: '^\\S+@\\S+$' },
        ],
      },
    );
    expect(records).toHaveLength(3);
    expect(lines).toEqual([1, 1, 1]);
    expect(invalid).toEqual([
      {
        index: 1,
        line: 1,
        message: expect.stringMatching(/id .*integer; email .*match/),
      },
    ]);
  });

  it('keeps physical line numbers after header skip and blank lines', () => {
    const { invalid, lines } = parseTextRows(
      ['ID;EMAIL', '', '1;ada@example.com', 'x;bad', '3;ok@ex.com'].join('\n'),
      {
        delimiters: [';'],
        fields: ['id', 'email'],
        header: 'skip',
        rules: [
          { name: 'id', type: 'integer' },
          {
            name: 'email',
            checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }],
          },
        ],
      },
    );
    expect(lines).toEqual([3, 4, 5]);
    expect(invalid).toEqual([
      {
        index: 1,
        line: 4,
        message: expect.stringMatching(/id .*integer; email format:/),
      },
    ]);
  });

  it('reports multi-regex failures with line numbers on fixed-width rows', () => {
    // Compact layout: id(6) + email(20) so slices stay unambiguous.
    const { invalid, lines } = parseTextRows(
      ['000001ada@example.com   ', '000002N/A                 '].join('\n'),
      {
        format: 'fixed',
        delimiters: [],
        columns: [
          { name: 'id', start: 1, length: 6, type: 'integer' },
          {
            name: 'email',
            start: 7,
            length: 20,
            checks: [
              {
                kind: 'null',
                pattern: '^(?!(?:NULL|N/?A)$).+$',
                message: 'email is a null token',
              },
              { kind: 'format', pattern: '^\\S+@\\S+$' },
            ],
          },
        ],
      },
    );
    expect(lines).toEqual([1, 2]);
    expect(invalid).toEqual([
      {
        index: 1,
        line: 2,
        message: expect.stringMatching(/email is a null token.*format:/),
      },
    ]);
  });
});

describe('invalidRecords', () => {
  it('reports regex pattern failures per record', () => {
    const schema = {
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string', pattern: '^\\S+@\\S+$' } },
    };
    const invalid = invalidRecords(
      [{ email: 'ada@example.com' }, { email: 'nope' }, {}],
      schema,
    );
    expect(invalid.map((row) => row.index)).toEqual([1, 2]);
    expect(invalid[0]!.message).toMatch(/pattern/);
    expect(invalid[1]!.message).toMatch(/email/);
  });

  it('returns nothing without a schema', () => {
    expect(invalidRecords([{ a: '1' }], undefined)).toEqual([]);
  });
});

describe('parseCsvRecords', () => {
  it('skips preamble lines before the header and keeps quoting rules', async () => {
    const text = 'exported 2026-07-19\nnote,ignore\nid,name\n1,"Ada, A."\n2,Grace\n';
    const { headers, records } = await parseCsvRecords(text, { skipLines: 2 });
    expect(headers).toEqual(['id', 'name']);
    expect(records).toEqual([
      { id: '1', name: 'Ada, A.' },
      { id: '2', name: 'Grace' },
    ]);
  });
});

describe('CsvSourcePipe validation', () => {
  const schema = {
    type: 'object',
    required: ['id', 'email'],
    properties: {
      id: { type: 'string', pattern: '^\\d+$' },
      email: { type: 'string', pattern: '^\\S+@\\S+$' },
    },
  };
  const csv =
    'id,email\n1,ada@example.com\nx,bad-row\n3,linus@example.com\n';

  it('fails the run on the first invalid row by default', async () => {
    const path = await tempFile('rows.csv', csv);
    const source = new CsvSourcePipe();
    await expect(
      collect(source, context('csv', { path, schema })),
    ).rejects.toThrow(/row 2 failed schema.*pattern/);
  });

  it('skips invalid rows when onInvalid is "skip"', async () => {
    const path = await tempFile('rows.csv', csv);
    const source = new CsvSourcePipe();
    const batches = await collect(
      source,
      context('csv', { path, schema, onInvalid: 'skip' }),
    );
    expect(batches.flatMap((batch) => batch.records)).toEqual([
      { id: '1', email: 'ada@example.com' },
      { id: '3', email: 'linus@example.com' },
    ]);
  });

  it('dead-letters invalid rows out the rejects port when onInvalid is "reject"', async () => {
    const path = await tempFile('rows.csv', csv);
    const source = new CsvSourcePipe();
    const batches = await collect(
      source,
      context('csv', { path, schema, onInvalid: 'reject' }),
    );
    const data = batches.filter((batch) => batch.port === undefined);
    const rejects = batches.filter((batch) => batch.port === 'rejects');
    expect(data.flatMap((batch) => batch.records)).toEqual([
      { id: '1', email: 'ada@example.com' },
      { id: '3', email: 'linus@example.com' },
    ]);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.records).toEqual([
      {
        id: 'x',
        email: 'bad-row',
        _error: expect.stringMatching(/pattern/),
        _row: 2,
      },
    ]);
    // Reject batches never carry a cursor — the checkpoint may only advance
    // through data batches — and their ids are stable for idempotent sinks.
    expect(rejects[0]!.cursor).toBeUndefined();
    expect(rejects[0]!.id).toBe('csv:rejects:2-2');
  });

  it('skips preamble lines before the header row', async () => {
    const path = await tempFile(
      'report.csv',
      'ACME sales export\n\nid,email\n1,ada@example.com\n',
    );
    const source = new CsvSourcePipe();
    const batches = await collect(
      source,
      context('csv', { path, skipLines: 2 }),
    );
    expect(batches.flatMap((batch) => batch.records)).toEqual([
      { id: '1', email: 'ada@example.com' },
    ]);
  });
});

describe('TextSourcePipe', () => {
  it('parses offset + multi-delimiter + flat map from a file', async () => {
    const path = await tempFile(
      'report.txt',
      'REPORT HEADER\n1;ada@example.com|2;grace@example.com\n3;linus@example.com\n',
    );
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        offset: 1,
        delimiters: [';'],
        recordDelimiter: '|',
        fields: ['id', 'email'],
      }),
    );
    expect(batches.flatMap((batch) => batch.records)).toEqual([
      { id: '1', email: 'ada@example.com' },
      { id: '2', email: 'grace@example.com' },
      { id: '3', email: 'linus@example.com' },
    ]);
    // Cursor is the physical line, so batches carry resumable positions.
    expect(batches.at(-1)!.cursor).toEqual({ line: 3 });
  });

  it('resumes after the checkpointed line without re-emitting records', async () => {
    const path = await tempFile('lines.txt', 'a;1\nb;2\nc;3\n');
    const source = new TextSourcePipe();
    const ctx = context('text', { path, delimiters: [';'], fields: ['k', 'v'] });
    ctx.checkpoint = {
      workflowRunId: 'run',
      pipelineId: 'pipeline',
      pipeId: 'text',
      partitionId: '0',
      cursor: { line: 2 },
      updatedAt: new Date().toISOString(),
    };
    const batches = await collect(source, ctx);
    expect(batches.flatMap((batch) => batch.records)).toEqual([{ k: 'c', v: '3' }]);
  });

  it('never splits a flat-mapped line across batches', async () => {
    const path = await tempFile('wide.txt', '1|2|3\n4|5\n');
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        delimiters: [';'],
        recordDelimiter: '|',
        batchSize: 2,
      }),
    );
    expect(batches.map((batch) => batch.records.length)).toEqual([3, 2]);
    expect(batches[0]!.cursor).toEqual({ line: 1 });
  });

  it('reads a fixed-width flat file, with and without a header line', async () => {
    const body = [
      PEOPLE_LINE,
      '000002Mary Johnson       F199203205678901234mary@gmail.com              Calgary            AB',
      '000003David Lee          M198505119876543210david@yahoo.com             Vancouver          BC',
    ].join('\n');
    const header =
      'ID    NAME               GBIRTHDATPHONE     EMAIL                       CITY               PR';
    const config = {
      format: 'fixed',
      columns: PEOPLE_COLUMNS,
      header: 'auto',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^\\d{6}$' },
          email: { type: 'string', pattern: '^\\S+@\\S+$' },
        },
      },
    };
    const source = new TextSourcePipe();

    for (const content of [body, `${header}\n${body}`]) {
      const path = await tempFile('people.txt', `${content}\n`);
      const batches = await collect(source, context('text', { ...config, path }));
      const records = batches.flatMap((batch) => batch.records);
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({ id: '000001', name: 'John Smith', province: 'ON' });
      expect(records[2]).toMatchObject({ id: '000003', city: 'Vancouver' });
    }
  });

  it('validates and converts typed columns, dead-lettering the bad rows', async () => {
    const path = await tempFile(
      'typed.txt',
      [
        '000001John Smith         M198810151234567890john@email.com              Toronto            ON',
        // id is not numeric and the email is malformed — two failures, one row.
        'ABCDEFMary Johnson       F199203205678901234not-an-email                Calgary            AB',
      ].join('\n'),
    );
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        format: 'fixed',
        onInvalid: 'reject',
        columns: [
          { name: 'id', start: 1, length: 6, type: 'integer', required: true },
          { name: 'name', start: 7, length: 19, required: true },
          { name: 'birthdate', start: 27, length: 8, type: 'date' },
          { name: 'email', start: 45, length: 28, pattern: '^\\S+@\\S+$' },
          { name: 'province', start: 92, length: 2, pattern: '^[A-Z]{2}$' },
        ],
      }),
    );
    const data = batches.filter((batch) => batch.port === undefined);
    const rejects = batches.filter((batch) => batch.port === 'rejects');
    // Types are converted, not just checked: id is a number, date normalized.
    expect(data.flatMap((batch) => batch.records)).toEqual([
      {
        id: 1,
        name: 'John Smith',
        birthdate: '1988-10-15',
        email: 'john@email.com',
        province: 'ON',
      },
    ]);
    // The rejected row keeps its raw text so it can be corrected and replayed.
    expect(rejects[0]!.records[0]).toMatchObject({
      id: 'ABCDEF',
      email: 'not-an-email',
      _line: 2,
    });
    expect(String(rejects[0]!.records[0]!._error)).toMatch(
      /id .*integer.*email .*match/,
    );
  });

  it('fails the run on a typed-column failure by default', async () => {
    const path = await tempFile('typed.txt', 'x;1\n');
    const source = new TextSourcePipe();
    await expect(
      collect(
        source,
        context('text', {
          path,
          delimiters: [';'],
          fields: ['id', 'qty'],
          rules: [{ name: 'id', type: 'integer' }],
        }),
      ),
    ).rejects.toThrow(/line 1 failed validation: id .*not an integer/);
  });

  it('accepts blank staged regex checks and rejects malformed ones at validateConfig', () => {
    const source = new TextSourcePipe();
    expect(() =>
      source.validateConfig({
        path: '/tmp/x.txt',
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
      }),
    ).not.toThrow();
    expect(() =>
      source.validateConfig({
        path: '/tmp/x.txt',
        delimiters: [';'],
        fields: ['email'],
        rules: [{ name: 'email', checks: [{ pattern: '([' }] }],
      }),
    ).toThrow(/invalid pattern/);
  });

  it('applies the schema with fail and skip modes', async () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^\\d+$' } },
    };
    const path = await tempFile('ids.txt', '1\nx\n3\n');
    const source = new TextSourcePipe();
    await expect(
      collect(
        source,
        context('text', { path, delimiters: [';'], fields: ['id'], schema }),
      ),
    ).rejects.toThrow(/line 2 failed schema/);
    const batches = await collect(
      source,
      context('text', {
        path,
        delimiters: [';'],
        fields: ['id'],
        schema,
        onInvalid: 'skip',
      }),
    );
    expect(batches.flatMap((batch) => batch.records)).toEqual([
      { id: '1' },
      { id: '3' },
    ]);
  });

  it('applies multi-regex column rules and reports _line on rejects', async () => {
    const path = await tempFile(
      'emails.txt',
      ['ada@example.com', 'NULL', 'x', 'grace@example.com', 'N/A'].join('\n'),
    );
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        delimiters: [';'],
        fields: ['email'],
        onInvalid: 'reject',
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
      }),
    );
    const data = batches.filter((batch) => batch.port === undefined);
    const rejects = batches.filter((batch) => batch.port === 'rejects');
    expect(data.flatMap((batch) => batch.records)).toEqual([
      { email: 'ada@example.com' },
      { email: 'grace@example.com' },
    ]);
    expect(rejects.flatMap((batch) => batch.records)).toEqual([
      {
        email: 'NULL',
        _error: expect.stringMatching(/must not be a null token.*format:/),
        _line: 2,
      },
      {
        email: 'x',
        _error: expect.stringMatching(/length:.*format:/),
        _line: 3,
      },
      {
        email: 'N/A',
        _error: expect.stringMatching(/must not be a null token.*format:/),
        _line: 5,
      },
    ]);
  });

  it('skips column-rule failures without emitting them when onInvalid is skip', async () => {
    const path = await tempFile('mix.txt', '1;ok@ex.com\nx;bad\n3;linus@ex.com\n');
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        delimiters: [';'],
        fields: ['id', 'email'],
        onInvalid: 'skip',
        rules: [
          { name: 'id', type: 'integer' },
          {
            name: 'email',
            checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }],
          },
        ],
      }),
    );
    expect(batches.flatMap((batch) => batch.records)).toEqual([
      { id: 1, email: 'ok@ex.com' },
      { id: 3, email: 'linus@ex.com' },
    ]);
    expect(batches.every((batch) => batch.port === undefined)).toBe(true);
  });

  it('names the failing line when multi-regex checks fail the run', async () => {
    const path = await tempFile('codes.txt', 'ABCD\nAB\n');
    const source = new TextSourcePipe();
    await expect(
      collect(
        source,
        context('text', {
          path,
          delimiters: [';'],
          fields: ['sku'],
          rules: [
            {
              name: 'sku',
              checks: [
                { kind: 'length', pattern: '^.{4,8}$' },
                { kind: 'format', pattern: '^[A-Z]+$' },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/line 2 failed validation: sku length:/);
  });

  it('converts types after multi-regex checks on delimited rules', async () => {
    const path = await tempFile(
      'typed-delim.txt',
      '000042;yes;19881015\n000043;no;19920320\n',
    );
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        delimiters: [';'],
        fields: ['id', 'active', 'born'],
        rules: [
          {
            name: 'id',
            type: 'integer',
            checks: [
              { kind: 'length', pattern: '^\\d{6}$' },
              { kind: 'format', pattern: '^\\d+$' },
            ],
          },
          { name: 'active', type: 'boolean' },
          { name: 'born', type: 'date' },
        ],
      }),
    );
    expect(batches.flatMap((batch) => batch.records)).toEqual([
      { id: 42, active: true, born: '1988-10-15' },
      { id: 43, active: false, born: '1992-03-20' },
    ]);
  });

  it('reports _line for each flat-mapped reject from the same physical line', async () => {
    const path = await tempFile(
      'flat.txt',
      '1;ada@example.com|x;nope|2;grace@example.com\n',
    );
    const source = new TextSourcePipe();
    const batches = await collect(
      source,
      context('text', {
        path,
        delimiters: [';'],
        recordDelimiter: '|',
        fields: ['id', 'email'],
        onInvalid: 'reject',
        rules: [
          { name: 'id', type: 'integer' },
          {
            name: 'email',
            checks: [{ kind: 'format', pattern: '^\\S+@\\S+$' }],
          },
        ],
      }),
    );
    const data = batches.filter((batch) => batch.port === undefined);
    const rejects = batches.filter((batch) => batch.port === 'rejects');
    expect(data.flatMap((batch) => batch.records)).toEqual([
      { id: 1, email: 'ada@example.com' },
      { id: 2, email: 'grace@example.com' },
    ]);
    expect(rejects.flatMap((batch) => batch.records)).toEqual([
      {
        id: 'x',
        email: 'nope',
        _error: expect.stringMatching(/id .*integer; email format:/),
        _line: 1,
      },
    ]);
  });
});

describe('preview lines match the run', () => {
  it('splits lines exactly as readLines does', async () => {
    const { parseTextRows } = await import('./delimited.js');
    const { readLines } = await import('./text.js');
    for (const text of ['a|1\r\nb|2\n', 'a|1\rb|2\n', 'a|1\n\nb|2', 'x', '', 'a|1\n\n']) {
      const run: string[] = [];
      for await (const line of readLines([text] as unknown as AsyncIterable<string>)) run.push(line);
      const preview = parseTextRows(text, { delimiters: ['|'], skipEmpty: false, fields: ['k', 'v'] });
      expect(preview.lines.length, JSON.stringify(text)).toBe(run.length);
    }
  });
});
