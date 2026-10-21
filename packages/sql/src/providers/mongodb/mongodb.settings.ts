import {
  type ConnectionOptions,
  type ProviderConnectionSettings,
} from '../../interfaces/schema-provider.interface.js';

/**
 * Connection settings for MongoDB.
 *
 * `database` is the Mongo database and `schema` is unused — a Mongo database
 * holds collections directly, with no layer between. The adapter reads
 * `database` (falling back to `schema`) so a value typed in either field still
 * works, but the form should ask for the database.
 *
 * `authSource` matters more here than it looks: credentials usually live in
 * `admin` rather than in the database being read, and omitting it is the most
 * common reason a correct username and password still fail to authenticate.
 * It is appended automatically when a username is supplied and the caller has
 * not already said otherwise.
 */
export const mongoDbSettings: ProviderConnectionSettings = {
  dialect: 'mongodb',
  label: 'MongoDB',
  defaultPort: 27017,
  schemaRequired: false,
  // MongoDB has sessions with transactions on a replica set, but the adapter
  // does not start one: each translated statement is final as it runs.
  transactions: false,

  buildConnectionString(option: ConnectionOptions): string {
    // mongodb+srv:// URLs carry their own host list and no port, so a
    // hand-supplied string must be honoured untouched.
    if (option.connectionString?.trim()) return option.connectionString.trim();

    const host = option.host || 'localhost';
    const port = option.port || this.defaultPort;
    const username = encodeURIComponent(option.username || '');
    const password = encodeURIComponent(option.password || '');
    const auth = username ? `${username}:${password}@` : '';
    const database = encodeURIComponent(option.database || option.schema || '');

    const params: string[] = [];
    if (option.ssl?.enabled) params.push('tls=true');
    // Only when authenticating: on an unauthenticated server authSource is
    // meaningless, and adding it invites a confusing failure.
    if (username) params.push('authSource=admin');

    let url = `mongodb://${auth}${host}:${port}/${database}`;
    if (params.length > 0) url += `?${params.join('&')}`;
    return url;
  },
};
