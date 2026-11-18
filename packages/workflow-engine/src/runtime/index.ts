/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/index.ts).
 */
export {
  PipelineExecutor,
  ExecutionError,
  TransientExecutionError,
  type PipelineExecutionContext,
  type PipelineExecutorOptions,
} from './executor.js';
export {
  WorkflowRunner,
  LocalRunScheduler,
  type PipelineExecutionPort,
  type WorkflowRunnerOptions,
  type LocalRunSchedulerOptions,
  type EnqueueResult,
  RUN_OUTPUT_EVENT,
} from './workflow.js';
export { evaluateGate, type GateContext } from './gates.js';
export { applyContract, ContractViolationError } from './contracts.js';
export {
  credentialIdsFor,
  scopeCredentialsToPipe,
  CredentialAccessError,
} from './credential-scope.js';
export {
  authenticateHttpTrigger,
  TriggerAuthenticationError,
} from './triggers.js';
export {
  assertKnownFromPorts,
  defaultOutputPort,
  edgeMatchesPort,
  normalizePortedBatches,
  outputPortNames,
  type PortedBatch,
  type TransformOutput,
} from './ports.js';

export { CronCoordinator, type CronCoordinatorOptions } from './scheduler/cron.js';

export {
  createWorkflowServiceFactory,
  type WorkflowServiceFactoryOptions,
} from './workflow-service.js';

export {
  MiddlewareRegistry,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareContext,
  type MiddlewareTier,
  type ResolvedMiddleware,
} from './middleware.js';
export {
  createDefaultMiddlewareRegistry,
  logMiddleware,
} from './builtin-middleware.js';

export {
  assertReadOnly,
  evaluatePrecondition,
  meetsExpectation,
  type SqlEngine,
  type SqlPrecondition,
  type SqlProbe,
} from './scheduler/sql-precondition.js';

export {
  ERROR_HANDLER_METADATA_KEY,
  type ErrorHandlerDispatch,
} from './workflow.js';

export { authenticateWebhook, headerValue, type WebhookAuthRequest } from './webhook-auth.js';
