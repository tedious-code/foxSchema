/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VersionTimeline } from './VersionTimeline';

const V = (
  number: number,
  extras: {
    added?: number;
    modified?: number;
    removed?: number;
    changeCount?: number;
    name?: string;
    description?: string;
    author?: string;
  } = {}
) => ({
  id: `v${number}`,
  number,
  createdAt: '2026-09-07T00:00:00.000Z',
  rootHash: `h${number}`,
  ...extras,
});

describe('VersionTimeline', () => {
  it('draws stacked + / ~ / − ticks from the version DTO', () => {
    render(
      <VersionTimeline
        versions={[V(2, { added: 2, modified: 1, removed: 3 }), V(1, { added: 4 })]}
        totalVersions={2}
      />
    );
    const ticks = screen.getAllByTestId('lokee-change-ticks');
    expect(ticks).toHaveLength(2);
    expect(ticks[0]!.querySelectorAll('rect')).toHaveLength(3);
    expect(screen.getByTestId('lokee-timeline-v-2').textContent).toContain('6 changes');
  });

  it('selects a version without loading the graph', () => {
    const onSelect = vi.fn();
    render(
      <VersionTimeline versions={[V(1, { added: 1 })]} totalVersions={1} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByTestId('lokee-timeline-v-1'));
    expect(onSelect).toHaveBeenCalledWith('v1');
  });

  it('filters versions by label, author, or version number and clears search', () => {
    render(
      <VersionTimeline
        versions={[
          V(2, { name: 'Billing release', author: 'alice' }),
          V(1, { name: 'Initial baseline', author: 'bob' }),
        ]}
        totalVersions={2}
      />
    );
    fireEvent.change(screen.getByTestId('lokee-timeline-search'), {
      target: { value: 'billing' },
    });
    expect(screen.getByTestId('lokee-timeline-v-2')).toBeTruthy();
    expect(screen.queryByTestId('lokee-timeline-v-1')).toBeNull();

    fireEvent.click(screen.getByTestId('lokee-timeline-search-clear'));
    expect(screen.getByTestId('lokee-timeline-v-1')).toBeTruthy();
  });

  it('edits version label and notes inline directly from the timeline', async () => {
    const onSaveVersionMeta = vi.fn().mockResolvedValue(undefined);
    render(
      <VersionTimeline
        versions={[V(2, { name: 'Old label', description: 'Old note' })]}
        totalVersions={1}
        onSaveVersionMeta={onSaveVersionMeta}
      />
    );

    fireEvent.click(screen.getByTestId('lokee-timeline-edit-2'));
    fireEvent.change(screen.getByTestId('lokee-timeline-edit-name'), {
      target: { value: 'Pre-deploy checkpoint' },
    });
    fireEvent.change(screen.getByTestId('lokee-timeline-edit-desc'), {
      target: { value: 'Verified on staging' },
    });
    fireEvent.click(screen.getByTestId('lokee-timeline-edit-save'));

    await waitFor(() => {
      expect(onSaveVersionMeta).toHaveBeenCalledWith('v2', {
        name: 'Pre-deploy checkpoint',
        description: 'Verified on staging',
      });
    });
  });
});
