/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '../lib/catalog';
import { Input, Select } from './controls';
import { Inspector } from './Inspector';
import type { PipeData } from './PipeNode';
import { PIPE_NAME_MAX_LENGTH } from '@foxschema/shared';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Monaco" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('../lib/jsonEditorOptions', () => ({ JSON_EDITOR_OPTIONS: {}, useJsonEditorTheme: () => 'vs' }));
vi.mock('./SqlPipeEditor', () => ({ SqlPipeEditor: () => <div data-testid="sql-editor" /> }));
vi.mock('./CronSqlEditor', () => ({ CronSqlEditor: () => <div data-testid="cron-sql-editor" /> }));
vi.mock('./HttpRequestEditor', () => ({
  EMPTY_HTTP_REQUEST: { method: 'GET', url: '', query: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' } },
  HttpRequestEditor: () => <div data-testid="http-editor" />,
  toHttpRequestValue: (v: unknown) => v,
}));
vi.mock('./MultiHttpEditor', () => ({ MultiHttpEditor: () => <div data-testid="multi-http-editor" /> }));
vi.mock('./DelimitedSourceEditor', () => ({ DelimitedSourceEditor: () => <div data-testid="delimited-editor" /> }));

const CATALOG: CatalogEntry[] = [
  {
    type: 'transform.verify',
    role: 'transform',
    label: 'Verify',
    category: 'Transform',
    version: '0.1.0',
    configSchema: { type: 'object', properties: {} },
    inputs: [{ name: 'in', type: 'records' }],
    outputs: [{ name: 'out', type: 'records' }, { name: 'rejects', type: 'records' }],
  },
  {
    type: 'sink.file.delimited',
    role: 'sink',
    label: 'CSV / Delimited file',
    category: 'Output/File',
    version: '0.1.0',
    configSchema: { type: 'object', properties: {} },
    inputs: [{ name: 'in', type: 'records' }],
    outputs: [],
  },
  {
    type: 'transform.condition',
    role: 'transform',
    label: 'Condition',
    category: 'Transform',
    version: '0.1.0',
    configSchema: { type: 'object', properties: {} },
    inputs: [{ name: 'in', type: 'records' }],
    outputs: [{ name: 'true', type: 'records' }, { name: 'false', type: 'records' }],
  },
  {
    type: 'transform.map',
    role: 'transform',
    label: 'Map',
    category: 'Transform',
    version: '0.1.0',
    configSchema: { type: 'object', properties: {} },
    inputs: [{ name: 'in', type: 'records' }],
    outputs: [{ name: 'out', type: 'records' }],
  },
];

function makeData(type: string, config: Record<string, unknown>): PipeData {
  return {
    pipelineId: 'main',
    pipeId: 'node_1',
    role: type.startsWith('sink.') ? 'sink' : 'transform',
    type,
    config: JSON.stringify(config, null, 2),
    concurrency: 1,
    retryAttempts: 0,
    credentialId: '',
    inputs: [{ name: 'in', type: 'records' }],
    outputs: [{ name: 'out', type: 'records' }],
  };
}

function renderInspector(data: PipeData, onChange = vi.fn()) {
  return {
    onChange,
    ...render(
      <Inspector
        pipeId={data.pipeId}
        data={data}
        credentials={[]}
        categories={[]}
        catalog={CATALOG}
        triggers={[{ id: 'manual', kind: 'manual', enabled: true }]}
        workflowId="wf-1"
        workflows={[]}
        onChange={onChange}
        onTriggersChange={vi.fn()}
        onEditTrigger={vi.fn()}
      />,
    ),
  };
}

describe('Inspector pipe editors', () => {
  it('renders Verify rule builder and adds a rule', () => {
    const onChange = vi.fn();
    renderInspector(
      makeData('transform.verify', {
        rules: [{ field: 'population', op: 'gte', value: 10000, message: 'Too small' }],
        onInvalid: 'reject',
        minScore: 1,
        outputField: 'verification',
      }),
      onChange,
    );

    expect((screen.getByLabelText('Verify rule 1 field') as HTMLInputElement).value).toBe('population');
    expect((screen.getByLabelText('Verify rule 1 operator') as HTMLSelectElement).value).toBe('gte');
    expect((screen.getByLabelText('Verify rule 1 value') as HTMLInputElement).value).toBe('10000');
    expect((screen.getByLabelText('Verify rule 1 message') as HTMLInputElement).value).toBe('Too small');

    fireEvent.click(screen.getByText('+ Add verification rule'));
    const nextConfig = JSON.parse(onChange.mock.calls[0]![1].config);
    expect(nextConfig.rules).toHaveLength(2);
    expect(nextConfig.rules[1]).toEqual({ field: 'id', op: 'exists' });
  });

  it('renders Delimited file sink editor and parses comma-separated columns', () => {
    const onChange = vi.fn();
    renderInspector(
      makeData('sink.file.delimited', {
        path: 'out.csv',
        columns: ['city', 'country'],
        mode: 'overwrite',
        delimiter: ',',
      }),
      onChange,
    );

    expect((screen.getByLabelText('Output file path') as HTMLInputElement).value).toBe('out.csv');
    expect((screen.getByLabelText('Output columns') as HTMLInputElement).value).toBe('city, country');

    fireEvent.change(screen.getByLabelText('Output columns'), { target: { value: 'city, country, temp_c' } });
    const nextConfig = JSON.parse(onChange.mock.calls[0]![1].config);
    expect(nextConfig.columns).toEqual(['city', 'country', 'temp_c']);
  });

  it('normalizes legacy `op` alias on Condition pipe and replaces `op` on change', () => {
    const onChange = vi.fn();
    renderInspector(
      makeData('transform.condition', { field: 'amount', op: 'gt', value: 0 }),
      onChange,
    );

    const select = screen.getByLabelText('Condition operator') as HTMLSelectElement;
    expect(select.value).toBe('greaterThan');

    fireEvent.change(select, { target: { value: 'lessThanOrEqual' } });
    const nextConfig = JSON.parse(onChange.mock.calls[0]![1].config);
    expect(nextConfig).toEqual({ field: 'amount', value: 0, operator: 'lessThanOrEqual' });
  });

  it('defaults Map pipe Keep original fields checkbox to true', () => {
    renderInspector(
      makeData('transform.map', { mappings: { email: 'user.email' } }),
    );
    const checkbox = screen.getByLabelText('Keep original fields on each record') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('commits Pipe name changes immediately on input and trims trailing whitespace on blur', () => {
    const onChange = vi.fn();
    const data = makeData('transform.map', { mappings: {} });
    data.name = 'Initial Pipe Name';
    renderInspector(data, onChange);

    const idInput = screen.getByLabelText('Pipe id') as HTMLInputElement;
    expect(idInput.value).toBe('node_1');
    expect(idInput.readOnly).toBe(true);

    const nameInput = screen.getByLabelText('Pipe name') as HTMLInputElement;
    expect(nameInput.value).toBe('Initial Pipe Name');

    fireEvent.change(nameInput, { target: { value: '  Renamed Pipe  ' } });
    expect(onChange).toHaveBeenCalledWith('node_1', { name: '  Renamed Pipe  ' });

    fireEvent.blur(nameInput);
    expect(onChange).toHaveBeenCalledWith('node_1', { name: 'Renamed Pipe' });
  });

  it('omits w-full when workflow Select or Input provides an explicit width utility', () => {
    render(
      <div>
        <Select aria-label="Toolbar select" className="w-auto stage-select">
          <option value="main">Main</option>
        </Select>
        <Input aria-label="Toolbar input" className="w-[220px] workflow-name-input" defaultValue="wf" />
        <Select aria-label="Default select">
          <option value="1">One</option>
        </Select>
      </div>,
    );
    expect(screen.getByLabelText('Toolbar select').className).not.toMatch(/\bw-full\b/);
    expect(screen.getByLabelText('Toolbar select').className).toMatch(/\bw-auto\b/);
    expect(screen.getByLabelText('Toolbar input').className).not.toMatch(/\bw-full\b/);
    expect(screen.getByLabelText('Default select').className).toMatch(/\bw-full\b/);
  });

  it('stops the pipe name at the length the engine accepts', () => {
    renderInspector(makeData('transform.map', { mappings: {} }));

    const nameInput = screen.getByLabelText('Pipe name') as HTMLInputElement;
    expect(nameInput.maxLength).toBe(PIPE_NAME_MAX_LENGTH);
  });

  it('inserts starter transform.script snippets and formats raw JSON config', () => {
    const scriptCatalog: CatalogEntry = {
      type: 'transform.script',
      role: 'transform',
      label: 'Script',
      category: 'Transform',
      version: '0.1.0',
      configSchema: { type: 'object', properties: { script: { type: 'string' } } },
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
    };
    const onChange = vi.fn();
    render(
      <Inspector
        pipeId="script_1"
        data={makeData('transform.script', { script: 'return records;' })}
        credentials={[]}
        categories={[]}
        catalog={[...CATALOG, scriptCatalog]}
        triggers={[{ id: 'manual', kind: 'manual', enabled: true }]}
        workflowId="wf-1"
        workflows={[]}
        onChange={onChange}
        onTriggersChange={vi.fn()}
        onEditTrigger={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('workflow-script-snippet-dedupe'));
    expect(JSON.parse(onChange.mock.calls[0]![1].config).script).toContain('seen.has(key)');

    fireEvent.click(screen.getByTestId('workflow-inspector-show-raw'));
    fireEvent.click(screen.getByTestId('workflow-inspector-format-raw'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('renders visual editors for transform.dedupe, transform.aggregate, and transform.redact pipes', () => {
    const newCatalog: CatalogEntry[] = [
      ...CATALOG,
      {
        type: 'transform.dedupe',
        role: 'transform',
        label: 'Deduplicate',
        category: 'Transform',
        version: '0.1.0',
        configSchema: { type: 'object', properties: { keys: { type: 'array' }, keep: { type: 'string' } } },
        inputs: [{ name: 'in', type: 'records' }],
        outputs: [{ name: 'out', type: 'records' }, { name: 'rejects', type: 'records' }],
      },
      {
        type: 'transform.aggregate',
        role: 'transform',
        label: 'Aggregate',
        category: 'Transform',
        version: '0.1.0',
        configSchema: { type: 'object', properties: { groupBy: { type: 'array' }, metrics: { type: 'array' } } },
        inputs: [{ name: 'in', type: 'records' }],
        outputs: [{ name: 'out', type: 'records' }],
      },
      {
        type: 'transform.redact',
        role: 'transform',
        label: 'Redact PII',
        category: 'Transform',
        version: '0.1.0',
        configSchema: { type: 'object', properties: { fields: { type: 'array' }, strategy: { type: 'string' } } },
        inputs: [{ name: 'in', type: 'records' }],
        outputs: [{ name: 'out', type: 'records' }],
      },
    ];

    const onDedupeChange = vi.fn();
    const { unmount: u1 } = render(
      <Inspector
        pipeId="d1"
        data={makeData('transform.dedupe', { keys: ['id'], keep: 'last' })}
        credentials={[]}
        categories={[]}
        catalog={newCatalog}
        triggers={[]}
        workflowId="wf-1"
        workflows={[]}
        onChange={onDedupeChange}
        onTriggersChange={vi.fn()}
        onEditTrigger={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('workflow-dedupe-keys'), { target: { value: 'tenant_id, user_id' } });
    expect(JSON.parse(onDedupeChange.mock.calls[0]![1].config).keys).toEqual(['tenant_id', 'user_id']);
    u1();

    const onAggChange = vi.fn();
    const { unmount: u2 } = render(
      <Inspector
        pipeId="a1"
        data={makeData('transform.aggregate', { groupBy: ['region'], metrics: [{ fn: 'count', as: 'rows' }] })}
        credentials={[]}
        categories={[]}
        catalog={newCatalog}
        triggers={[]}
        workflowId="wf-1"
        workflows={[]}
        onChange={onAggChange}
        onTriggersChange={vi.fn()}
        onEditTrigger={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('workflow-aggregate-add-metric'));
    expect(JSON.parse(onAggChange.mock.calls[0]![1].config).metrics).toHaveLength(2);
    u2();

    const onRedactChange = vi.fn();
    render(
      <Inspector
        pipeId="r1"
        data={makeData('transform.redact', { fields: ['email'], strategy: 'mask' })}
        credentials={[]}
        categories={[]}
        catalog={newCatalog}
        triggers={[]}
        workflowId="wf-1"
        workflows={[]}
        onChange={onRedactChange}
        onTriggersChange={vi.fn()}
        onEditTrigger={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('workflow-redact-strategy'), { target: { value: 'hash' } });
    expect(JSON.parse(onRedactChange.mock.calls[0]![1].config).strategy).toBe('hash');
  });
});
