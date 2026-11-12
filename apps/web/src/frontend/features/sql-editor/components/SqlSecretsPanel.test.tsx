/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAppSecrets = vi.fn();
const listCloudProviders = vi.fn();
const createCloudProviderCredential = vi.fn();
const createAppSecret = vi.fn();
const resolveAppSecrets = vi.fn();
const deleteAppSecret = vi.fn();
const listGcpProjects = vi.fn();
const listGcpSecrets = vi.fn();
const listGcpSecretVersions = vi.fn();
const upsertVariable = vi.fn(() => null);
const deleteVariable = vi.fn();
const insertAtCursor = vi.fn((_text: string) => true);
const editorVariables: Array<{ id: string; name: string; secret?: boolean }> = [];

vi.mock('@/shared/api/appSecretsApi', () => ({
  listAppSecrets: (...args: unknown[]) => listAppSecrets(...args),
  listCloudProviders: (...args: unknown[]) => listCloudProviders(...args),
  createCloudProviderCredential: (...args: unknown[]) => createCloudProviderCredential(...args),
  createAppSecret: (...args: unknown[]) => createAppSecret(...args),
  resolveAppSecrets: (...args: unknown[]) => resolveAppSecrets(...args),
  deleteAppSecret: (...args: unknown[]) => deleteAppSecret(...args),
  listGcpProjects: (...args: unknown[]) => listGcpProjects(...args),
  listGcpSecrets: (...args: unknown[]) => listGcpSecrets(...args),
  listGcpSecretVersions: (...args: unknown[]) => listGcpSecretVersions(...args),
  gcpOAuthStartUrl: (name?: string) =>
    `/api/app-secrets/providers/gcp/oauth/start${name ? `?name=${encodeURIComponent(name)}` : ''}`,
}));

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => {
  const store = {
    upsertVariable: (...args: unknown[]) => upsertVariable(...args),
    deleteVariable: (...args: unknown[]) => deleteVariable(...args),
    get variables() {
      return editorVariables;
    },
  };
  const hook = (sel: (s: typeof store) => unknown) => sel(store);
  hook.getState = () => store;
  return { useSqlEditorStore: hook };
});

vi.mock('@/features/sql-editor/lib/sqlEditorBridge', () => ({
  insertAtCursor: (text: string) => insertAtCursor(text),
  insertVariableRef: (name: string) => insertAtCursor('${{' + name + '}}'),
}));

import { SqlSecretsPanel } from './SqlSecretsPanel';

describe('SqlSecretsPanel', () => {
  beforeEach(() => {
    listAppSecrets.mockReset();
    listCloudProviders.mockReset();
    createCloudProviderCredential.mockReset();
    createAppSecret.mockReset();
    resolveAppSecrets.mockReset();
    deleteAppSecret.mockReset();
    upsertVariable.mockReset();
    upsertVariable.mockReturnValue(null);
    deleteVariable.mockReset();
    editorVariables.length = 0;
    insertAtCursor.mockReset();
    insertAtCursor.mockReturnValue(true);
    listAppSecrets.mockResolvedValue([]);
    listCloudProviders.mockResolvedValue([]);
    listGcpProjects.mockReset();
    listGcpSecrets.mockReset();
    listGcpSecretVersions.mockReset();
    listGcpProjects.mockResolvedValue([]);
    listGcpSecrets.mockResolvedValue([]);
    listGcpSecretVersions.mockResolvedValue([]);
  });

  it('lets you save a Google Cloud credential from the empty Secrets form', async () => {
    createCloudProviderCredential.mockResolvedValue({
      id: 'cred-1',
      name: 'Google Cloud',
      provider: 'gcp',
      updatedAt: new Date().toISOString(),
    });
    listCloudProviders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'cred-1',
          name: 'Google Cloud',
          provider: 'gcp',
          updatedAt: new Date().toISOString(),
        },
      ]);

    render(<SqlSecretsPanel />);
    await waitFor(() => expect(listCloudProviders).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('sql-secret-add'));
    expect(screen.getByTestId('sql-secret-add-cloud-cred')).toBeTruthy();
    expect(screen.getByTestId('sql-secret-gcp-connect').textContent).toMatch(/Connect Google Cloud/);

    fireEvent.change(screen.getByTestId('sql-secret-cloud-cred-name'), {
      target: { value: 'Google Cloud' },
    });
    fireEvent.change(screen.getByTestId('sql-secret-cloud-cred-field-serviceAccountJson'), {
      target: {
        value: JSON.stringify({
          type: 'external_account',
          audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x',
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          token_url: 'https://sts.googleapis.com/v1/token',
          credential_source: { file: '/var/run/secrets/token' },
        }),
      },
    });
    fireEvent.click(screen.getByTestId('sql-secret-cloud-cred-save'));

    await waitFor(() =>
      expect(createCloudProviderCredential).toHaveBeenCalledWith({
        name: 'Google Cloud',
        provider: 'gcp',
        credentials: expect.objectContaining({
          serviceAccountJson: expect.stringContaining('external_account'),
        }),
      })
    );
    expect(JSON.stringify(createCloudProviderCredential.mock.calls)).not.toContain('private_key');
    await waitFor(() => expect(screen.getByTestId('sql-secret-provider')).toBeTruthy());
    expect(screen.getByTestId('sql-secret-cloud-id').getAttribute('placeholder')).toMatch(
      /Secret name/
    );
  });

  it('picks a GCP project, secret, and version instead of typing the resource name', async () => {
    listCloudProviders.mockResolvedValue([
      {
        id: 'cred-1',
        name: 'Google Cloud',
        provider: 'gcp',
        auth: 'oauth',
        email: 'dev@example.com',
        updatedAt: new Date().toISOString(),
      },
    ]);
    listGcpProjects.mockResolvedValue([{ id: 'demo-proj', name: 'Demo' }]);
    listGcpSecrets.mockResolvedValue([{ id: 'api-token', name: 'api-token' }]);
    listGcpSecretVersions.mockResolvedValue([
      { id: 'latest', name: 'latest', state: 'ENABLED' },
      { id: '3', name: '3', state: 'ENABLED' },
    ]);
    createAppSecret.mockResolvedValue({
      id: 's1',
      name: 'apiToken',
      source: 'gcp',
      hasValue: true,
      cloudRef: { secretId: 'projects/demo-proj/secrets/api-token', credentialId: 'cred-1' },
      updatedAt: new Date().toISOString(),
    });
    resolveAppSecrets.mockResolvedValue({ secrets: { apiToken: 'from-sm' }, errors: {} });

    render(<SqlSecretsPanel />);
    await waitFor(() => expect(listCloudProviders).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('sql-secret-add'));
    fireEvent.change(screen.getByTestId('sql-secret-name'), { target: { value: 'apiToken' } });

    await waitFor(() => expect(screen.getByTestId('sql-secret-gcp-project')).toBeTruthy());
    await waitFor(() => expect(listGcpSecrets).toHaveBeenCalledWith('cred-1', 'demo-proj'));
    fireEvent.change(screen.getByTestId('sql-secret-gcp-secret'), { target: { value: 'api-token' } });
    await waitFor(() =>
      expect(listGcpSecretVersions).toHaveBeenCalledWith('cred-1', 'api-token', 'demo-proj')
    );
    fireEvent.click(screen.getByTestId('sql-secret-fetch'));
    await waitFor(() =>
      expect(createAppSecret).toHaveBeenCalledWith({
        name: 'apiToken',
        source: 'gcp',
        cloudRef: expect.objectContaining({
          secretId: 'projects/demo-proj/secrets/api-token',
          credentialId: 'cred-1',
        }),
      })
    );
    expect(JSON.stringify(createAppSecret.mock.calls)).not.toContain('from-sm');
  });

  it('inserts ${{name}} at the cursor and never the secret value', async () => {
    listAppSecrets.mockResolvedValue([
      {
        id: 's1',
        name: 'apiToken',
        source: 'local',
        hasValue: true,
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<SqlSecretsPanel />);
    await waitFor(() => expect(screen.getByTestId('sql-secret-insert-apiToken')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sql-secret-insert-apiToken'));
    expect(insertAtCursor).toHaveBeenCalledWith('${{apiToken}}');
    expect(JSON.stringify(insertAtCursor.mock.calls)).not.toMatch(/from-sm|shh|secret value/i);
  });

  it('deletes the vault row and the session variable of the same name', async () => {
    editorVariables.push({ id: 'v1', name: 'apiToken', secret: true });
    listAppSecrets
      .mockResolvedValueOnce([
        {
          id: 's1',
          name: 'apiToken',
          source: 'local',
          hasValue: true,
          updatedAt: new Date().toISOString(),
        },
      ])
      .mockResolvedValueOnce([]);
    deleteAppSecret.mockResolvedValue(undefined);

    render(<SqlSecretsPanel />);
    await waitFor(() => expect(screen.getByTestId('sql-secret-delete-secret-s1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sql-secret-delete-secret-s1'));
    await waitFor(() => expect(deleteAppSecret).toHaveBeenCalledWith('s1'));
    expect(deleteVariable).toHaveBeenCalledWith('v1');
    await waitFor(() => expect(screen.queryByTestId('sql-secret-apiToken')).toBeNull());
  });
});
