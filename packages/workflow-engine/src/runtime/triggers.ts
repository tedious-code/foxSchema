/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/triggers.ts).
 */
import type { CredentialStore } from '../common/index.js';
import type { TriggerDef } from '../common/index.js';
import { TriggerAuthenticationError, authenticateWebhook } from './webhook-auth.js';

export { TriggerAuthenticationError } from './webhook-auth.js';

/**
 * Authenticate an inbound HTTP-ingress trigger — a webhook, the one trigger
 * kind that receives requests. It delegates to the webhook's own `auth` union
 * (signature/basic/header/jwt, or none).
 */
export async function authenticateHttpTrigger(
  trigger: Extract<TriggerDef, { kind: 'webhook' }>,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  credentials: CredentialStore,
  idempotencyKey?: string,
): Promise<void> {
  if (trigger.auth.type !== 'none') {
    // Kind must match, not merely exist. Without this a webhook could point
    // at a database credential and its `password` field would satisfy Basic
    // auth — borrowing a secret that was never meant to gate an endpoint.
    const credential = await credentials.get(trigger.auth.credentialId);
    if (!credential || credential.kind !== 'webhook') {
      throw new TriggerAuthenticationError();
    }
  }
  return authenticateWebhook(
    trigger.auth,
    { headers, rawBody, idempotencyKey },
    credentials,
  );
}
