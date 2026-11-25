/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/transforms.ts).
 */
import { createHash } from 'node:crypto';
import * as z from 'zod';
import type {
  PipeContext,
  RecordBatch,
  TransformPipe,
} from '../../registry/index.js';
import { REJECTS_PORT, definePipeMetadata, type PipeMetadata } from '../../sdk/index.js';
import { splitBatch } from '../control/index.js';
import { getPath } from '../../common/index.js';

const mapConfigSchema = z.object({
  mappings: z
    .record(z.string(), z.string().min(1))
    .refine((mappings) => Object.keys(mappings).length > 0, 'mappings required'),
  includeOriginal: z.boolean().default(true),
});

export class MapPipe implements TransformPipe {
  readonly type = 'transform.map';
  readonly role = 'transform';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Map fields',
      category: 'Transform',
      family: 'logic',
      version: '0.1.0',
      role: 'transform',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: mapConfigSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    mapConfigSchema.parse(config);
  }

  async transform(
    batch: RecordBatch,
    context: PipeContext,
  ): Promise<RecordBatch> {
    const config = mapConfigSchema.parse(context.pipe.config);
    return {
      ...batch,
      records: batch.records.map((record) => {
        const mapped = Object.fromEntries(
          Object.entries(config.mappings).map(([target, source]) => [
            target,
            getPath(record, source),
          ]),
        );
        return config.includeOriginal ? { ...record, ...mapped } : mapped;
      }),
    };
  }
}

/**
 * Verify rules and trigger conditions spell comparisons `op: 'gt'`; this pipe
 * has always spelled them `operator: 'greaterThan'`. Both spellings are
 * accepted here so a rule copied from one to the other just works — the
 * saved form keeps whichever the author wrote.
 */
const CONDITION_OPERATOR_ALIASES: Record<string, string> = {
  gt: 'greaterThan',
  gte: 'greaterThanOrEqual',
  lt: 'lessThan',
  lte: 'lessThanOrEqual',
};

function normalizeConditionConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const { op, ...rest } = config as Record<string, unknown>;
  const operator = rest.operator ?? op;
  return {
    ...rest,
    ...(operator === undefined
      ? {}
      : {
          operator:
            typeof operator === 'string'
              ? (CONDITION_OPERATOR_ALIASES[operator] ?? operator)
              : operator,
        }),
  };
}

const conditionFieldsSchema = z.object({
  field: z.string().min(1),
  operator: z.enum([
    'equals',
    'notEquals',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'contains',
    'exists',
  ]),
  value: z.unknown().optional(),
});

const conditionConfigSchema = z.preprocess(
  normalizeConditionConfig,
  conditionFieldsSchema,
);

export class ConditionPipe implements TransformPipe {
  readonly type = 'transform.condition';
  readonly role = 'transform';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Condition',
      // Branching belongs to Logic; the `transform.` type id is frozen so
      // saved workflows keep resolving (same precedent as source.trigger.cron).
      category: 'Logic',
      family: 'logic',
      version: '0.2.0',
      role: 'transform',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [
        { name: 'true', type: 'records' },
        { name: 'false', type: 'records' },
      ],
      configSchema: conditionFieldsSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    conditionConfigSchema.parse(config);
  }

  async transform(
    batch: RecordBatch,
    context: PipeContext,
  ): Promise<Map<string, RecordBatch>> {
    const config = conditionConfigSchema.parse(context.pipe.config);
    return splitBatch(batch, (record) =>
      compare(getPath(record, config.field), config.operator, config.value)
        ? 'true'
        : 'false',
    );
  }
}

function compare(
  actual: unknown,
  operator: z.infer<typeof conditionConfigSchema>['operator'],
  expected: unknown,
): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'greaterThan':
      return comparable(actual) > comparable(expected);
    case 'greaterThanOrEqual':
      return comparable(actual) >= comparable(expected);
    case 'lessThan':
      return comparable(actual) < comparable(expected);
    case 'lessThanOrEqual':
      return comparable(actual) <= comparable(expected);
    case 'contains':
      return typeof actual === 'string'
        ? actual.includes(String(expected))
        : Array.isArray(actual) && actual.includes(expected);
    case 'exists':
      return actual !== undefined && actual !== null;
  }
}

function comparable(value: unknown): number | string {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

const dedupeConfigSchema = z.object({
  keys: z.array(z.string().min(1)).min(1),
  keep: z.enum(['first', 'last']).default('last'),
});

export class DedupePipe implements TransformPipe {
  readonly type = 'transform.dedupe';
  readonly role = 'transform';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Deduplicate',
      category: 'Transform',
      family: 'logic',
      tags: ['dedupe', 'unique', 'distinct', 'dba', 'etl'],
      version: '0.1.0',
      role: 'transform',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [
        { name: 'out', type: 'records' },
        { name: REJECTS_PORT, type: 'records' },
      ],
      configSchema: dedupeConfigSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    dedupeConfigSchema.parse(config);
  }

  async transform(
    batch: RecordBatch,
    context: PipeContext,
  ): Promise<Map<string, RecordBatch>> {
    const config = dedupeConfigSchema.parse(context.pipe.config);
    const keyOf = (record: Record<string, unknown>): string =>
      JSON.stringify(config.keys.map((k) => getPath(record, k) ?? null));

    const unique: Record<string, unknown>[] = [];
    const duplicates: Record<string, unknown>[] = [];

    if (config.keep === 'first') {
      const seen = new Set<string>();
      for (const record of batch.records) {
        const k = keyOf(record);
        if (seen.has(k)) {
          duplicates.push(record);
        } else {
          seen.add(k);
          unique.push(record);
        }
      }
    } else {
      const lastIndexByKey = new Map<string, number>();
      const keys = batch.records.map((record, idx) => {
        const k = keyOf(record);
        lastIndexByKey.set(k, idx);
        return k;
      });
      batch.records.forEach((record, idx) => {
        if (lastIndexByKey.get(keys[idx]!) === idx) {
          unique.push(record);
        } else {
          duplicates.push(record);
        }
      });
    }

    const ports = new Map<string, RecordBatch>();
    if (unique.length > 0) ports.set('out', { ...batch, records: unique });
    if (duplicates.length > 0) {
      ports.set(REJECTS_PORT, {
        ...batch,
        id: `${batch.id}:${REJECTS_PORT}`,
        records: duplicates,
      });
    }
    return ports;
  }
}

const aggregateMetricSchema = z.object({
  fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  field: z.string().optional(),
  as: z.string().min(1),
});

export type AggregateMetric = z.infer<typeof aggregateMetricSchema>;

const aggregateConfigSchema = z.object({
  groupBy: z.array(z.string().min(1)).default([]),
  metrics: z.array(aggregateMetricSchema).min(1),
});

export class AggregatePipe implements TransformPipe {
  readonly type = 'transform.aggregate';
  readonly role = 'transform';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Aggregate',
      category: 'Transform',
      family: 'logic',
      tags: ['aggregate', 'group-by', 'sum', 'count', 'rollup', 'dba'],
      version: '0.1.0',
      role: 'transform',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: aggregateConfigSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    aggregateConfigSchema.parse(config);
  }

  async transform(
    batch: RecordBatch,
    context: PipeContext,
  ): Promise<RecordBatch> {
    const config = aggregateConfigSchema.parse(context.pipe.config);
    if (batch.records.length === 0) return { ...batch, records: [] };

    const groups = new Map<
      string,
      { keys: Record<string, unknown>; rows: Record<string, unknown>[] }
    >();

    for (const record of batch.records) {
      const keyValues = config.groupBy.map((g) => getPath(record, g) ?? null);
      const groupKey = JSON.stringify(keyValues);
      let entry = groups.get(groupKey);
      if (!entry) {
        const keyObj: Record<string, unknown> = {};
        config.groupBy.forEach((g, idx) => {
          const outKey = g.includes('.') ? g.split('.').pop()! : g;
          keyObj[outKey] = keyValues[idx];
        });
        entry = { keys: keyObj, rows: [] };
        groups.set(groupKey, entry);
      }
      entry.rows.push(record);
    }

    const aggregated: Record<string, unknown>[] = [];
    for (const { keys, rows } of groups.values()) {
      const out: Record<string, unknown> = { ...keys };
      for (const metric of config.metrics) {
        if (metric.fn === 'count') {
          if (!metric.field) {
            out[metric.as] = rows.length;
          } else {
            out[metric.as] = rows.filter((r) => {
              const v = getPath(r, metric.field!);
              return v !== null && v !== undefined;
            }).length;
          }
          continue;
        }
        const rawVals = metric.field
          ? rows
              .map((r) => getPath(r, metric.field!))
              .filter((v) => v !== null && v !== undefined)
          : [];
        if (metric.fn === 'sum' || metric.fn === 'avg') {
          const nums = rawVals.map((v) => Number(v)).filter((n) => Number.isFinite(n));
          const sum = nums.reduce((acc, n) => acc + n, 0);
          out[metric.as] =
            metric.fn === 'sum'
              ? sum
              : nums.length > 0
                ? Number((sum / nums.length).toFixed(4))
                : 0;
        } else if (metric.fn === 'min') {
          out[metric.as] =
            rawVals.length === 0
              ? null
              : rawVals.reduce((best, cur) =>
                  comparable(cur) < comparable(best) ? cur : best,
                );
        } else if (metric.fn === 'max') {
          out[metric.as] =
            rawVals.length === 0
              ? null
              : rawVals.reduce((best, cur) =>
                  comparable(cur) > comparable(best) ? cur : best,
                );
        }
      }
      aggregated.push(out);
    }

    return {
      ...batch,
      records: aggregated,
    };
  }
}

const redactConfigSchema = z.object({
  fields: z.array(z.string().min(1)).min(1),
  strategy: z.enum(['mask', 'hash', 'null', 'drop']).default('mask'),
});

function maskScalar(value: unknown): string {
  const str = String(value);
  const atIndex = str.indexOf('@');
  if (atIndex > 0) {
    const local = str.slice(0, atIndex);
    const domain = str.slice(atIndex);
    return `${local[0] ?? '*'}***${domain}`;
  }
  if (str.length <= 4) return '***';
  return `***${str.slice(-4)}`;
}

export class RedactPipe implements TransformPipe {
  readonly type = 'transform.redact';
  readonly role = 'transform';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Redact PII',
      category: 'Transform',
      family: 'logic',
      tags: ['redact', 'mask', 'pii', 'privacy', 'hash', 'dba', 'security'],
      version: '0.1.0',
      role: 'transform',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: redactConfigSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    redactConfigSchema.parse(config);
  }

  async transform(
    batch: RecordBatch,
    context: PipeContext,
  ): Promise<RecordBatch> {
    const config = redactConfigSchema.parse(context.pipe.config);
    return {
      ...batch,
      records: batch.records.map((record) => {
        const clone: Record<string, unknown> = { ...record };
        for (const field of config.fields) {
          if (!(field in clone)) continue;
          const current = clone[field];
          if (config.strategy === 'drop') {
            delete clone[field];
          } else if (config.strategy === 'null') {
            clone[field] = null;
          } else if (current !== null && current !== undefined) {
            if (config.strategy === 'hash') {
              const digest = createHash('sha256')
                .update(String(current))
                .digest('hex')
                .slice(0, 16);
              clone[field] = `sha256:${digest}`;
            } else {
              clone[field] = maskScalar(current);
            }
          }
        }
        return clone;
      }),
    };
  }
}
