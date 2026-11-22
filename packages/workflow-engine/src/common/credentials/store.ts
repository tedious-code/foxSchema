/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/common/src/credentials/store.ts).
 */
import { z } from 'zod';
import { LINKED_CONNECTION_PREFIX, connectionCredentialId } from '@foxschema/shared';
import { decrypt, encrypt } from './crypto.js';
import {
  buildStoredSecret,
  credentialSourceSchema,
  parseStoredSecret,
  resolveStoredSecret,
  type CredentialSource,
  type StoredSecretPayload,
} from './providers.js';

// What kind of secret a credential holds. Drives which fields the API expects
// and how the engine hands it to a connector at run time.
export const credentialKindSchema = z.enum([
  'database', // host/port/user/password for a SQL connection
  'http', // bearer / api key / basic / browser-login bag for HTTP + Playwright
  'oauth', // OAuth2 / OIDC client + refresh (Google, Meta, …) — same secret shape as http
  'webhook', // shared secret for verifying inbound webhook signatures
  'llm', // API key for AI generate (Anthropic / OpenAI / compatible)
  'email', // SMTP host/port/security/username/password, or a mail provider API key
  'sms', // SMS provider account: Twilio account SID + auth token, or Vonage key + secret
]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

export { credentialSourceSchema };
export type { CredentialSource };

/** Non-secret credential metadata — safe to return to a client. */
export interface CredentialMeta {
  id: string;
  name: string;
  kind: CredentialKind;
  /** Where secret material is resolved from (local encrypt / env / cloud). */
  source: CredentialSource;
  createdAt: string;
  updatedAt: string;
}

/** A stored credential. `secret` is ciphertext at rest; never serialize it raw. */
interface StoredCredential extends CredentialMeta {
  secret: string; // encrypted `v1:...`
}

/** Stable slug ids for demos / setup pages (e.g. `google-oauth`, `wp-login`). */
export const credentialIdSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/,
    'id must be a short slug (letters, digits, . _ -)',
  );

export const createCredentialSchema = z
  .object({
    /** Optional stable id. When set and already present, create upserts. */
    id: credentialIdSchema.optional(),
    name: z.string().min(1).max(80),
    kind: credentialKindSchema,
    source: credentialSourceSchema.default('local'),
    // The secret payload is opaque here — its shape is validated per source.
    // local: field values; env: field → env var names; cloud: reference config.
    data: z.record(z.string(), z.unknown()),
  })
  .superRefine((input, ctx) => {
    // The prefix tags a linked FoxSchema connection, and the designer reads the
    // id to show the link, so no other credential may take it.
    if (input.id?.startsWith(LINKED_CONNECTION_PREFIX)) {
      const connectionId = typeof input.data.connectionId === 'string' ? input.data.connectionId.trim() : '';
      if (input.source !== 'foxschema' || input.id !== connectionCredentialId(connectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ids starting ' + LINKED_CONNECTION_PREFIX + ' are reserved for linked FoxSchema connections',
          path: ['id'],
        });
      }
    }
    try {
      buildStoredSecret(input.source ?? 'local', input.data);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid credential data',
        path: ['data'],
      });
    }
  });
export type CreateCredentialInput = z.input<typeof createCredentialSchema>;

/**
 * Storage seam for credentials. The v1 implementation is in-memory; a SQLite /
 * Postgres backing (matching FoxSchema's pluggable metadata store) slots in
 * behind this interface without touching callers. Secrets are only ever
 * decrypted / resolved inside `revealSecret`, called by the engine — never by
 * API reads.
 */
export interface CredentialStore {
  create(input: CreateCredentialInput): Promise<CredentialMeta>;
  list(): Promise<CredentialMeta[]>;
  get(id: string): Promise<CredentialMeta | undefined>;
  remove(id: string): Promise<boolean>;
  /** Decrypt/resolve and return the secret payload. Engine-only. */
  revealSecret(id: string): Promise<Record<string, unknown> | undefined>;
  /**
   * Merge `patch` into the stored secret and re-encrypt. Used for cookie
   * sessions and access-token refresh persistence. Engine-only.
   * For remote sources, the patch is stored as a local overlay.
   */
  updateSecret?(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean>;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  constructor(private readonly key: Buffer) {}

  async create(input: CreateCredentialInput): Promise<CredentialMeta> {
    const now = new Date().toISOString();
    const id = input.id?.trim() || crypto.randomUUID();
    const source = input.source ?? 'local';
    const payload = buildStoredSecret(source, input.data);
    const secret = encrypt(JSON.stringify(payload), this.key);
    const existing = this.rows.get(id);
    if (existing) {
      existing.name = input.name;
      existing.kind = input.kind;
      existing.source = source;
      existing.secret = secret;
      existing.updatedAt = now;
      return this.toMeta(existing);
    }
    const row: StoredCredential = {
      id,
      name: input.name,
      kind: input.kind,
      source,
      createdAt: now,
      updatedAt: now,
      secret,
    };
    this.rows.set(id, row);
    return this.toMeta(row);
  }

  async list(): Promise<CredentialMeta[]> {
    return [...this.rows.values()].map((r) => this.toMeta(r));
  }

  async get(id: string): Promise<CredentialMeta | undefined> {
    const row = this.rows.get(id);
    return row ? this.toMeta(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async revealSecret(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const payload = parseStoredSecret(
      JSON.parse(decrypt(row.secret, this.key)) as Record<string, unknown>,
    );
    return resolveStoredSecret(payload);
  }

  async updateSecret(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    const payload = parseStoredSecret(
      JSON.parse(decrypt(row.secret, this.key)) as Record<string, unknown>,
    );
    const next: StoredSecretPayload =
      payload.source === 'local'
        ? {
            ...payload,
            values: { ...(payload.values ?? {}), ...patch },
          }
        : {
            ...payload,
            values: { ...(payload.values ?? {}), ...patch },
          };
    row.secret = encrypt(JSON.stringify(next), this.key);
    row.updatedAt = new Date().toISOString();
    return true;
  }

  private toMeta(row: StoredCredential): CredentialMeta {
    const { secret: _secret, ...meta } = row;
    return meta;
  }
}
