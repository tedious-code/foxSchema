/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The batching CSV, text and JSON sources share. Each kept its own copy
 * before, and the copies had drifted on exactly these points.
 */
import { describe, expect, it } from 'vitest';
import type { RecordBatch } from '../../registry/index.js';
import { BatchEmitter, type EmitterPositions } from './delimited.js';

const ROWS: EmitterPositions = { cursorKey: 'row', positionKey: '_row', label: 'CSV row', cut: 'record' };
const LINES: EmitterPositions = { cursorKey: 'line', positionKey: '_line', label: 'line', cut: 'boundary' };
const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };

const shape = (batches: Iterable<RecordBatch>) =>
  [...batches].map((b) => ({ id: b.id, port: b.port ?? 'out', cursor: b.cursor, size: b.records.length }));

describe('BatchEmitter', () => {
  it('cuts data and rejects at batchSize as they fill, in the order they filled', () => {
    const emitter = new BatchEmitter('src', { batchSize: 2, onInvalid: 'reject', schema }, ROWS);
    const out = [];
    for (const [n, row] of [[1, 1], ['x', 2], [2, 3], ['y', 4], [3, 5]] as const) {
      emitter.add({ n }, row);
      out.push(...emitter.drain());
    }
    out.push(...emitter.flush(5));
    expect(shape(out)).toEqual([
      { id: 'src:0:1-3', port: 'out', cursor: { row: 3 }, size: 2 },
      { id: 'src:rejects:2-4', port: 'rejects', cursor: undefined, size: 2 },
      { id: 'src:0:5-5', port: 'out', cursor: { row: 5 }, size: 1 },
    ]);
  });

  it('in boundary mode, never splits what one line produced across two batches', () => {
    const emitter = new BatchEmitter('src', { batchSize: 2, onInvalid: 'skip' }, LINES);
    // Line 1 flat-maps to three records: one batch of three, not two and one.
    for (const n of [1, 2, 3]) emitter.add({ n }, 1);
    expect(shape(emitter.drain())).toEqual([{ id: 'src:0:1-1', port: 'out', cursor: { line: 1 }, size: 3 }]);
  });

  it('points the final cursor past trailing refused rows, so a resume does not read them again', () => {
    const emitter = new BatchEmitter('src', { batchSize: 10, onInvalid: 'skip', schema }, ROWS);
    emitter.add({ n: 1 }, 1);
    emitter.add({ n: 'bad' }, 2);
    emitter.add({ n: 'bad' }, 3);
    expect(shape(emitter.flush(3))).toEqual([{ id: 'src:0:1-3', port: 'out', cursor: { row: 3 }, size: 1 }]);
  });

  it('fails with the position as the source names it, and why', () => {
    const csv = new BatchEmitter('src', { batchSize: 10, onInvalid: 'fail', schema }, ROWS);
    expect(() => csv.add({ n: 'x' }, 7)).toThrow(/^CSV row 7 failed schema: /);
    const text = new BatchEmitter('src', { batchSize: 10, onInvalid: 'fail' }, LINES);
    expect(() => text.add({}, 3, { reason: 'validation', message: 'qty: not a number' })).toThrow(
      'line 3 failed validation: qty: not a number',
    );
  });

  it('keeps a rejected record as the caller asks, with its error and position', () => {
    const emitter = new BatchEmitter('src', { batchSize: 10, onInvalid: 'reject' }, LINES);
    emitter.add({ qty: Number.NaN }, 4, { reason: 'validation', message: 'qty: not a number' }, { qty: 'ten' });
    const [rejects] = [...emitter.flush(4)];
    expect(rejects!.records).toEqual([{ qty: 'ten', _error: 'qty: not a number', _line: 4 }]);
  });
});
