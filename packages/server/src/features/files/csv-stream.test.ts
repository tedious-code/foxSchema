import { describe, expect, it } from 'vitest';
import { CsvStreamReader } from './csv-stream';
import { parseCsv } from './file-query.service';

/** Read `text` through the streaming reader in fixed-size chunks. */
function stream(text: string, chunkSize: number, delimiter?: string): string[][] {
  const reader = new CsvStreamReader({ delimiter, batchSize: 1 });
  const out: string[][] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    reader.write(text.slice(i, i + chunkSize));
    out.push(...reader.take());
  }
  reader.end();
  out.push(...reader.take());
  return out;
}

/** What parseCsv produces, as raw rows (header off, so the grammars line up). */
function buffered(text: string, delimiter?: string): string[][] {
  return parseCsv(text, { hasHeader: false, delimiter }).rows as string[][];
}

const CASES: Array<[string, string, string | undefined]> = [
  ['plain', 'a,b,c\n1,2,3\n', undefined],
  ['no trailing newline', 'a,b\n1,2', undefined],
  ['crlf', 'a,b\r\n1,2\r\n', undefined],
  ['quoted field', 'a,"b,still b",c\n', undefined],
  ['escaped quote', 'a,"say ""hi""",c\n', undefined],
  ['quoted newline', 'a,"line1\nline2",c\n', undefined],
  ['empty fields', 'a,,c\n,,\n', undefined],
  ['blank line between rows', 'a,b\n\nc,d\n', undefined],
  ['bom', '﻿a,b\n1,2\n', undefined],
  ['multi-char delimiter', 'a||b||c\n1||2||3\n', '||'],
  ['delimiter inside quotes', '"a||b"||c\n', '||'],
  ['quote at very end', 'a,"b"', undefined],
  ['only a newline', '\n', undefined],
  ['trailing blank line', 'a,b\n1,2\n\n', undefined],
  ['unterminated quote', 'a,"b\n', undefined],
];

describe('CsvStreamReader matches parseCsv exactly', () => {
  // Every chunk size from 1 up: the whole point is that a boundary landing
  // inside a quote, an escaped quote, a CRLF, or a multi-char delimiter must
  // not change the result.
  for (const [label, text, delimiter] of CASES) {
    it(`${label} — identical at every chunk boundary`, () => {
      const expected = buffered(text, delimiter);
      for (let size = 1; size <= Math.max(text.length, 1); size++) {
        expect(stream(text, size, delimiter), `chunk size ${size}`).toEqual(expected);
      }
    });
  }
});

describe('CsvStreamReader batching', () => {
  it('holds rows until a batch is full, then hands them over', () => {
    const reader = new CsvStreamReader({ batchSize: 3 });
    reader.write('1\n2\n');
    expect(reader.hasBatch).toBe(false);
    reader.write('3\n4\n');
    expect(reader.hasBatch).toBe(true);
    expect(reader.take()).toEqual([['1'], ['2'], ['3'], ['4']]);
    expect(reader.take()).toEqual([]);
  });

  it('counts every row it emits', () => {
    const reader = new CsvStreamReader({ batchSize: 2 });
    reader.write('a\nb\nc\n');
    reader.end();
    expect(reader.emitted).toBe(3);
  });

  it('never accumulates the file — buffer stays at batch size', () => {
    // The property that makes 1 GB possible: memory tracks the batch, not input.
    const reader = new CsvStreamReader({ batchSize: 100 });
    let peak = 0;
    for (let i = 0; i < 5000; i++) {
      reader.write(`row_${i},value\n`);
      if (reader.hasBatch) reader.take();
      peak = Math.max(peak, (reader as unknown as { rows: string[][] }).rows.length);
    }
    reader.end();
    expect(peak).toBeLessThanOrEqual(100);
    expect(reader.emitted).toBe(5000);
  });
});

describe('CsvStreamReader fuzz vs parseCsv', () => {
  /** Deterministic PRNG so a failure is reproducible from the seed. */
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      return x / 0xffffffff;
    };
  }

  const ALPHABET = ['a', 'b', ',', '"', '\n', '\r', ' ', '|', '""', '\r\n'];

  it('agrees on 400 random inputs at random chunk sizes', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      const len = 1 + Math.floor(rand() * 40);
      let text = '';
      for (let i = 0; i < len; i++) {
        text += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
      }
      const chunkSize = 1 + Math.floor(rand() * 8);
      expect(stream(text, chunkSize), `seed ${seed} chunk ${chunkSize} input ${JSON.stringify(text)}`)
        .toEqual(buffered(text));
    }
  });

  it('agrees on 200 random inputs with a multi-char delimiter', () => {
    for (let seed = 1000; seed < 1200; seed++) {
      const rand = rng(seed);
      const len = 1 + Math.floor(rand() * 30);
      let text = '';
      for (let i = 0; i < len; i++) {
        text += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
      }
      const chunkSize = 1 + Math.floor(rand() * 6);
      expect(stream(text, chunkSize, '||'), `seed ${seed} chunk ${chunkSize} input ${JSON.stringify(text)}`)
        .toEqual(buffered(text, '||'));
    }
  });
});
