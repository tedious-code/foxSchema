import { describe, expect, it } from 'vitest';
import { NdjsonStreamReader, collectColumns } from './ndjson-stream';
import { parseJsonRecords } from './file-query.service';

/** Read `text` through the streaming reader in fixed-size chunks. */
function stream(text: string, chunkSize: number): Record<string, unknown>[] {
  const reader = new NdjsonStreamReader({ batchSize: 1 });
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    reader.write(text.slice(i, i + chunkSize));
    out.push(...reader.take());
  }
  reader.end();
  out.push(...reader.take());
  return out;
}

/** What the buffered path produces for the same input. */
function buffered(text: string): Record<string, unknown>[] {
  return parseJsonRecords(text, 'ndjson').rows;
}

const CASES: Array<[string, string]> = [
  ['single record', '{"a":1}\n'],
  ['no trailing newline', '{"a":1}\n{"b":2}'],
  ['crlf line endings', '{"a":1}\r\n{"b":2}\r\n'],
  ['blank lines between records', '{"a":1}\n\n\n{"b":2}\n'],
  ['leading blank lines', '\n\n{"a":1}\n'],
  ['whitespace-padded lines', '   {"a":1}   \n\t{"b":2}\t\n'],
  ['bom', '﻿{"a":1}\n{"b":2}\n'],
  ['newline inside a string value', '{"a":"line1\\nline2"}\n{"b":2}\n'],
  ['braces inside a string value', '{"a":"{not json}"}\n'],
  ['escaped quotes', '{"a":"say \\"hi\\""}\n'],
  ['unicode escapes', '{"a":"\\u00e9\\u4e2d"}\n'],
  ['nested objects and arrays', '{"a":{"b":[1,2,{"c":3}]}}\n'],
  ['null and boolean values', '{"a":null,"b":true,"c":false}\n'],
  ['numbers', '{"i":1,"f":1.5,"e":1e3,"neg":-2}\n'],
  ['empty object', '{}\n'],
  ['only blank lines', '\n\n\n'],
  ['empty input', ''],
];

describe('NdjsonStreamReader matches parseJsonRecords exactly', () => {
  for (const [label, text] of CASES) {
    it(`${label} — identical at every chunk boundary`, () => {
      const expected = buffered(text);
      for (let size = 1; size <= Math.max(text.length, 1); size++) {
        expect(stream(text, size), `chunk size ${size}`).toEqual(expected);
      }
    });
  }
});

describe('NdjsonStreamReader rejects what the buffered path rejects', () => {
  const BAD: Array<[string, string, RegExp]> = [
    ['a bare array line', '{"a":1}\n[1,2]\n', /line 2 must be a JSON object/],
    ['a bare scalar line', '{"a":1}\n42\n', /line 2 must be a JSON object/],
    ['a bare string line', '"hello"\n', /line 1 must be a JSON object/],
    ['a null line', 'null\n', /line 1 must be a JSON object/],
    ['malformed json', '{"a":1}\n{"b":\n', /line 2 is not valid JSON/],
  ];

  for (const [label, text, matcher] of BAD) {
    it(`${label} — and names the line`, () => {
      // The buffered path also throws; the point is that streaming does too,
      // rather than silently importing a partial file.
      expect(() => buffered(text)).toThrow();
      for (const size of [1, 3, text.length]) {
        expect(() => stream(text, size), `chunk size ${size}`).toThrow(matcher);
      }
    });
  }

  it('counts blank lines so the number matches the file', () => {
    // Line 3 in the file, not "the 2nd record" — the whole point of a number.
    expect(() => stream('{"a":1}\n\n[1]\n', 1)).toThrow(/line 3/);
  });
});

describe('NdjsonStreamReader memory behaviour', () => {
  it('never accumulates the file — buffer stays at batch size', () => {
    const reader = new NdjsonStreamReader({ batchSize: 100 });
    let peak = 0;
    for (let i = 0; i < 5000; i++) {
      reader.write(`{"id":${i},"name":"row_${i}"}\n`);
      if (reader.hasBatch) reader.take();
      peak = Math.max(
        peak,
        (reader as unknown as { records: unknown[] }).records.length
      );
    }
    reader.end();
    expect(peak).toBeLessThanOrEqual(100);
    expect(reader.emitted).toBe(5000);
  });

  it('holds records until a batch is full', () => {
    const reader = new NdjsonStreamReader({ batchSize: 3 });
    reader.write('{"a":1}\n{"a":2}\n');
    expect(reader.hasBatch).toBe(false);
    reader.write('{"a":3}\n');
    expect(reader.hasBatch).toBe(true);
    expect(reader.take()).toHaveLength(3);
    expect(reader.take()).toEqual([]);
  });
});

describe('collectColumns', () => {
  it('unions keys in first-seen order across batches', () => {
    const cols: string[] = [];
    collectColumns([{ a: 1, b: 2 }], cols);
    collectColumns([{ b: 3, c: 4 }], cols);
    expect(cols).toEqual(['a', 'b', 'c']);
  });

  it('matches the buffered column order for the same records', () => {
    const text = '{"a":1,"b":2}\n{"c":3}\n';
    expect(collectColumns(stream(text, 1))).toEqual(parseJsonRecords(text, 'ndjson').columns);
  });
});

describe('NdjsonStreamReader fuzz vs parseJsonRecords', () => {
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      return x / 0xffffffff;
    };
  }

  const VALUES = [
    '1', '-2.5', '"plain"', '"with \\"quote\\""', '"with \\n newline"',
    'null', 'true', 'false', '[1,2]', '{"n":1}', '"{braces}"', '"a,b"',
  ];

  it('agrees on 300 random NDJSON files at random chunk sizes', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const lines = 1 + Math.floor(rand() * 6);
      const parts: string[] = [];
      for (let i = 0; i < lines; i++) {
        if (rand() < 0.2) {
          parts.push(rand() < 0.5 ? '' : '   '); // blank / whitespace line
          continue;
        }
        const keys = 1 + Math.floor(rand() * 3);
        const obj: string[] = [];
        for (let k = 0; k < keys; k++) {
          obj.push(`"k${k}":${VALUES[Math.floor(rand() * VALUES.length)]!}`);
        }
        parts.push(`{${obj.join(',')}}`);
      }
      const text = parts.join(rand() < 0.5 ? '\n' : '\r\n') + (rand() < 0.5 ? '\n' : '');
      const chunkSize = 1 + Math.floor(rand() * 10);
      expect(stream(text, chunkSize), `seed ${seed} chunk ${chunkSize} input ${JSON.stringify(text)}`)
        .toEqual(buffered(text));
    }
  });
});
