/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/trigger/src/trigger-payload.ts).
 */
import type {
  PipeContext,
  RecordBatch,
  SourcePipe,
} from '../../registry/index.js';
import { definePipeMetadata, type PipeMetadata } from '../../sdk/index.js';
import type { TriggerInvocation } from '../../common/index.js';

type TriggerKind = TriggerInvocation['kind'];

/**
 * Trigger *source* pipes: workflow-level triggers still activate the run;
 * these pipes pull the invocation into the data plane as RecordBatches.
 * They are role `source` (not legacy `role: "trigger"`).
 */
abstract class TriggerSourcePipe implements SourcePipe {
  abstract readonly type: string;
  readonly role = 'source';
  protected abstract readonly kind: TriggerKind | '*';
  protected abstract readonly displayName: string;

  protected readonly paletteTier: 'primary' | 'advanced' = 'primary';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: this.displayName,
      category: 'Trigger',
      family: 'trigger',
      palette: this.paletteTier,
      version: '0.1.0',
      role: 'source',
      inputs: [],
      outputs: [{ name: 'out', type: 'records' }],
      // Activation settings live on `workflow.triggers`; the node only binds
      // to one. `triggerId` is optional — an unbound node still reads whichever
      // invocation of a matching kind started the run.
      configSchema: {
        type: 'object',
        properties: {
          triggerId: {
            type: 'string',
            description: 'Workflow trigger this node represents.',
          },
        },
        additionalProperties: false,
      },
      simple: true,
      triggerKind: this.kind,
    });
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    const invocation = context.invocation;
    if (!invocation) {
      throw new Error(`${this.type} requires a workflow trigger invocation`);
    }
    const boundTriggerId =
      typeof context.pipe.config.triggerId === 'string' && context.pipe.config.triggerId.trim()
        ? context.pipe.config.triggerId.trim()
        : undefined;

    if (boundTriggerId && invocation.triggerId && boundTriggerId !== invocation.triggerId) {
      // A different trigger activated this run; this trigger node stays idle.
      return;
    }
    if (
      this.kind !== '*' &&
      invocation.kind !== this.kind &&
      invocation.kind !== 'manual'
    ) {
      throw new Error(
        `${this.type} expects a ${this.kind} trigger, got ${invocation.kind}`,
      );
    }
    if (context.checkpoint?.cursor.invocationId === invocation.id) return;

    const records = recordsForKind(invocation);
    yield {
      id: `${context.pipe.id}:0:${invocation.id}`,
      partitionId: '0',
      records,
      cursor: { invocationId: invocation.id },
    };
  }
}

/** Accepts any trigger kind — generic payload ingress. */
export class TriggerPayloadSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.triggerPayload';
  protected readonly kind = '*' as const;
  protected readonly displayName = 'Trigger payload';
  protected override readonly paletteTier = 'advanced' as const;
}

export class ManualTriggerSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.trigger.manual';
  protected readonly kind = 'manual' as const;
  protected readonly displayName = 'Manual Trigger';
}

/**
 * Type id stays `source.trigger.cron` so saved workflows keep resolving; only
 * the display name changed to "Schedule Trigger".
 */
export class CronTriggerSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.trigger.cron';
  protected readonly kind = 'cron' as const;
  protected readonly displayName = 'Schedule Trigger';
}

export class WebhookTriggerSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.trigger.webhook';
  protected readonly kind = 'webhook' as const;
  protected readonly displayName = 'Webhook Trigger';
}

export class HttpTriggerSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.trigger.http';
  protected readonly kind = 'http' as const;
  protected readonly displayName = 'API Endpoint Trigger';
}

export class PollTriggerSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.trigger.poll';
  protected readonly kind = 'poll' as const;
  protected readonly displayName = 'API Polling Trigger';
}

export class ParentTriggerSourcePipe extends TriggerSourcePipe {
  readonly type = 'source.trigger.parent';
  protected readonly kind = 'parent' as const;
  protected readonly displayName = 'Parent Workflow Trigger';
  protected override readonly paletteTier = 'advanced' as const;
}

function recordsForKind(
  invocation: TriggerInvocation,
): Record<string, unknown>[] {
  if (invocation.kind === 'manual' && invocation.payload == null) {
    return [
      {
        triggered: true,
        triggerId: invocation.triggerId,
        kind: invocation.kind,
        acceptedAt: invocation.acceptedAt,
      },
    ];
  }
  if (invocation.kind === 'cron') {
    const payload =
      invocation.payload &&
      typeof invocation.payload === 'object' &&
      !Array.isArray(invocation.payload)
        ? (invocation.payload as Record<string, unknown>)
        : {};
    return [
      {
        triggerId: invocation.triggerId,
        kind: 'cron',
        acceptedAt: invocation.acceptedAt,
        ...payload,
      },
    ];
  }
  if (invocation.kind === 'poll') {
    // The invocation carries the new items; one record each is what the rest
    // of the pipeline expects, not a single record wrapping an array.
    const payload = invocation.payload;
    const items =
      payload && typeof payload === 'object' && 'items' in payload
        ? (payload as { items: unknown }).items
        : undefined;
    return normalizePayload(Array.isArray(items) ? items : []);
  }
  if (invocation.kind === 'parent' && invocation.payload == null) {
    return [
      {
        triggered: true,
        triggerId: invocation.triggerId,
        kind: invocation.kind,
        acceptedAt: invocation.acceptedAt,
        ...invocation.metadata,
      },
    ];
  }
  return normalizePayload(invocation.payload);
}

function normalizePayload(payload: unknown): Record<string, unknown>[] {
  const values = Array.isArray(payload) ? payload : [payload ?? {}];
  return values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('trigger payload records must be JSON objects');
    }
    return value as Record<string, unknown>;
  });
}
