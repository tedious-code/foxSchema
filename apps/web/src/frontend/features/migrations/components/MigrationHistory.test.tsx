/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/platform/authStore';

const apiListMigrations = vi.fn();
const apiGetMigration = vi.fn();
const apiDeleteMigration = vi.fn();
const apiDeleteMigrations = vi.fn();
const apiClearMigrations = vi.fn();
const openSqlInEditor = vi.fn();
const setActiveView = vi.fn();

vi.mock('../api/migrationApi', () => ({
  apiListMigrations: () => apiListMigrations(),
  apiGetMigration: (id: string) => apiGetMigration(id),
  apiDeleteMigration: (id: string) => apiDeleteMigration(id),
  apiDeleteMigrations: (ids: string[]) => apiDeleteMigrations(ids),
  apiClearMigrations: () => apiClearMigrations(),
}));

vi.mock('@/features/sql-editor', () => ({
  loadSqlEditor: () => Promise.resolve({ default: ({ value }: { value: string }) => <pre>{value}</pre> }),
  openSqlInEditor: (...args: unknown[]) => openSqlInEditor(...args),
}));

vi.mock('@/features/git', () => ({
  GitBranchView: () => null,
}));

vi.mock('@/platform/uiStore', () => ({
  useUiStore: (sel: (s: { setActiveView: typeof setActiveView }) => unknown) => sel({ setActiveView }),
}));

import { MigrationHistory } from './MigrationHistory';

const RUN_SUMMARY = {
  id: 'run-1',
  dialect: 'postgres',
  host: 'db.local',
  database: 'app',
  schema: 'public',
  status: 'SUCCESS' as const,
  objectCount: 2,
  startedAt: '2026-11-27T10:00:00.000Z',
  finishedAt: '2026-11-27T10:00:02.500Z',
  author: 'alice',
};

const RUN_DETAIL = {
  ...RUN_SUMMARY,
  script: 'CREATE TABLE orders (id INT PRIMARY KEY);',
  snapshotDdl: '-- pre snapshot',
  results: [
    { name: 'orders', type: 'TABLE', action: 'CREATE', status: 'SUCCESS' },
  ],
};

describe('MigrationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: {
        id: 'owner',
        email: 'owner@example.com',
        onboardingCompleted: true,
        role: 'owner',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.owner],
      },
      status: 'ready',
      error: null,
      busy: false,
      refreshMe: vi.fn(async () => {}),
    });
  });

  it('closes on Escape and shows load errors with a Retry button', async () => {
    apiListMigrations.mockRejectedValueOnce(new Error('Database offline'));
    const onClose = vi.fn();
    render(<MigrationHistory open onClose={onClose} />);

    expect(await screen.findByTestId('history-load-error')).toBeTruthy();
    expect(screen.getByTestId('history-load-error').textContent).toContain('Database offline');

    apiListMigrations.mockResolvedValueOnce([RUN_SUMMARY]);
    apiGetMigration.mockResolvedValueOnce(RUN_DETAIL);
    fireEvent.click(screen.getByTestId('history-retry'));

    await waitFor(() => expect(screen.getByTestId('history-run-duration').textContent).toContain('2.5s'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requires inline confirmation before deleting a record and opens scripts in SQL Editor', async () => {
    apiListMigrations.mockResolvedValue([RUN_SUMMARY]);
    apiGetMigration.mockResolvedValue(RUN_DETAIL);
    apiDeleteMigration.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(<MigrationHistory open onClose={onClose} />);
    await screen.findByTestId('history-delete-record');

    fireEvent.click(screen.getByTestId('history-delete-record'));
    expect(apiDeleteMigration).not.toHaveBeenCalled();
    expect(screen.getByTestId('history-delete-record-confirm')).toBeTruthy();

    fireEvent.click(screen.getByTestId('history-delete-record-cancel'));
    expect(screen.queryByTestId('history-delete-record-confirm')).toBeNull();

    fireEvent.click(screen.getByTestId('migration-history-open-sql'));
    expect(openSqlInEditor).toHaveBeenCalledWith(RUN_DETAIL.script);
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
    expect(onClose).toHaveBeenCalled();
  });
});
