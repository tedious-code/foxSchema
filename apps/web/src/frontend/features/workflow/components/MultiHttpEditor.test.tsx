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
});
