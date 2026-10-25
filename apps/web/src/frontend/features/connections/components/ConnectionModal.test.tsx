import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/schemaApi', () => ({
  checkDriver: vi.fn().mockResolvedValue({ installed: true }),
  fetchSchemaList: vi.fn().mockResolvedValue([]),
  installDriver: vi.fn().mockResolvedValue(undefined),
  invalidateCache: vi.fn(),
}));

import { checkDriver, installDriver } from '@/shared/api/schemaApi';
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
});
