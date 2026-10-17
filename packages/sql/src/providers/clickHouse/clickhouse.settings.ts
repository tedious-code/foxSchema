import { type ConnectionOptions, type ProviderConnectionSettings } from '../../interfaces/schema-provider.interface.js';

export const clickHouseSettings: ProviderConnectionSettings = {
  dialect: 'clickhouse',
  label: 'ClickHouse',
  defaultPort: 8123,
  defaultSchema: 'default',
  schemaRequired: true,
  // Transactions are experimental in ClickHouse and the adapter does not open
  // one: every statement commits as it runs, so there is nothing to roll back.
  transactions: false,

  buildConnectionString(option: ConnectionOptions): string {
    if (option.connectionString?.trim()) return option.connectionString.trim();
    const host = option.host || 'localhost';
    const port = option.port || this.defaultPort;
    const proto = option.ssl?.enabled ? 'https' : 'http';
    return `${proto}://${host}:${port}`;
  },
};
