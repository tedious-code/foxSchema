/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The signed-in user's backup defaults, one set per engine.
 */
import type { BackupSettings } from '@foxschema/ui-shared';
import { api } from './client';

export async function apiGetBackupSettings(): Promise<Record<string, BackupSettings>> {
  const { settings } = await api.get<{ settings: Record<string, BackupSettings> }>('/backup-settings');
  return settings;
}

export async function apiSaveBackupSettings(dialect: string, settings: BackupSettings): Promise<BackupSettings> {
  const { settings: saved } = await api.put<{ settings: BackupSettings }>(
    `/backup-settings/${encodeURIComponent(dialect)}`,
    settings
  );
  return saved;
}
