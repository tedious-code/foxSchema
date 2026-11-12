/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlVariable } from '@/shared/lib/sql-variables';

const listAppSecrets = vi.fn();
const deleteAppSecret = vi.fn();

vi.mock('@/shared/api/appSecretsApi', () => ({
  listAppSecrets: (...args: unknown[]) => listAppSecrets(...args),
  deleteAppSecret: (...args: unknown[]) => deleteAppSecret(...args),
}));

import {
  APP_SECRETS_CHANGED_EVENT,
  deleteSecretVariable,
  deleteVaultSecretAndVariables,
} from './deleteEditorSecret';

function scalar(name: string, secret = true): SqlVariable {
  return {
    id: `id-${name}`,
    name,
    kind: 'scalar',
    secret,
    updatedAt: 1,
  };
}

const vaultRow = {
  id: 's1',
  name: 'tok',
  source: 'local' as const,
  hasValue: true,
  cloudRef: null,
  updatedAt: 't',
};

describe('deleteEditorSecret', () => {
  beforeEach(() => {
    listAppSecrets.mockReset();
    deleteAppSecret.mockReset();
    listAppSecrets.mockResolvedValue([]);
    deleteAppSecret.mockResolvedValue(undefined);
  });

  it('unlinks every session variable with that name, secret or not', async () => {
    const deleteVariable = vi.fn();
    await deleteVaultSecretAndVariables(
      vaultRow,
      [scalar('tok'), scalar('n', false), { ...scalar('tok'), id: 'other-tok', secret: false }],
      deleteVariable
    );
    expect(deleteVariable.mock.calls.map((c) => c[0])).toEqual(['id-tok', 'other-tok']);
  });

  it('drops the vault row before session variables so a failed delete keeps them', async () => {
    const deleteVariable = vi.fn();
    deleteAppSecret.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(
      deleteVaultSecretAndVariables(vaultRow, [scalar('tok')], deleteVariable)
    ).rejects.toThrow(/Permission denied/);
    expect(deleteAppSecret).toHaveBeenCalledWith('s1');
    expect(deleteVariable).not.toHaveBeenCalled();
  });

  it('removing a secret variable deletes the vault copy of the same name first', async () => {
    listAppSecrets.mockResolvedValue([
      vaultRow,
      { ...vaultRow, id: 's2', name: 'other' },
    ]);
    const deleteVariable = vi.fn();
    const events: string[] = [];
    const onChanged = () => events.push('changed');
    window.addEventListener(APP_SECRETS_CHANGED_EVENT, onChanged);
    try {
      await deleteSecretVariable(scalar('tok'), deleteVariable);
    } finally {
      window.removeEventListener(APP_SECRETS_CHANGED_EVENT, onChanged);
    }

    expect(deleteAppSecret).toHaveBeenCalledWith('s1');
    expect(deleteAppSecret).not.toHaveBeenCalledWith('s2');
    expect(deleteVariable).toHaveBeenCalledWith('id-tok');
    expect(events).toEqual(['changed']);
  });

  it('keeps a public variable as a local delete only', async () => {
    const deleteVariable = vi.fn();
    const events: string[] = [];
    const onChanged = () => events.push('changed');
    window.addEventListener(APP_SECRETS_CHANGED_EVENT, onChanged);
    try {
      await deleteSecretVariable(scalar('n', false), deleteVariable);
    } finally {
      window.removeEventListener(APP_SECRETS_CHANGED_EVENT, onChanged);
    }

    expect(listAppSecrets).not.toHaveBeenCalled();
    expect(deleteAppSecret).not.toHaveBeenCalled();
    expect(deleteVariable).toHaveBeenCalledWith('id-n');
    expect(events).toEqual([]);
  });
});
