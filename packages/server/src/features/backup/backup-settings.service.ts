/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Each user's backup defaults, one set per engine.
 *
 * Saved as JSON and settled through `normalizeBackupSettings` on the way in
 * and on the way out: a default saved before an engine dropped an option, or
 * written by hand into the metadata database, comes back as something the
 * engine can still honour rather than as a command that fails.
 */
import { backupSupport, normalizeBackupSettings, type BackupSettings } from '@foxschema/sql';
import { getStore } from '../../database/store';

interface Row {
  dialect: string;
  settings: string;
}

export class UnknownBackupDialect extends Error {
  constructor(dialect: string) {
    super(`Fox Schema has no backup commands for ${dialect}.`);
  }
}

export class BackupSettingsModule {
  /** Every engine this user has saved defaults for. */
  async list(userId: string): Promise<Record<string, BackupSettings>> {
    const store = await getStore();
    const rows = await store.all<Row>('SELECT dialect, settings FROM backup_settings WHERE user_id = ?', [userId]);
    const out: Record<string, BackupSettings> = {};
    for (const row of rows) {
      if (!backupSupport(row.dialect)) continue;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(row.settings);
      } catch {
        // A row that is not JSON reads as the engine's defaults.
      }
      out[row.dialect] = normalizeBackupSettings(row.dialect, parsed);
    }
    return out;
  }

  /** Save one engine's defaults, settled to what it supports, and return them. */
  async save(userId: string, dialect: string, input: unknown): Promise<BackupSettings> {
    const id = (dialect || '').toLowerCase();
    if (!backupSupport(id)) throw new UnknownBackupDialect(dialect);
    const settings = normalizeBackupSettings(id, input);
    const store = await getStore();
    await store.upsert(
      'backup_settings',
      ['user_id', 'dialect'],
      { user_id: userId, dialect: id, settings: JSON.stringify(settings), updated_at: new Date().toISOString() },
      ['settings', 'updated_at']
    );
    return settings;
  }
}
