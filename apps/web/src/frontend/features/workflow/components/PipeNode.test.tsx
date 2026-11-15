/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PipeData } from './PipeNode';
import { PipeNode, pipeSummary } from './PipeNode';

vi.mock('@xyflow/react', () => ({
  Handle: ({ id, title }: { id: string; title?: string }) => (
    <div data-testid={`handle-${id}`} title={title} />
  ),
  Position: { Left: 'left', Right: 'right' },
}));

function pipeData(overrides: Partial<PipeData> = {}): PipeData {
  return {
    pipelineId: 'main',
    pipeId: 'step_1',
    role: 'transform',
    type: 'transform.map',
    config: '{}',
    concurrency: 1,
    retryAttempts: 0,
    credentialId: '',
    inputs: [{ name: 'in', type: 'records' }],
    outputs: [{ name: 'out', type: 'records' }],
    ...overrides,
  };
}

function renderNode(overrides: Partial<PipeData> = {}) {
  const data = pipeData(overrides);
  return render(
    <PipeNode
      id={data.pipeId}
      data={data}
      type="pipe"
      selected={false}
      dragging={false}
      draggable
      selectable
      deletable
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
    />,
  );
}

describe('pipeSummary', () => {
  it('summarizes HTTP single and multi-endpoint pipes', () => {
    expect(
      pipeSummary('source.api.http', JSON.stringify({ method: 'GET', url: 'https://api.open-meteo.com/v1/forecast' })),
    ).toBe('GET api.open-meteo.com/v1/forecast');
    expect(
      pipeSummary(
        'transform.http',
        JSON.stringify({ request: { method: 'POST', url: 'https://example.test/enrich' } }),
      ),
    ).toBe('POST example.test/enrich');
    expect(
      pipeSummary(
        'source.api.http.multi',
        JSON.stringify({ endpoints: [{ id: 'a', url: 'https://a.test' }, { id: 'b', url: 'https://b.test' }] }),
      ),
    ).toBe('2 parallel endpoints');
  });

  it('summarizes SQL and delimited file pipes', () => {
    expect(
      pipeSummary('sink.db.sql', JSON.stringify({ dialect: 'postgres', mode: 'insert', table: 'wf_cities' })),
    ).toBe('postgres · INSERT → wf_cities');
    expect(
      pipeSummary(
        'sink.file.delimited',
        JSON.stringify({ path: 'cities.csv', columns: ['city'], mode: 'overwrite' }),
      ),
    ).toBe('write: cities.csv (overwrite)');
    expect(
      pipeSummary('source.file.csv', JSON.stringify({ path: 'cities.csv' })),
    ).toBe('read: cities.csv');
  });

  it('summarizes verify, condition (operator & op), map, split, and loop pipes', () => {
    expect(
      pipeSummary(
        'transform.verify',
        JSON.stringify({ rules: [{ field: 'a', op: 'exists' }, { field: 'b', op: 'gt', value: 1 }], onInvalid: 'reject' }),
      ),
    ).toBe('2 rules · reject');
    expect(
      pipeSummary('transform.condition', JSON.stringify({ field: 'temp_c', operator: 'greaterThanOrEqual', value: 15 })),
    ).toBe('if temp_c greaterThanOrEqual 15');
    expect(
      pipeSummary('transform.condition', JSON.stringify({ field: 'amount', op: 'gt', value: 0 })),
    ).toBe('if amount gt 0');
    expect(
      pipeSummary('transform.map', JSON.stringify({ mappings: { a: 'x', b: 'y', c: 'z', d: 'w' } })),
    ).toBe('map: a, b, c (+1)');
    expect(
      pipeSummary('transform.split', JSON.stringify({ field: '_endpoint' })),
    ).toBe('split by: _endpoint');
    expect(
      pipeSummary('logic.loop', JSON.stringify({ size: 5 })),
    ).toBe('chunk size: 5');
  });
});

describe('PipeNode', () => {
  it('renders role badge, pipe id, config summary, and named output port labels', () => {
    renderNode({
      pipeId: 'verify_city',
      role: 'transform',
      type: 'transform.verify',
      intent: 'Check population >= 10000',
      config: JSON.stringify({
        rules: [{ field: 'population', op: 'gte', value: 10000 }],
        onInvalid: 'reject',
      }),
      outputs: [
        { name: 'out', type: 'records' },
        { name: 'rejects', type: 'records' },
      ],
    });

    expect(screen.getByText('verify_city')).toBeTruthy();
    expect(screen.getByText('transform.verify')).toBeTruthy();
    expect(screen.getByText('1 rule · reject')).toBeTruthy();
    expect(screen.getByText('Out')).toBeTruthy();
    expect(screen.getByText('Rejects')).toBeTruthy();
  });
});
