/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/platform/authStore';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { SqlVariablesPanel } from './SqlVariablesPanel';

const listAppSecrets = vi.fn();
const deleteAppSecret = vi.fn();

vi.mock('@/shared/api/appSecretsApi', () => ({
  listAppSecrets: (...args: unknown[]) => listAppSecrets(...args),
  deleteAppSecret: (...args: unknown[]) => deleteAppSecret(...args),
}));

vi.mock('@/features/sql-editor/lib/sqlEditorBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/sql-editor/lib/sqlEditorBridge')>()),
  insertVariableRef: () => true,
}));

describe('SqlVariablesPanel secret delete', () => {
  beforeEach(() => {
    listAppSecrets.mockReset();
    deleteAppSecret.mockReset();
    listAppSecrets.mockResolvedValue([
      { id: 's1', name: 'tok', source: 'local', hasValue: true, cloudRef: null, updatedAt: 't' },
    ]);
    deleteAppSecret.mockResolvedValue(undefined);
    useAuthStore.setState({
      user: {
        id: 'u',
        email: 'u@example.com',
        onboardingCompleted: true,
        role: 'editor',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.editor],
      },
      status: 'ready',
      error: null,
      busy: false,
    } as never);
    useSqlEditorStore.setState({
      variables: [
        { id: 'v1', name: 'tok', kind: 'scalar', value: 'shh', secret: true, updatedAt: 1 },
      ],
    });
  });

  it('removes the session variable and the vault secret of the same name', async () => {
    render(<SqlVariablesPanel />);
    fireEvent.click(screen.getByTestId('sql-variable-delete-tok'));
    await waitFor(() => expect(deleteAppSecret).toHaveBeenCalledWith('s1'));
    expect(useSqlEditorStore.getState().variables.find((v) => v.name === 'tok')).toBeUndefined();
  });
});
