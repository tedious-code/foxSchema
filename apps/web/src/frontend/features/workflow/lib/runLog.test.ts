/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent, RunRecord } from '../api/engineClient';
import { eventLevel, eventSummary, formatDuration, hasDetail, isProblem, runLogText } from './runLog';

const at = '2026-11-22T05:17:59.254Z';
const ev = (seq: number, partial: Partial<RunEvent>): RunEvent => ({ seq, workflowRunId: 'r1', at, type: 'pipe.status', ...partial });

describe('run log', () => {
  it('ranks a failed status and an error log as errors, a cancel or reject as a warning', () => {
    expect(eventLevel(ev(1, { data: { status: 'failed' } }))).toBe('error');
    expect(eventLevel(ev(2, { type: 'pipe.log', data: { level: 'error' } }))).toBe('error');
    expect(eventLevel(ev(3, { data: { status: 'cancelled' } }))).toBe('warn');
    expect(eventLevel(ev(4, { type: 'reject', message: 'contract rejected 2 row(s)' }))).toBe('warn');
    expect(eventLevel(ev(5, { data: { status: 'running' } }))).toBe('info');
    expect(eventLevel(ev(6, { type: 'batch.sample', data: { recordCount: 3 } }))).toBe('debug');
    expect(isProblem(ev(7, { data: { status: 'success' } }))).toBe(false);
  });

  it('summarises status with the error message, and batches by row count', () => {
    expect(eventSummary(ev(1, { data: { status: 'failed' }, message: 'cannot start a transaction' }))).toBe(
      'failed — cannot start a transaction',
    );
    expect(eventSummary(ev(2, { type: 'batch.progress', data: { status: 'success', records: 4 } }))).toBe(
      'batch success · 4 row(s)',
    );
  });

  it('offers detail only when the data says more than the summary', () => {
    expect(hasDetail(ev(1, { data: { status: 'running' } }))).toBe(false);
    expect(hasDetail(ev(2, { type: 'batch.sample', data: { records: [{ id: 1 }] } }))).toBe(true);
  });

  it('formats durations for a reader', () => {
    expect(formatDuration(248)).toBe('248 ms');
    expect(formatDuration(2_400)).toBe('2.4 s');
    expect(formatDuration(185_000)).toBe('3 m 05 s');
    expect(formatDuration(undefined)).toBe('');
  });

  it('writes a downloadable log with a header and the failing line', () => {
    const run: RunRecord = {
      id: '653bc269-97ee',
      workflowId: 'overnight-multi-db-join',
      workflowVersion: 1,
      status: 'failed',
      trigger: 'manual',
      startedAt: '2026-11-22T05:17:59.007Z',
      finishedAt: '2026-11-22T05:17:59.255Z',
      error: 'cannot start a transaction within a transaction',
    };
    const text = runLogText(run, [
      ev(1, { type: 'run.status', data: { status: 'queued' } }),
      ev(20, {
        pipelineId: 'fetch',
        pipeId: 'stage',
        data: { status: 'failed' },
        message: 'cannot start a transaction within a transaction',
      }),
    ]);
    expect(text).toContain('Workflow overnight-multi-db-join v1');
    expect(text).toContain('Status failed — cannot start a transaction within a transaction');
    expect(text).toContain('(248 ms)');
    expect(text).toContain('#1 2026-11-22T05:17:59.254Z INFO  run — queued');
    expect(text).toContain('#20 2026-11-22T05:17:59.254Z ERROR pipe fetch/stage — failed — cannot start a transaction within a transaction');
  });
});
