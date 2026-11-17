/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createTrigger } from '../lib/triggers';
import { TriggerInlineSettings } from './TriggerInlineSettings';

describe('TriggerInlineSettings · manual Run button', () => {
  const manual = createTrigger('manual', 'manual');

  it('runs with the input data when allowed', () => {
    const onRun = vi.fn();
    render(<TriggerInlineSettings trigger={manual} credentials={[]} onChange={() => {}} onRun={onRun} runBlocked={null} />);
    fireEvent.click(screen.getByTestId('workflow-trigger-settings-run'));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('is off, and says why, when the designer cannot run this trigger', () => {
    render(
      <TriggerInlineSettings
        trigger={manual}
        credentials={[]}
        onChange={() => {}}
        onRun={() => {}}
        runBlocked="A Test run starts the first enabled manual trigger (other)."
      />,
    );
    expect((screen.getByTestId('workflow-trigger-settings-run') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/first enabled manual trigger/)).toBeTruthy();
  });

  it('is off while the input data is not valid JSON', () => {
    render(<TriggerInlineSettings trigger={manual} credentials={[]} onChange={() => {}} onRun={() => {}} runBlocked={null} />);
    fireEvent.change(screen.getByTestId('workflow-trigger-settings-input'), { target: { value: '[{"id":' } });
    expect((screen.getByTestId('workflow-trigger-settings-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no Run button where the designer passes no handler', () => {
    render(<TriggerInlineSettings trigger={manual} credentials={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('workflow-trigger-settings-run')).toBeNull();
  });
});
