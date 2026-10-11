/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { migrateUiPersist } from './uiStore';

describe('migrateUiPersist', () => {
  it('moves the old History pane onto the Snapshots workspace', () => {
    const next = migrateUiPersist(
      { activeView: 'sync', syncPane: 'history', lokeeEpoch: 3 },
      1
    ) as { activeView: string; syncPane: string; lokeeEpoch: number };
    expect(next.activeView).toBe('snapshots');
    expect(next.syncPane).toBe('compare');
    expect(next.lokeeEpoch).toBe(3);
  });

  it('rewrites the standalone lokeeWeave view the same way', () => {
    const next = migrateUiPersist({ activeView: 'lokeeWeave' }, 0) as {
      activeView: string;
      syncPane: string;
    };
    expect(next.activeView).toBe('snapshots');
    expect(next.syncPane).toBe('compare');
  });

  it('keeps Home as a persisted workspace', () => {
    const next = migrateUiPersist({ activeView: 'home', syncPane: 'compare' }, 2) as {
      activeView: string;
    };
    expect(next.activeView).toBe('home');
  });

  it('leaves Compare and Browse on Schema Sync', () => {
    const compare = migrateUiPersist({ activeView: 'sync', syncPane: 'compare' }, 3) as {
      activeView: string;
      syncPane: string;
    };
    expect(compare).toMatchObject({ activeView: 'sync', syncPane: 'compare' });
    const browse = migrateUiPersist({ activeView: 'sync', syncPane: 'browse' }, 3) as {
      activeView: string;
      syncPane: string;
    };
    expect(browse).toMatchObject({ activeView: 'sync', syncPane: 'browse' });
  });

  it('opens Home on first paint when upgrading from the old Sync default', () => {
    const next = migrateUiPersist({ activeView: 'sync', syncPane: 'compare' }, 2) as {
      activeView: string;
    };
    expect(next.activeView).toBe('home');
  });

  it('keeps the Utilities workspace when already persisted', () => {
    const next = migrateUiPersist({ activeView: 'utilities', syncPane: 'compare' }, 3) as {
      activeView: string;
    };
    expect(next.activeView).toBe('utilities');
  });

  it('keeps Preferences as a persisted workspace', () => {
    const next = migrateUiPersist({ activeView: 'settings', syncPane: 'compare' }, 3) as {
      activeView: string;
    };
    expect(next.activeView).toBe('settings');
  });
});
