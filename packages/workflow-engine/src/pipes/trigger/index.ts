/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/trigger/src/index.ts).
 */
export {
  TriggerPayloadSourcePipe,
  ManualTriggerSourcePipe,
  CronTriggerSourcePipe,
  WebhookTriggerSourcePipe,
  ParentTriggerSourcePipe,
} from './trigger-payload.js';
