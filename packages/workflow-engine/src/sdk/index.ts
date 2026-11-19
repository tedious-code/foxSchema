/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/sdk/src/index.ts).
 */
export { interpolate, interpolateDeep, splitTemplate } from './pipe/template.js';
export {
  definePipeMetadata,
  type PipeMetadata,
  type PipeMetadataInput,
  type PipeProvider,
  type PortDef,
} from './pipe/metadata.js';
export {
  ERROR_POLICIES,
  REJECT_POLICIES,
  REJECTS_PORT,
  batchSizeField,
  concurrencyField,
  errorPolicyField,
  mapRecordsConcurrently,
  recordContractFields,
  rejectPolicyField,
  type ConcurrentMapResult,
  type ErrorPolicy,
  type RejectPolicy,
} from './pipe/traits.js';
export {
  createInfrastructureContext,
  type CreateInfrastructureOptions,
  type ErrorAction,
  type InfrastructureContext,
  type PipeLogger,
} from './pipe/infrastructure.js';
export {
  runSandboxed,
  runSandboxedWithLogs,
  setScriptSandboxDelegate,
  SandboxError,
  SandboxTimeoutError,
  type ScriptSandboxDelegate,
  type SandboxLog,
  type SandboxOptions,
  type SandboxOutcome,
} from './pipe/sandbox.js';
