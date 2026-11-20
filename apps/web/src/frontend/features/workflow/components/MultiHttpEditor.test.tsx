/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MultiHttpEditor } from './MultiHttpEditor';

describe('MultiHttpEditor', () => {
  it('renders default fields for multi-http endpoints', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [{ id: 'users', url: 'https://example.test/users' }],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    expect((screen.getByTestId('workflow-multi-http-output-mode') as HTMLSelectElement).value).toBe('records');
    expect((screen.getByTestId('workflow-multi-http-execution-mode') as HTMLSelectElement).value).toBe('parallel');
    expect((screen.getByTestId('workflow-multi-http-on-error') as HTMLSelectElement).value).toBe('fail');
    expect((screen.getByTestId('workflow-multi-http-concurrency') as HTMLInputElement).value).toBe('0');
    expect((screen.getByTestId('workflow-multi-http-tag-field') as HTMLInputElement).value).toBe('_endpoint');
    expect((screen.getByTestId('workflow-multi-http-batch-size') as HTMLInputElement).value).toBe('1000');
  });

  it('switches to merged payload output mode and updates config', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'users', url: 'https://example.test/users' },
            { id: 'orders', url: 'https://example.test/orders' },
          ],
          outputMode: 'records',
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const outputModeSelect = screen.getByTestId('workflow-multi-http-output-mode');
    fireEvent.change(outputModeSelect, { target: { value: 'merge' } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: 'merge',
      }),
    );
  });

  it('hides tag-field and batch-size in merge outputMode', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [{ id: 'users', url: 'https://example.test/users' }],
          outputMode: 'merge',
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    expect(screen.queryByTestId('workflow-multi-http-tag-field')).toBeNull();
    expect(screen.queryByTestId('workflow-multi-http-batch-size')).toBeNull();
  });

  it('switches execution mode to linear and on-error to skip', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [{ id: 'users', url: 'https://example.test/users' }],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const execSelect = screen.getByTestId('workflow-multi-http-execution-mode');
    fireEvent.change(execSelect, { target: { value: 'linear' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'linear',
      }),
    );

    const errSelect = screen.getByTestId('workflow-multi-http-on-error');
    fireEvent.change(errSelect, { target: { value: 'skip' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        onError: 'skip',
      }),
    );
  });

  it('adds a new endpoint on button click', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [{ id: 'first', url: 'https://example.test/first' }],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('workflow-multi-http-add-endpoint'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: expect.arrayContaining([
          expect.objectContaining({ id: 'first' }),
          expect.objectContaining({ id: 'output1' }),
        ]),
      }),
    );
  });

  it('removes an endpoint on delete click', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'first', url: 'https://example.test/first' },
            { id: 'second', url: 'https://example.test/second' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('workflow-multi-http-remove-0'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [expect.objectContaining({ id: 'second', url: 'https://example.test/second' })],
      }),
    );
  });

  it('reorders endpoints with move-up and move-down buttons', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'first', url: 'https://example.test/first' },
            { id: 'second', url: 'https://example.test/second' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    // First endpoint cannot move up
    expect((screen.getByTestId('workflow-multi-http-move-up-0') as HTMLButtonElement).disabled).toBe(true);
    // Second endpoint cannot move down
    expect((screen.getByTestId('workflow-multi-http-move-down-1') as HTMLButtonElement).disabled).toBe(true);

    // Move first endpoint down
    fireEvent.click(screen.getByTestId('workflow-multi-http-move-down-0'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [
          expect.objectContaining({ id: 'second' }),
          expect.objectContaining({ id: 'first' }),
        ],
      }),
    );
  });

  it('detects duplicate endpoint IDs and displays duplicate badge and error message', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'dup-id', url: 'https://example.test/first' },
            { id: 'dup-id', url: 'https://example.test/second' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    expect(screen.getByTestId('workflow-multi-http-dup-badge-0')).toBeDefined();
    expect(screen.getByTestId('workflow-multi-http-dup-badge-1')).toBeDefined();
    expect(screen.getByTestId('workflow-multi-http-dup-error-0').textContent).toContain(
      'Duplicate ID "dup-id". Must be unique.',
    );
  });

  it('flags missing endpoint URLs with an indicator badge', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'good', url: 'https://example.test/good' },
            { id: 'missing', url: '' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    expect(screen.queryByTestId('workflow-multi-http-empty-url-badge-0')).toBeNull();
    expect(screen.getByTestId('workflow-multi-http-empty-url-badge-1')).toBeDefined();
  });

  it('renders merge helper explanation when outputMode is merge', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'forecast', url: 'https://example.test/forecast' },
            { id: 'alerts', url: 'https://example.test/alerts' },
          ],
          outputMode: 'merge',
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const helper = screen.getByTestId('workflow-multi-http-merge-helper');
    expect(helper).toBeDefined();
    expect(helper.textContent).toContain('Merged payload structure');
    expect(helper.textContent).toContain('records[0].forecast');
    // Values are response bodies (often objects), not arrays.
    expect(helper.textContent).not.toContain('[...]');
  });

  it('suggests bracket access in the merge helper when the id is not a JS identifier', () => {
    render(
      <MultiHttpEditor
        config={{
          endpoints: [{ id: 'endpoint-1', url: 'https://example.test/a' }],
          outputMode: 'merge',
        }}
        credentials={[]}
        onChange={vi.fn()}
      />,
    );
    const helper = screen.getByTestId('workflow-multi-http-merge-helper');
    expect(helper.textContent).toContain('records[0]["endpoint-1"]');
    expect(helper.textContent).not.toContain('records[0].endpoint-1');
  });

  it('keeps default-open rows open when an endpoint is moved', () => {
    const onChange = vi.fn();
    const endpoints = [
      { id: 'a', url: 'https://example.test/a' },
      { id: 'b', url: 'https://example.test/b' },
      { id: 'c', url: 'https://example.test/c' },
    ];
    const { rerender } = render(
      <MultiHttpEditor config={{ endpoints }} credentials={[]} onChange={onChange} />,
    );
    // Every row starts open.
    expect(screen.queryByTestId('workflow-multi-http-id-2')).not.toBeNull();

    fireEvent.click(screen.getByTestId('workflow-multi-http-move-down-0'));
    const moved = onChange.mock.calls.at(-1)![0] as Record<string, unknown>;
    rerender(<MultiHttpEditor config={moved} credentials={[]} onChange={onChange} />);

    for (const index of [0, 1, 2]) {
      expect(screen.queryByTestId(`workflow-multi-http-id-${index}`), `row ${index}`).not.toBeNull();
    }
  });

  it('keeps each row\'s own open/closed state when an earlier row is removed', () => {
    const onChange = vi.fn();
    const endpoints = [
      { id: 'a', url: 'https://example.test/a' },
      { id: 'b', url: 'https://example.test/b' },
      { id: 'c', url: 'https://example.test/c' },
    ];
    const { rerender } = render(
      <MultiHttpEditor config={{ endpoints }} credentials={[]} onChange={onChange} />,
    );
    // Collapse row 1 ('b'), then remove row 0 ('a').
    fireEvent.click(screen.getByTestId('workflow-multi-http-toggle-1'));
    expect(screen.queryByTestId('workflow-multi-http-id-1')).toBeNull();

    fireEvent.click(screen.getByTestId('workflow-multi-http-remove-0'));
    const removed = onChange.mock.calls.at(-1)![0] as Record<string, unknown>;
    rerender(<MultiHttpEditor config={removed} credentials={[]} onChange={onChange} />);

    // 'b' is now row 0 and stays collapsed; 'c' is row 1 and stays open.
    expect(screen.queryByTestId('workflow-multi-http-id-0')).toBeNull();
    expect(screen.queryByTestId('workflow-multi-http-id-1')).not.toBeNull();
  });

  it('generates a unique non-colliding ID when output2 already exists', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'output2', url: 'https://example.test/a' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('workflow-multi-http-add-endpoint'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: expect.arrayContaining([
          expect.objectContaining({ id: 'output2' }),
          expect.objectContaining({ id: 'output1' }),
        ]),
      }),
    );
  });

  it('allows setting default response naming to resp and renames default endpoints', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          responseNaming: 'output',
          endpoints: [
            { id: 'output1', url: 'https://example.test/a' },
            { id: 'output2', url: 'https://example.test/b' },
            { id: 'custom_service', url: 'https://example.test/c' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const select = screen.getByTestId('workflow-multi-http-response-naming') as HTMLSelectElement;
    expect(select.value).toBe('output');

    fireEvent.change(select, { target: { value: 'resp' } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        responseNaming: 'resp',
        endpoints: [
          expect.objectContaining({ id: 'resp1' }),
          expect.objectContaining({ id: 'resp2' }),
          expect.objectContaining({ id: 'custom_service' }), // preserved!
        ],
      }),
    );
  });

  it('allows modifying default response name per request directly in input', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'output1', url: 'https://example.test/users' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const idInput = screen.getByTestId('workflow-multi-http-id-0');
    fireEvent.change(idInput, { target: { value: 'users_list' } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [
          expect.objectContaining({ id: 'users_list' }),
        ],
      }),
    );
  });

  it('derives endpoint response name from request URL when clicking From URL', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'output1', url: 'https://api.github.com/v1/repositories' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const deriveBtn = screen.getByTestId('workflow-multi-http-derive-name-0');
    fireEvent.click(deriveBtn);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [
          expect.objectContaining({ id: 'repositories' }),
        ],
      }),
    );
  });

  it('ensures derived response name is unique when another endpoint shares the name', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'users', url: 'https://api.github.com/v1/users' },
            { id: 'output2', url: 'https://other-service.test/api/users' },
          ],
        }}
        credentials={[]}
        onChange={onChange}
      />,
    );

    const deriveBtn = screen.getByTestId('workflow-multi-http-derive-name-1');
    fireEvent.click(deriveBtn);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [
          expect.objectContaining({ id: 'users' }),
          expect.objectContaining({ id: 'users_2' }),
        ],
      }),
    );
  });
});
