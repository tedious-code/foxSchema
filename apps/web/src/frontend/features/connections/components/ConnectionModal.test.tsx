import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/schemaApi', () => ({
  checkDriver: vi.fn().mockResolvedValue({ installed: true }),
  fetchSchemaList: vi.fn().mockResolvedValue([]),
  installDriver: vi.fn().mockResolvedValue(undefined),
  invalidateCache: vi.fn(),
}));

import { checkDriver, fetchSchemaList, installDriver } from '@/shared/api/schemaApi';
import { useAuthStore } from '@/platform/authStore';
import { clearDriverStatus } from '@/shared/lib/driverStatus';
import { ConnectionModal } from './ConnectionModal';

const signIn = (role: 'admin' | 'editor') =>
  useAuthStore.setState({
    user: { id: 'u1', email: 'u1@example.test', onboardingCompleted: true, role, permissions: [] },
    status: 'ready',
  });

beforeEach(() => {
  clearDriverStatus();
  signIn('admin');
});

describe('ConnectionModal', () => {
  it('verifies Azure SQL server certificates by default', () => {
    const onSave = vi.fn();

    render(
      <ConnectionModal
        open
        dialect="postgres"
        onClose={() => undefined}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByTestId('conn-dialect-select'), {
      target: { value: 'azuresql' },
    });
    fireEvent.click(screen.getByTestId('conn-save-btn'));

    expect(onSave).toHaveBeenCalledOnce();
    const [options, dialect] = onSave.mock.calls[0];
    expect(dialect).toBe('azuresql');
    expect(options.ssl).toMatchObject({
      enabled: true,
      rejectUnauthorized: true,
    });
    expect(options.connectionString).not.toContain('TrustServerCertificate=True');
  });

  it('Redis offers No password: no password field, and none is saved', () => {
    const onSave = vi.fn();
    render(<ConnectionModal open dialect="redis" onClose={() => undefined} onSave={onSave} />);
    // A new Redis with no username starts on No password.
    expect((screen.getByTestId('conn-auth-method') as HTMLSelectElement).value).toBe('none');
    expect(screen.queryByTestId('conn-password-input')).toBeNull();
    fireEvent.click(screen.getByTestId('conn-save-btn'));
    expect(onSave.mock.calls[0][0]).toMatchObject({ authMethod: 'none', password: undefined });

    // Password is a choice of its own, saved as such (Redis requirepass has no username).
    fireEvent.change(screen.getByTestId('conn-auth-method'), { target: { value: 'password' } });
    fireEvent.change(screen.getByTestId('conn-password-input'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('conn-save-btn'));
    expect(onSave.mock.calls[1][0]).toMatchObject({ authMethod: 'password', password: 'pw' });
  });

  describe('a missing driver', () => {
    const missing = { provider: 'redis', packageName: 'redis', installed: false, installCommand: 'npm install redis' };
    const modal = () => <ConnectionModal open dialect="redis" onClose={() => undefined} onSave={() => undefined} />;

    it('offers Install to an admin', async () => {
      vi.mocked(checkDriver).mockResolvedValue(missing);
      render(modal());
      fireEvent.click(await screen.findByTestId('conn-install-driver-package'));
      await waitFor(() => expect(installDriver).toHaveBeenCalledWith('redis'));
    });

    it('offers no Install without the Install drivers permission, and gives the command instead', async () => {
      signIn('editor');
      vi.mocked(checkDriver).mockResolvedValue(missing);
      render(modal());
      expect((await screen.findByTestId('driver-install-needs-admin')).textContent).toMatch(/npm install redis/);
      expect(screen.queryByTestId('conn-install-driver-package')).toBeNull();
    });
  });

  it('keeps a stored name it would not have let you type before, instead of rewriting it on save', async () => {
    const onSaveCredential = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectionModal
        open
        mode="credential"
        dialect="postgres"
        initialName="127.0.0.1/foxdb (staging)"
        initialOptions={{ host: '127.0.0.1', port: 5432, database: 'foxdb', username: 'fox' }}
        onClose={() => undefined}
        onSaveCredential={onSaveCredential}
      />
    );
    expect((screen.getByTestId('conn-name-input') as HTMLInputElement).value).toBe('127.0.0.1/foxdb (staging)');
  });

  it('provides quick-fill paths for SQLite and DuckDB file dialects', () => {
    render(<ConnectionModal open dialect="sqlite" onClose={() => undefined} onSave={() => undefined} />);
    fireEvent.click(screen.getByTestId('conn-quick-path-demo-a'));
    expect((screen.getByTestId('conn-database-input') as HTMLInputElement).value).toBe(
      '/tmp/foxschema-sqlite/demo_a.db',
    );
    fireEvent.click(screen.getByTestId('conn-quick-path-demo-b'));
    expect((screen.getByTestId('conn-database-input') as HTMLInputElement).value).toBe(
      '/tmp/foxschema-sqlite/demo_b.db',
    );
    fireEvent.click(screen.getByTestId('conn-quick-path-memory'));
    expect((screen.getByTestId('conn-database-input') as HTMLInputElement).value).toBe(':memory:');
  });

  it('fills dialect, host, port, database, user, password, and SSL from a pasted connection URL', () => {
    render(<ConnectionModal open mode="credential" dialect="sqlite" onClose={() => undefined} onSaveCredential={vi.fn()} />);
    fireEvent.change(screen.getByTestId('conn-url-input'), {
      target: { value: 'postgresql://alice:secret@db.example.com:5433/analytics?sslmode=require' },
    });
    fireEvent.click(screen.getByTestId('conn-url-apply'));
    expect((screen.getByTestId('conn-dialect-select') as HTMLSelectElement).value).toBe('postgres');
    expect((screen.getByTestId('conn-host-input') as HTMLInputElement).value).toBe('db.example.com');
    expect((screen.getByTestId('conn-port-input') as HTMLInputElement).value).toBe('5433');
    expect((screen.getByTestId('conn-database-input') as HTMLInputElement).value).toBe('analytics');
    expect((screen.getByTestId('conn-username-input') as HTMLInputElement).value).toBe('alice');
    expect((screen.getByTestId('conn-ssl-enabled') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('conn-url-hint').textContent).toMatch(/PostgreSQL/);
  });

  it('exposes a dedicated Test Connection button that verifies connectivity', async () => {
    vi.mocked(fetchSchemaList).mockResolvedValueOnce(['public', 'billing']);
    render(<ConnectionModal open dialect="postgres" onClose={() => undefined} onSave={() => undefined} />);
    fireEvent.click(screen.getByTestId('conn-test-btn'));
    await waitFor(() => expect(screen.getByTestId('conn-test-success')).toBeTruthy());
    expect(screen.getByTestId('conn-test-success').textContent).toContain('Connection verified');
    expect(screen.getByTestId('conn-test-success').textContent).toContain('2 schemas loaded');
  });
});

