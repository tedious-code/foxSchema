/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/index.ts).
 */
export {
  VerifyPipe,
  verifyRecord,
  type VerifyConfig,
  type VerifyRule,
  type Verdict,
} from './verify.js';
export { resolveWorkflowFile, workflowFilesRoot, FILES_DIR_ENV } from './file-root.js';
export { openWorkflowFile, type WorkflowFile } from './workflow-files.js';
export { FileSinkPipe, escapeField, toRow, type FileSinkConfig } from './file-sink.js';
export {
  CsvSourcePipe,
  csvConfigFields,
  parseCsvRecords,
  deriveHeaders,
} from './csv.js';
export {
  TextSourcePipe,
  readLines,
  textConfigFields,
  textFormatRefine,
} from './text.js';
export { JsonSourcePipe } from './json.js';
export {
  fieldSplitter,
  fieldName,
  lineToRecords,
  parseLine,
  parseTextRecords,
  parseTextRows,
  sliceFixedLine,
  isHeaderRecord,
  configuredNames,
  columnRules,
  applyColumnRules,
  resolveColumnChecks,
  compileColumnRules,
  describeFailures,
  invalidRecords,
  COLUMN_TYPES,
  COLUMN_CHECK_KINDS,
  columnCheckSchema,
  columnChecksSchema,
  columnRuleFieldsSchema,
  type DelimitedLineOptions,
  type TextParseOptions,
  type FixedWidthColumn,
  type ColumnRule,
  type ColumnCheck,
  type CompiledColumnCheck,
  type ColumnCheckKind,
  type ColumnType,
  type ColumnFailure,
  type HeaderMode,
  type InvalidRecord,
} from './delimited.js';
export { MapPipe, ConditionPipe } from './transforms.js';
export { ScriptTransformPipe } from './script.js';

import { PipeRegistry } from '../../registry/index.js';
import { CsvSourcePipe } from './csv.js';
import { VerifyPipe } from './verify.js';
import { FileSinkPipe } from './file-sink.js';
import { TextSourcePipe } from './text.js';
import { JsonSourcePipe } from './json.js';
import { MapPipe, ConditionPipe } from './transforms.js';
import { ScriptTransformPipe } from './script.js';
import {
  HttpResponsePipe,
  HttpSinkPipe,
  HttpSourcePipe,
  MultiHttpSourcePipe,
  HttpTransformPipe,
} from '../http/index.js';
import {
  MysqlSinkPipe,
  MysqlSourcePipe,
  PostgresSinkPipe,
  PostgresSourcePipe,
  SqlSinkPipe,
  SqlSourcePipe,
} from '../db/index.js';
import { EmailSinkPipe, SmsSinkPipe } from '../notify/index.js';
import {
  CronTriggerSourcePipe,
  HttpTriggerSourcePipe,
  ManualTriggerSourcePipe,
  ParentTriggerSourcePipe,
  PollTriggerSourcePipe,
  TriggerPayloadSourcePipe,
  WebhookTriggerSourcePipe,
} from '../trigger/index.js';
import {
  LoopPipe,
  MergePipe,
  SplitPipe,
  SubWorkflowPipe,
  HumanGatePipe,
} from '../control/index.js';

export function createDefaultPipeRegistry(): PipeRegistry {
  return new PipeRegistry([
    new CsvSourcePipe(),
    new VerifyPipe(),
    new FileSinkPipe(),
    new TextSourcePipe(),
    new JsonSourcePipe(),
    new SqlSourcePipe(),
    new PostgresSourcePipe(),
    new MysqlSourcePipe(),
    new HttpSourcePipe(),
    new MultiHttpSourcePipe(),
    new HttpTransformPipe(),
    new TriggerPayloadSourcePipe(),
    new ManualTriggerSourcePipe(),
    new CronTriggerSourcePipe(),
    new WebhookTriggerSourcePipe(),
    new HttpTriggerSourcePipe(),
    new ParentTriggerSourcePipe(),
    new PollTriggerSourcePipe(),
    new MapPipe(),
    new ConditionPipe(),
    new ScriptTransformPipe(),
    new MergePipe(),
    new SplitPipe(),
    new LoopPipe(),
    new SqlSinkPipe(),
    new PostgresSinkPipe(),
    new MysqlSinkPipe(),
    new HttpSinkPipe(),
    new EmailSinkPipe(),
    new SmsSinkPipe(),
    new HttpResponsePipe(),
    new SubWorkflowPipe(),
    new HumanGatePipe(),
  ]);
}

