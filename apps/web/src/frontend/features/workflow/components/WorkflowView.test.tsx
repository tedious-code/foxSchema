/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';
import { useWorkflowUiStore } from '../store/workflowUiStore';
import { WorkflowView } from './WorkflowView';

vi.mock('./WorkflowDesigner', () => ({
  WorkflowDesigner: () => <div data-testid="workflow-designer-stub" />,
}));

function seedRole(role: 'viewer' | 'editor' | 'owner') {
  useAuthStore.setState({
    user: {
      id: role,
      email: `${role}@example.com`,
      onboardingCompleted: true,
      role,
      permissions: [...DEFAULT_ROLE_PERMISSIONS[role]],
    },
    status: 'ready',
    error: null,
    busy: false,
    refreshMe: vi.fn(async () => {}),
  });
}

beforeEach(() => {
  useWorkflowUiStore.setState({ view: 'designer', busy: false, workflowId: 'my-workflow' });
});

describe('WorkflowView pane RBAC', () => {
  it('shows every pane for an owner', () => {
    seedRole('owner');
    render(<WorkflowView />);
    expect(screen.getByTestId('workflow-tab-designer')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-workflows')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-runs')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-variables')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-credentials')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-engine')).toBeTruthy();
  });

  it('hides design and engine panes for a viewer who only has workflow.access', () => {
    seedRole('viewer');
    useWorkflowUiStore.setState({ view: 'engine' });
    render(<WorkflowView />);
    expect(screen.queryByTestId('workflow-tab-designer')).toBeNull();
    expect(screen.queryByTestId('workflow-tab-variables')).toBeNull();
    expect(screen.queryByTestId('workflow-tab-credentials')).toBeNull();
    expect(screen.queryByTestId('workflow-tab-engine')).toBeNull();
    expect(screen.getByTestId('workflow-tab-workflows')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-runs')).toBeTruthy();
    // Stored engine pane is not allowed — fall back to the first visible tab.
    expect(screen.getByTestId('workflow-tab-workflows').getAttribute('aria-current')).toBe('page');
  });

  it('lets an editor design and run, but not open Engine admin', () => {
    seedRole('editor');
    render(<WorkflowView />);
    expect(screen.getByTestId('workflow-tab-designer')).toBeTruthy();
    expect(screen.getByTestId('workflow-tab-credentials')).toBeTruthy();
    expect(screen.queryByTestId('workflow-tab-engine')).toBeNull();
  });
});
