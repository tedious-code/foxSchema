/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';

import { AuthModule } from '../auth/auth.service';
import { getStore } from '../../database/store';
import { BackupSettingsModule, UnknownBackupDialect } from './backup-settings.service';

const auth = new AuthModule();
const backups = new BackupSettingsModule();
let alice: string;
let bob: string;

beforeAll(async () => {
  alice = (await auth.createUser('alice-backup@example.com', 'correct-horse-9', 'viewer')).id;
  bob = (await auth.createUser('bob-backup@example.com', 'correct-horse-9', 'viewer')).id;
});

describe('BackupSettingsModule', () => {
  it('has nothing saved for a new user', async () => {
    expect(await backups.list(alice)).toEqual({});
  });

  it('saves one engine’s defaults, settled to what it supports', async () => {
    const saved = await backups.save(alice, 'SQLServer', { folder: ' D:\\Backups ', format: 'plain', scope: 'schema', compress: false });
    expect(saved).toEqual({ folder: 'D:\\Backups', format: 'bak', scope: 'full', compress: false, limitToSchema: false });
    expect(await backups.list(alice)).toEqual({ sqlserver: saved });
  });

  it('replaces a saved default rather than adding a second', async () => {
    await backups.save(alice, 'postgres', { folder: '/a' });
    await backups.save(alice, 'postgres', { folder: '/b', format: 'plain' });
    const list = await backups.list(alice);
    expect(list.postgres).toMatchObject({ folder: '/b', format: 'plain' });
    expect(Object.keys(list).sort()).toEqual(['postgres', 'sqlserver']);
  });

  it('keeps each user’s defaults to themselves', async () => {
    expect(await backups.list(bob)).toEqual({});
  });

  it('refuses an engine it has no commands for', async () => {
    await expect(backups.save(alice, 'notadb', {})).rejects.toBeInstanceOf(UnknownBackupDialect);
  });

  it('reads a damaged row as the engine’s defaults instead of failing', async () => {
    const store = await getStore();
    await store.run('UPDATE backup_settings SET settings = ? WHERE user_id = ? AND dialect = ?', ['{not json', alice, 'postgres']);
    expect((await backups.list(alice)).postgres).toMatchObject({ folder: './backups', format: 'custom' });
  });
});
