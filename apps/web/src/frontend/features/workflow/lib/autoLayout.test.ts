/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { layoutPipeline } from './autoLayout';
import {
  configProblem,
  failureOrigins,
  isFailedStatus,
  isStoppedStatus,
  stoppedByPipe,
  validationTarget,
} from './pipeIssues';

const n = (...ids: string[]) => ids.map((id) => ({ id }));
const e = (source: string, target: string, sourceHandle?: string) => ({ source, target, sourceHandle });

describe('layoutPipeline', () => {
  it('puts each pipe one column after its furthest upstream pipe', () => {
    // start → check → (true) paid → join ; check → (false) other → join ; start → join
    const pos = layoutPipeline(n('join', 'other', 'paid', 'check', 'start'), [
      e('start', 'check'),
      e('check', 'paid', 'true'),
      e('check', 'other', 'false'),
      e('paid', 'join'),
      e('other', 'join'),
      e('start', 'join'),
    ]);
    const x = (id: string) => pos.get(id)!.x;
    expect(x('start')).toBeLessThan(x('check'));
    expect(x('check')).toBeLessThan(x('paid'));
    expect(x('paid')).toBe(x('other'));
    // join waits for the deepest branch, not the direct start → join edge
    expect(x('join')).toBeGreaterThan(x('paid'));
  });

  it('stacks the true branch above the false one, and out above rejects', () => {
    const branches = layoutPipeline(n('no', 'yes', 'if'), [e('if', 'no', 'false'), e('if', 'yes', 'true')]);
    expect(branches.get('yes')!.y).toBeLessThan(branches.get('no')!.y);
    const verify = layoutPipeline(n('bad', 'good', 'v'), [e('v', 'bad', 'rejects'), e('v', 'good', 'out')]);
    expect(verify.get('good')!.y).toBeLessThan(verify.get('bad')!.y);
  });

  it('gives every pipe its own spot, and lays out a cycle instead of looping', () => {
    const pos = layoutPipeline(n('a', 'b', 'c', 'lonely'), [e('a', 'b'), e('b', 'c'), e('c', 'a')]);
    expect(pos.size).toBe(4);
    const spots = new Set([...pos.values()].map((p) => `${p.x},${p.y}`));
    expect(spots.size).toBe(4);
  });

  it('spaces a column by the measured node heights', () => {
    const pos = layoutPipeline([{ id: 'src' }, { id: 'tall', height: 200 }, { id: 'next', height: 50 }], [
      e('src', 'tall'),
      e('src', 'next'),
    ], { rowGap: 10 });
    expect(pos.get('next')!.y - pos.get('tall')!.y).toBe(210);
  });

  it('is stable: laying out the same graph twice gives the same positions', () => {
    const nodes = n('a', 'b', 'c', 'd');
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')];
    expect([...layoutPipeline(nodes, edges)]).toEqual([...layoutPipeline(nodes, edges)]);
  });
});

describe('pipe issues', () => {
  it('reads the pipe a validation error names', () => {
    expect(validationTarget('pipeline ingest, pipe fetch_geo: url is required')).toEqual({
      pipelineId: 'ingest',
      pipeId: 'fetch_geo',
      detail: 'url is required',
    });
    expect(validationTarget('pipeline main: has no root pipe')).toEqual({
      pipelineId: 'main',
      detail: 'has no root pipe',
    });
    expect(validationTarget('webhook path "/x" is already used')).toBeNull();
  });

  it('blames the pipe that threw, not the upstream pipes the engine also marks failed', () => {
    // start → check → route → paid → join; route → other. Only paid threw, but
    // the engine records start, check and route as failed with its message.
    const boom = 'sandboxed code failed: boom';
    const failed = new Map([['start', boom], ['check', boom], ['route', boom], ['paid', boom]]);
    const edges = [e('start', 'check'), e('check', 'route'), e('route', 'paid'), e('route', 'other'), e('paid', 'join')];
    expect(Object.fromEntries(failureOrigins(failed, edges))).toEqual({
      start: 'paid',
      check: 'paid',
      route: 'paid',
      paid: 'paid',
    });
    // Two different errors are two different causes.
    const two = failureOrigins(new Map([['a', 'x'], ['b', 'y']]), [e('a', 'b')]);
    expect(Object.fromEntries(two)).toEqual({ a: 'a', b: 'b' });
  });

  it('flags failed statuses and unsavable config', () => {
    expect(isFailedStatus('failed')).toBe(true);
    expect(isFailedStatus('success')).toBe(false);
    expect(isFailedStatus(undefined)).toBe(false);
    // The engine records a pipe stopped by a downstream failure as cancelled.
    expect(isFailedStatus('cancelled')).toBe(false);
    expect(isStoppedStatus('cancelled')).toBe(true);
    expect(stoppedByPipe('Stopped because pipe paid failed.')).toBe('paid');
    expect(stoppedByPipe('The operation was aborted.')).toBeUndefined();
    expect(configProblem('{"a":1}')).toBeNull();
    expect(configProblem('{"a":')).toMatch(/not valid JSON/);
    expect(configProblem('[1]')).toBe('Config must be a JSON object.');
  });
});
