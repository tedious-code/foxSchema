/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The CSV scanner reads text in runs (indexOf + slice) instead of a character
 * at a time. It must read every input exactly as the character loop did —
 * kept below as the reference — however the text is split into chunks.
 */
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';

/** The character-at-a-time parser this replaced, verbatim. */
async function* referenceParse(chunks: Iterable<string>, delimiter: string): AsyncIterable<string[]> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  for await (const chunk of chunks) {
    for (const char of String(chunk)) {
      if (pendingQuote) {
        if (char === '"') {
          field += '"';
          pendingQuote = false;
          continue;
        }
        quoted = false;
        pendingQuote = false;
      }
      if (quoted) {
        if (char === '"') pendingQuote = true;
        else field += char;
        continue;
      }
      if (char === '"' && field.length === 0) {
        quoted = true;
      } else if (char === delimiter) {
        row.push(field);
        field = '';
      } else if (char === '\n') {
        row.push(field.replace(/\r$/, ''));
        yield row;
        field = '';
        row = [];
      } else {
        field += char;
      }
    }
  }
  if (quoted && !pendingQuote) throw new Error('unterminated quoted CSV field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    yield row;
  }
}

async function collect(rows: AsyncIterable<string[]>): Promise<string[][] | string> {
  const out: string[][] = [];
  try {
    for await (const row of rows) out.push(row);
  } catch (error) {
    return `error: ${(error as Error).message}`;
  }
  return out;
}

/** A small deterministic generator, so a failure names a reproducible seed. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function chunked(text: string, next: () => number): string[] {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(next() * 6);
    parts.push(text.slice(at, at + size));
    at += size;
  }
  return parts;
}

describe('CSV scanning', () => {
  it('reads the cases people write by hand', async () => {
    const cases: Array<[string, string[][]]> = [
      ['a,b\n1,2\n', [['a', 'b'], ['1', '2']]],
      ['"a,b",c\r\n"x""y",z', [['a,b', 'c'], ['x"y', 'z']]],
      ['"line\nbreak",2\n', [['line\nbreak', '2']]],
      ['ab"c,"d"e\n', [['ab"c', 'de']]],
      [',,\n', [['', '', '']]],
      ['"",""\n', [['', '']]],
    ];
    for (const [text, rows] of cases) {
      expect(await collect(parseCsv([text], ',')), JSON.stringify(text)).toEqual(rows);
    }
  });

  it('agrees with the character loop on every input, however it is chunked', async () => {
    const alphabet = ['a', 'b', '"', '"', ',', ';', '\n', '\r', ' ', 'é', '😀'];
    for (let seed = 1; seed <= 3000; seed++) {
      const next = random(seed);
      const delimiter = next() < 0.8 ? ',' : ';';
      const length = Math.floor(next() * 40);
      let text = '';
      for (let i = 0; i < length; i++) text += alphabet[Math.floor(next() * alphabet.length)];
      const chunks = chunked(text, next);
      const expected = await collect(referenceParse([text], delimiter));
      expect(await collect(parseCsv(chunks, delimiter)), `seed ${seed}: ${JSON.stringify(chunks)}`).toEqual(expected);
      expect(await collect(parseCsv([text], delimiter)), `seed ${seed}, one chunk`).toEqual(expected);
    }
  });
});
