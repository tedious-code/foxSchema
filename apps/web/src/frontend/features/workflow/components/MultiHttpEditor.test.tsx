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
          expect.objectContaining({ id: 'endpoint-2' }),
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
  });

  it('generates a unique non-colliding ID when endpoint-2 already exists', () => {
    const onChange = vi.fn();
    render(
      <MultiHttpEditor
        config={{
          endpoints: [
            { id: 'endpoint-2', url: 'https://example.test/a' },
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
          expect.objectContaining({ id: 'endpoint-2' }),
          expect.objectContaining({ id: 'endpoint-1' }),
        ]),
      }),
    );
  });
});
