/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UtilitiesView } from './UtilitiesView';

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: { connections: { id: string; name: string; dialect: string }[] }) => unknown) =>
    sel({
      connections: [{ id: 'c1', name: 'Demo SQLite A', dialect: 'sqlite' }],
    }),
}));
vi.mock('./IndexManagementModal', () => ({
  IndexManagementModal: ({
    open,
    lockedConnectionId,
  }: {
    open: boolean;
    lockedConnectionId?: string;
  }) =>
    open ? (
      <div data-testid="index-management-embed" data-locked={lockedConnectionId ?? ''}>
        indexes
      </div>
    ) : null,
}));
vi.mock('./BackupRestorePanel', () => ({
  BackupRestorePanel: ({ lockedConnectionId }: { lockedConnectionId?: string }) => (
    <div data-testid="backup-panel" data-locked={lockedConnectionId ?? ''}>
      backup
    </div>
  ),
}));
vi.mock('./CloneTableModal', () => ({
  CloneTableModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="clone-table-modal">clone</div> : null,
}));
vi.mock('./ServerInsightsModal', () => ({
  ServerInsightsModal: ({
    open,
    initialTab,
  }: {
    open: boolean;
    initialTab?: string;
  }) =>
    open ? (
      <div data-testid="server-insights-modal">
        insights {initialTab}
        <button type="button" data-testid={`server-insights-tab-${initialTab ?? 'pool'}`} />
      </div>
    ) : null,
}));
vi.mock('./DatabaseAccessModal', () => ({
  DatabaseAccessModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="db-access-embedded">grants</div> : null,
}));
vi.mock('./FileQueryModal', () => ({
  FileQueryModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="file-query-modal">files</div> : null,
}));
vi.mock('@/features/sql-editor/components/FileImportsPanel', () => ({
  FileImportsPanel: () => <div data-testid="file-imports-panel">imports</div>,
}));

const UTILITY_BUTTONS = [
  'utilities-index-management',
  'utilities-backup',
  'utilities-database-access',
  'utilities-clone-table',
  'utilities-query-files',
  'utilities-connection-pool',
  'utilities-user-connections',
  'utilities-system-info',
  'utilities-object-sizes',
] as const;

describe('UtilitiesView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists every utility in the workspace nav, not the SQL sidebar', () => {
    render(<UtilitiesView />);
    expect(screen.getByTestId('utilities-view')).toBeTruthy();
    const nav = screen.getByTestId('sql-sidebar-utilities');
    for (const id of UTILITY_BUTTONS) {
      expect(nav.querySelector(`[data-testid="${id}"]`)).toBeTruthy();
    }
    expect(screen.getByTestId('index-management-modal')).toBeTruthy();
    expect(screen.getByTestId('utilities-connection')).toBeTruthy();
    expect(screen.getByTestId('index-management-embed').getAttribute('data-locked')).toBe('c1');
  });

  it('locks Clone Table and Insights to the workspace credential', () => {
    render(<UtilitiesView />);
    fireEvent.click(screen.getByTestId('utilities-clone-table'));
    expect(screen.getByTestId('clone-table-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('utilities-system-info'));
    expect(screen.getByTestId('server-insights-modal')).toBeTruthy();
    expect(screen.getByTestId('server-insights-tab-system')).toBeTruthy();
    expect(screen.getByTestId('utilities-connection')).toBeTruthy();
  });

  it('opens Backup & Restore on the workspace credential', () => {
    render(<UtilitiesView />);
    fireEvent.click(screen.getByTestId('utilities-backup'));
    expect(screen.getByTestId('backup-panel').getAttribute('data-locked')).toBe('c1');
  });

  it('opens Query files without a SQL Editor visit', () => {
    render(<UtilitiesView />);
    fireEvent.click(screen.getByTestId('utilities-query-files'));
    expect(screen.getByTestId('file-query-modal')).toBeTruthy();
    expect(screen.getByTestId('file-imports-panel')).toBeTruthy();
  });
});
