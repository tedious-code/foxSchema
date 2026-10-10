import { getStore } from '../../database/store';

/**
 * Install-wide key/value settings (app_settings table). Holds non-secret config
 * like the metadata DB engine/location and first-run setup state. Secrets (the
 * DEK) never live here — they stay in the OS keychain on the desktop shell.
 */
export class AppSettingsStore {
  async get(key: string): Promise<string | undefined> {
    const store = await getStore();
    const row = await store.get<{ value: string | null }>(
      'SELECT "value" FROM app_settings WHERE "key" = ?',
      [key]
    );
    return row?.value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const store = await getStore();
    await store.upsert(
      'app_settings',
      ['key'],
      { key, value, updated_at: new Date().toISOString() },
      ['value', 'updated_at']
    );
  }

  async all(): Promise<Record<string, string>> {
    const store = await getStore();
    const rows = await store.all<{ key: string; value: string | null }>('SELECT "key", "value" FROM app_settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value ?? '']));
  }
}
