/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine: definitions, compiler, runtime, stores and the built-in pipes.
 */
export { Engine, type EngineOptions } from './engine.js';

export * from './common/index.js';
export * from './compiler/index.js';
export * from './registry/index.js';
export * from './runtime/index.js';
export * from './sdk/index.js';
export {
  CsvSourcePipe,
  TextSourcePipe,
  JsonSourcePipe,
  parseCsvRecords,
  parseTextRecords,
  parseTextRows,
  applyColumnRules,
  resolveColumnChecks,
  compileColumnRules,
  invalidRecords,
  COLUMN_TYPES,
  COLUMN_CHECK_KINDS,
  columnRuleFieldsSchema,
  csvConfigFields,
  textConfigFields,
  textFormatRefine,
  MapPipe,
  ConditionPipe,
  DedupePipe,
  AggregatePipe,
  RedactPipe,
  type AggregateMetric,
  createDefaultPipeRegistry,
  resolveWorkflowFile,
  openWorkflowFile,
  type WorkflowFile,
  workflowFilesRoot,
  FILES_DIR_ENV,
} from './pipes/utility/index.js';
export {
  HttpSourcePipe,
  MultiHttpSourcePipe,
  HttpSinkPipe,
  HttpResponsePipe,
  shapeRunOutput,
} from './pipes/http/index.js';
export {
  TriggerPayloadSourcePipe,
  ManualTriggerSourcePipe,
  CronTriggerSourcePipe,
  WebhookTriggerSourcePipe,
  ParentTriggerSourcePipe,
} from './pipes/trigger/index.js';
export {
  NATIVE_ADDON_SQL_DIALECTS,
  MappedDbSinkPipe,
  PostgresSinkPipe,
  PostgresSourcePipe,
  SharedHandleGate,
  SqlSinkPipe,
  SqlSourcePipe,
  applyColumnMapping,
  gateForHandle,
  columnMappingItemSchema,
  resolveUpsertKeys,
  setSqlRunnerDelegate,
  upsertSql,
  type ColumnMappingItem,
  type GateSession,
  type PostgresClient,
  type PostgresClientFactory,
  type SqlConnection,
  type SqlRunner,
  type SqlSession,
} from './pipes/db/index.js';
export {
  mergeBatches,
  splitBatch,
  goto,
  runLoop,
  MergePipe,
  SplitPipe,
  LoopPipe,
  SubWorkflowPipe,
  HumanGatePipe,
} from './pipes/control/index.js';
export * from './storage/index.js';
export { EmailSinkPipe, SmsSinkPipe } from './pipes/notify/index.js';
