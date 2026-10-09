/**
 * The contract every feature service is written against.
 *
 * A service never sees `req` or `res`. It takes a typed input plus an
 * ActorContext and returns typed output or throws a ServiceError. Transports
 * (REST today, GraphQL later) translate in both directions.
 *
 * This is what makes a second transport cheap: the permission check lives with
 * the business logic instead of in Express middleware, so a GraphQL resolver
 * cannot accidentally skip it. Every RBAC gap found so far came from a second
 * code path re-implementing a check.
 */
import {
  ERROR_STATUS,
  type ApiErrorBody,
  type ErrorCode,
  type FieldError,
  type Permission,
} from '@foxschema/shared';
import type { WorkspaceScope } from '../http/scope';

export interface ActorContext {
  /** Undefined for an unauthenticated caller. */
  readonly userId: string | undefined;
  /** Who and where, for workspace-owned rows. Undefined before sign-in. */
  readonly scope?: WorkspaceScope;
  /** True when the actor holds (or subsumes) the permission. */
  can(permission: Permission): boolean;
}

/**
 * The vocabulary lives in `@foxschema/shared` because the browser has to switch
 * on it. Re-exported under the old name so services read the same as before.
 */
export type ServiceErrorCode = ErrorCode;

export class ServiceError extends Error {
  readonly code: ErrorCode;
  /** Named fields, when the failure is a validation failure. */
  readonly fields?: readonly FieldError[];
  /** Seconds to wait, on `rate_limited` and a known-duration `unavailable`. */
  readonly retryAfterSec?: number;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { fields?: readonly FieldError[]; retryAfterSec?: number }
  ) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.fields = options?.fields;
    this.retryAfterSec = options?.retryAfterSec;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  /** The wire body for this error, per the shared contract. */
  toBody(): ApiErrorBody {
    return {
      ok: false,
      error: this.message,
      code: this.code,
      ...(this.fields?.length ? { fields: this.fields } : {}),
      ...(this.retryAfterSec !== undefined ? { retryAfterSec: this.retryAfterSec } : {}),
    };
  }
}

/** Throw unless the actor holds `permission`. */
export function requirePermission(actor: ActorContext, permission: Permission): void {
  if (!actor.userId) {
    throw new ServiceError('unauthenticated', 'Authentication required');
  }
  if (!actor.can(permission)) {
    throw new ServiceError('forbidden', `Permission denied: this action needs "${permission}".`);
  }
}

/**
 * Recognise the failures that are about reachability rather than the request.
 *
 * `CircuitOpenError` is thrown by the driver layer when a target has been
 * failing and the breaker stopped trying. Reported as `failed` it reads as a
 * bug in Fox Schema; as `unavailable` it tells the caller to back off, which is
 * the truth and the useful instruction. Matched structurally because
 * `packages/db` must not be imported for its classes here — the code and the
 * `retryAfterMs` field are the contract.
 */
function asCircuitOpen(error: unknown): { retryAfterSec: number } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { code?: unknown; retryAfterMs?: unknown };
  if (e.code !== 'CIRCUIT_OPEN') return undefined;
  const ms = typeof e.retryAfterMs === 'number' ? e.retryAfterMs : 0;
  return { retryAfterSec: Math.max(1, Math.ceil(ms / 1000)) };
}

/**
 * Map any thrown value to the wire error contract.
 *
 * Non-ServiceError throws become `failed` with their own message, matching what
 * the route handlers did before — a driver error still reaches the client
 * rather than being flattened to something generic.
 */
export function toApiError(error: unknown, fallback: string): ApiErrorBody {
  if (error instanceof ServiceError) return error.toBody();

  const circuit = asCircuitOpen(error);
  if (circuit) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : fallback,
      code: 'unavailable',
      retryAfterSec: circuit.retryAfterSec,
    };
  }

  return {
    ok: false,
    error: error instanceof Error ? error.message : fallback,
    code: 'failed',
  };
}

/** Status plus body, for a transport that needs both. */
export function toHttpError(
  error: unknown,
  fallback: string
): { status: number; body: ApiErrorBody } {
  const body = toApiError(error, fallback);
  return { status: ERROR_STATUS[body.code], body };
}
