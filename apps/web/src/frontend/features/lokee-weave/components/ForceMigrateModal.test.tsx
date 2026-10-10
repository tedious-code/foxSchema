/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The gate in front of writing a stored schema onto a database it never came
 * from.
 *
 * These assert the *refusals*, not the happy path: the server enforces the same
 * rules, so what is worth pinning here is that the UI cannot hand a reader an
 * Apply button before they have answered the question that makes this safe.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ForceMigrateModal } from './ForceMigrateModal';

const listLokeeVersions = vi.fn();
const planLokeeForceMigrate = vi.fn();
const executeLokeeForceMigrate = vi.fn();

vi.mock('../api/lokeeApi', () => ({
  listLokeeVersions: (...args: unknown[]) => listLokeeVersions(...args),
  planLokeeForceMigrate: (...args: unknown[]) => planLokeeForceMigrate(...args),
  executeLokeeForceMigrate: (...args: unknown[]) => executeLokeeForceMigrate(...args),
  LokeeForceMigrateError: class LokeeForceMigrateError extends Error {},
}));

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      connections: [
        { id: 'c1', name: 'staging', dialect: 'postgres', database: 'shop_staging' },
        { id: 'c2', name: 'analytics', dialect: 'postgres', database: 'shop_analytics' },
      ],
    }),
}));

vi.mock('@/app/store/toastStore', () => ({ toast: vi.fn() }));

const VERSION = {
  id: 'v1',
  number: 4,
  rootHash: 'h',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastObservedAt: '2026-01-01T00:00:00.000Z',
  observationCount: 1,
  source: 'manual',
  objectCount: 3,
  changeCount: 3,
  added: 0,
  modified: 0,
  removed: 0,
};

const planWith = (risk: 'safe' | 'lossy') => ({
  version: VERSION,
  target: { dialect: 'postgres', database: 'shop_staging' },
  alreadyMatches: false,
  reversal: {
    verdicts: [],
    risk,
    safeCount: 1,
    lossyCount: risk === 'lossy' ? 1 : 0,
    blockedCount: 0,
  },
  statements: ['CREATE TABLE customer (id integer);'],
});

const applyBtn = () => screen.getByTestId('force-migrate-apply') as HTMLButtonElement;

async function openWithPlan(risk: 'safe' | 'lossy') {
  planLokeeForceMigrate.mockResolvedValue(planWith(risk));
  render(<ForceMigrateModal databaseId="db1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('force-migrate-version')).toBeTruthy());
  fireEvent.change(screen.getByTestId('force-migrate-target'), { target: { value: 'c1' } });
  fireEvent.click(screen.getByTestId('force-migrate-preview'));
  await waitFor(() => expect(screen.getByTestId('force-migrate-risk')).toBeTruthy());
}

beforeEach(() => {
  listLokeeVersions.mockReset();
  planLokeeForceMigrate.mockReset();
  executeLokeeForceMigrate.mockReset();
  listLokeeVersions.mockResolvedValue([VERSION]);
});

describe('ForceMigrateModal', () => {
  it('keeps Apply disabled until the force acknowledgement is ticked, even on a safe plan', async () => {
    await openWithPlan('safe');

    // The whole point of a separate acknowledgement: a plan that destroys
    // nothing is still writing this schema onto a database it never came from,
    // so "safe" must not be enough to enable Apply.
    expect(applyBtn().disabled).toBe(true);
    expect(screen.queryByTestId('force-migrate-confirm-lossy')).toBeNull();

    fireEvent.click(screen.getByTestId('force-migrate-confirm-force'));
    expect(applyBtn().disabled).toBe(false);
  });

  it('requires both acknowledgements on a lossy plan', async () => {
    await openWithPlan('lossy');

    // Ticking only the data-loss box leaves the "wrong database" question
    // unanswered — the two are not interchangeable.
    fireEvent.click(screen.getByTestId('force-migrate-confirm-lossy'));
    expect(applyBtn().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('force-migrate-confirm-force'));
    expect(applyBtn().disabled).toBe(false);
  });

  it('throws the plan away when the target changes', async () => {
    await openWithPlan('safe');
    fireEvent.click(screen.getByTestId('force-migrate-confirm-force'));
    expect(applyBtn().disabled).toBe(false);

    // A plan computed for `staging` says nothing about `analytics`. Leaving it
    // on screen would let the reader confirm statements that were never
    // generated for the database now selected.
    fireEvent.change(screen.getByTestId('force-migrate-target'), { target: { value: 'c2' } });

    expect(screen.queryByTestId('force-migrate-risk')).toBeNull();
    expect(applyBtn().disabled).toBe(true);
  });

  it('does not call the server until Apply is actually enabled', async () => {
    await openWithPlan('safe');
    fireEvent.click(applyBtn());
    // Disabled buttons swallow the click, but asserting the call count is what
    // catches a future change that enables Apply without the acknowledgement.
    expect(executeLokeeForceMigrate).not.toHaveBeenCalled();
  });
});
