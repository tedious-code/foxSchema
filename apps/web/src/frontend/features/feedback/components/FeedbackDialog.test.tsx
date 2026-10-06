/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const connections = [
  { id: 'a', name: 'Prod', dialect: 'postgres', host: 'prod-db.internal', database: 'billing' },
  { id: 'b', name: 'Warehouse', dialect: 'snowflake-like', host: 'wh.internal', database: 'dw' },
  { id: 'c', name: 'Other PG', dialect: 'postgres', host: 'pg2.internal', database: 'crm' },
];
vi.mock('@/app/store/useSyncStore', () => ({
  useSyncStore: (sel: (s: { connections: typeof connections }) => unknown) => sel({ connections }),
}));
vi.mock('@/app/store/uiStore', () => ({
  useUiStore: (sel: (s: { activeView: string }) => unknown) => sel({ activeView: 'sqlEditor' }),
}));

import { FeedbackDialog } from './FeedbackDialog';

const opened = vi.fn();
beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation((...args) => {
    opened(...args);
    return null;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  opened.mockReset();
});

const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });
const openButton = () => screen.getByTestId('feedback-open-github') as HTMLButtonElement;
const openedUrl = () => new URL(opened.mock.calls[0]![0] as string);

describe('FeedbackDialog', () => {
  it('opens a pre-filled GitHub issue in a new tab, once there is something to send', () => {
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} version="0.2.295" />);
    expect(openButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('feedback-kind-idea'));
    type('feedback-title', 'Export a diff as HTML');
    expect(openButton().disabled).toBe(true);
    type('feedback-description', 'So I can attach it to a change request.');
    fireEvent.click(openButton());

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0]!.slice(1)).toEqual(['_blank', 'noopener,noreferrer']);
    const url = openedUrl();
    expect(url.origin + url.pathname).toBe('https://github.com/tedious-code/foxSchema/issues/new');
    expect(url.searchParams.get('title')).toBe('[Idea] Export a diff as HTML');
    expect(url.searchParams.get('labels')).toBe('enhancement');
    expect(url.searchParams.get('body')).toContain('So I can attach it to a change request.');
    expect(screen.getByTestId('feedback-sent').textContent).toMatch(/Submit it there/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows every app detail it would send, names no server, and leaves them out when asked', () => {
    render(<FeedbackDialog open onClose={vi.fn()} version="0.2.295" />);
    const details = screen.getByTestId('feedback-details').textContent ?? '';
    expect(details).toContain('Fox Schema: 0.2.295');
    expect(details).toContain('Workspace: sqlEditor');
    // Engines, once each — never a host, database or connection name.
    expect(details).toContain('Engines in use: postgres, snowflake-like');
    for (const leak of ['prod-db.internal', 'billing', 'Prod', 'wh.internal', 'crm']) expect(details).not.toContain(leak);

    type('feedback-title', 'Hang');
    type('feedback-description', 'It hangs.');
    fireEvent.click(openButton());
    const withDetails = openedUrl().searchParams.get('body') ?? '';
    expect(withDetails).toContain('Engines in use: postgres, snowflake-like');
    for (const leak of ['prod-db.internal', 'billing', 'wh.internal']) expect(withDetails).not.toContain(leak);

    opened.mockReset();
    fireEvent.click(screen.getByTestId('feedback-include-details'));
    fireEvent.click(openButton());
    expect(openedUrl().searchParams.get('body')).not.toContain('App details');
  });

  it('warns about a line that looks like it carries a password, before anything is sent', () => {
    render(<FeedbackDialog open onClose={vi.fn()} version={null} />);
    type('feedback-description', 'Connecting with\npostgres://app:hunter2@db/shop\nfails');
    expect(screen.getByTestId('feedback-secret-warning').textContent).toMatch(/Line 2 looks like it carries a password/);
    type('feedback-description', 'Connecting with the saved password fails');
    expect(screen.queryByTestId('feedback-secret-warning')).toBeNull();
    expect(screen.getByTestId('feedback-details').textContent).toContain('Fox Schema: unknown');
  });

  it('says when a long description had to be shortened to fit in the link', () => {
    render(<FeedbackDialog open onClose={vi.fn()} version="1" />);
    type('feedback-title', 'Long log');
    type('feedback-description', 'stack frame\n'.repeat(2000));
    expect(screen.getByTestId('feedback-truncated')).toBeTruthy();
    fireEvent.click(openButton());
    expect(opened.mock.calls[0]![0].length).toBeLessThanOrEqual(7000);
  });

  it('closes on Escape, Cancel and the backdrop, and renders nothing when closed', () => {
    const onClose = vi.fn();
    const { rerender } = render(<FeedbackDialog open onClose={onClose} version="1" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('feedback-cancel'));
    fireEvent.click(screen.getByTestId('feedback-dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
    rerender(<FeedbackDialog open={false} onClose={onClose} version="1" />);
    expect(screen.queryByTestId('feedback-dialog')).toBeNull();
  });
});
