/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A run that failed for a missing driver offers Install in both layouts.
 * Side by side is the one Compare data needs, and it had none.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/schemaApi', () => ({
  // Never answers: the banner has only the run's error to go on.
  checkDriver: vi.fn(() => new Promise(() => {})),
  installDriver: vi.fn(),
  invalidateCache: vi.fn(),
}));

import { useAuthStore } from '@/platform/authStore';
import { clearDriverStatus } from '@/shared/lib/driverStatus';
import type { CredentialRun } from '@/features/sql-editor/state/useSqlEditorStore';
import { ResultsPanel } from './ResultsPanel';

const failed: CredentialRun = {
  connectionId: 'c1',
  name: 'Cache',
  dialect: 'redis',
  status: 'error',
  error: 'Database driver "redis" is not installed for Redis. Run: npm install redis',
};

beforeEach(() => {
  clearDriverStatus();
  useAuthStore.setState({
    user: { id: 'u1', email: 'u1@example.test', onboardingCompleted: true, role: 'admin', permissions: [] },
    status: 'ready',
  });
});

describe('ResultsPanel — a missing driver', () => {
  it('offers Install by credential', () => {
    render(<ResultsPanel runs={[failed]} statements={['SELECT * FROM users']} layout="byCredential" />);
    expect(screen.getByTestId('sql-install-driver-c1')).toBeTruthy();
  });

  it('offers Install side by side', () => {
    render(<ResultsPanel runs={[failed]} statements={['SELECT * FROM users']} layout="sideBySide" />);
    expect(screen.getByTestId('sql-pane-install-driver-c1')).toBeTruthy();
    expect(screen.getByTestId('sql-pane-install-driver-c1-banner').textContent).toMatch(/Driver “redis” is not installed/);
  });
});
