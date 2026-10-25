/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const checkDriver = vi.fn();
const installDriver = vi.fn();

vi.mock('@/shared/api/schemaApi', () => ({
  checkDriver: (...args: unknown[]) => checkDriver(...args),
  installDriver: (...args: unknown[]) => installDriver(...args),
}));

import { MissingDriverBanner } from './MissingDriverBanner';

beforeEach(() => {
  checkDriver.mockReset();
  installDriver.mockReset();
});

describe('MissingDriverBanner', () => {
  it('offers Install when the selected dialect has no driver, then reloads after it loads', async () => {
    checkDriver
      .mockResolvedValueOnce({
        provider: 'redis',
        packageName: 'redis',
        installed: false,
        installCommand: 'npm install redis',
      })
      .mockResolvedValueOnce({
        provider: 'redis',
        packageName: 'redis',
        installed: true,
        version: '6.3.0',
      });
    installDriver.mockResolvedValue({ success: true });
    const onInstalled = vi.fn();

    render(<MissingDriverBanner dialect="redis" onInstalled={onInstalled} />);

    const button = await screen.findByTestId('sql-install-driver');
    expect(button.textContent).toMatch(/Install driver/);
    expect(screen.getByText(/redis/)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(installDriver).toHaveBeenCalledWith('redis'));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(screen.queryByTestId('sql-install-driver')).toBeNull();
  });

  it('stays hidden when the driver is already installed', async () => {
    checkDriver.mockResolvedValue({
      provider: 'postgres',
      packageName: 'pg',
      installed: true,
    });
    render(
      <MissingDriverBanner dialect="postgres" error="connection refused" />
    );
    await waitFor(() => expect(checkDriver).toHaveBeenCalled());
    expect(screen.queryByTestId('sql-install-driver')).toBeNull();
  });
});
