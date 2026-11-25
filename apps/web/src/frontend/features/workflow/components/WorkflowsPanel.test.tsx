/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/platform/authStore';
import type { WorkflowSummary } from '../api/engineClient';

const mockWorkflows: WorkflowSummary[] = [
  {
    id: 'sample-dba-schema-health-audit',
    name: '★ Sample · DBA · Schema Health, Index & PK Audit',
    tags: ['sample', 'dba', 'sql', 'audit', 'sqlite'],
    version: 1,
    pipelines: 1,
    pipes: 6,
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
  },
  {
    id: 'nightly-cron-report',
    name: 'Nightly Cron Digest',
    tags: ['notify'],
    version: 1,
    pipelines: 1,
    pipes: 2,
    triggers: [{ id: 'nightly', kind: 'cron', enabled: true }],
  },
  {
    id: 'custom-http-flow',
    name: 'Custom API Sync',
    tags: ['api'],
    version: 1,
    pipelines: 1,
    pipes: 3,
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
  },
];

const refreshMock = vi.fn();
const runMock = vi.fn();

vi.mock('../api/engineQueries', () => ({
  useWorkflows: () => ({ workflows: mockWorkflows, loading: false, refresh: refreshMock }),
}));

vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    run: (...args: unknown[]) => runMock(...args),
    save: vi.fn(),
    duplicateWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    exportWorkflow: vi.fn(),
    importWorkflow: vi.fn(),
  },
}));

import { WorkflowsPanel } from './WorkflowsPanel';

describe('WorkflowsPanel filters and quick run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'dba@example.com',
        role: 'admin',
        permissions: ['workflow.access', 'workflow.design', 'workflow.run'],
      } as never,
    });
  });

  it('filters workflows by DBA & SQL, Samples, and Scheduled categories', () => {
    render(
      <WorkflowsPanel
        currentId=""
        onOpen={vi.fn()}
        onLogs={vi.fn()}
        onCreate={vi.fn()}
        onApplySample={vi.fn()}
      />,
    );

    expect(screen.getByText('Custom API Sync')).toBeTruthy();
    expect(screen.getByText('Nightly Cron Digest')).toBeTruthy();

    fireEvent.click(screen.getByTestId('workflow-list-filter-dba'));
    expect(screen.getByText('★ Sample · DBA · Schema Health, Index & PK Audit')).toBeTruthy();
    expect(screen.queryByText('Custom API Sync')).toBeNull();
    expect(screen.queryByText('Nightly Cron Digest')).toBeNull();

    fireEvent.click(screen.getByTestId('workflow-list-filter-scheduled'));
    expect(screen.getByText('Nightly Cron Digest')).toBeTruthy();
    expect(screen.queryByText('Custom API Sync')).toBeNull();

    fireEvent.click(screen.getByTestId('workflow-list-filter-samples'));
    expect(screen.getByText('★ Sample · DBA · Schema Health, Index & PK Audit')).toBeTruthy();
    expect(screen.queryByText('Nightly Cron Digest')).toBeNull();
  });

  it('triggers a debug run directly from the row Run action', async () => {
    runMock.mockResolvedValue({ runId: 'run-dba-01', accepted: true, status: 'queued' });
    render(
      <WorkflowsPanel
        currentId=""
        onOpen={vi.fn()}
        onLogs={vi.fn()}
        onCreate={vi.fn()}
        onApplySample={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('workflow-list-run-sample-dba-schema-health-audit'));
    await waitFor(() =>
      expect(runMock).toHaveBeenCalledWith('sample-dba-schema-health-audit', { debug: true }),
    );
    expect(refreshMock).toHaveBeenCalled();
  });
});
