/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The error contract: one vocabulary for every failure the API reports.
 *
 * The server already had `ServiceErrorCode`, and it worked — but it was used at
 * one of 144 error sites, and even there the code never reached the client. The
 * response was `{ error: "..." }`: a status and a human sentence. A caller that
 * wants to tell "you are not signed in" from "your session expired", or to
 * retry only on a lock conflict, had nothing to branch on but prose. Message
 * text is for people; `code` is for programs, and the two change for different
 * reasons.
 *
 * The codes below are not aspirational — each maps to a status this API already
 * returns, counted across the route files:
 *
 *   400 × 68   invalid_input          409 × 5   conflict
 *   500 × 25   failed / internal      401 × 4   unauthenticated
 *   404 × 16   not_found              403 × 3   forbidden
 *   429 × 1    rate_limited           422 × 1   idempotency_mismatch
 *
 * Lives in `shared` rather than the server because the frontend is the party
 * that has to switch on it. A contract only one side can see is not a contract.
 */

/**
 * Every failure the API can report.
 *
 * Adding one is a wire change: clients may switch on these, so treat the list
 * the way you would treat a public enum. Prefer reusing a code over minting a
 * near-synonym — `code` answers "what should the caller do?", and two codes
 * that call for the same action should be one code with different messages.
 */
export type ErrorCode =
  /** No credentials, or a session that is no longer valid. Sign in. */
  | 'unauthenticated'
  /** Authenticated, but lacks the permission. Signing in again will not help. */
  | 'forbidden'
  /** The request itself is malformed — wrong shape, missing field, bad value. */
  | 'invalid_input'
  /** The named thing does not exist, or is not visible to this caller. */
  | 'not_found'
  /** Refused because of current state, not the request. Retrying may work. */
  | 'conflict'
  /** Too many requests. `retryAfterSec` says when to come back. */
  | 'rate_limited'
  /** Body too large to accept. */
  | 'payload_too_large'
  /**
   * An idempotency key was reused with a different body. Not `conflict`: the
   * caller has a bug, and retrying the same request will never succeed.
   */
  | 'idempotency_mismatch'
  /**
   * A database or dependency is unreachable — including a circuit the breaker
   * has opened. Distinct from `failed` because the caller should back off
   * rather than treat it as a bug in their request.
   */
  | 'unavailable'
  /** The operation ran too long and was abandoned. */
  | 'timeout'
  /** Anything genuinely unexpected. The only code that means "our fault". */
  | 'failed';

/**
 * Response header the session guard sets, with value `1`, when the workspace a
 * request named in `X-Fox-Workspace` does not exist for the caller (left,
 * archived, deleted, or an id from another install on the same origin). The
 * 404 itself stays as it is; this only lets the browser tell it from a
 * not-found for something the request named, and re-open the default workspace.
 */
export const WORKSPACE_UNAVAILABLE_HEADER = 'x-fox-workspace-unavailable';

/** HTTP status per code — the REST transport's whole translation table. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  idempotency_mismatch: 422,
  unavailable: 503,
  timeout: 504,
  failed: 500,
};

/**
 * One field that failed validation.
 *
 * `path` is dotted, so a nested field reads `source.config.host` — enough for a
 * form to mark the offending input rather than showing a banner.
 */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * The body of every error response.
 *
 * `error` carries the message for a person; `code` carries the decision for a
 * program. `ok: false` is included because a third of the existing responses
 * already send it and clients check it — dropping it would be a silent
 * breaking change for them, and it costs one field to keep both shapes valid.
 */
export interface ApiErrorBody {
  readonly ok: false;
  readonly error: string;
  readonly code: ErrorCode;
  /** Present on `invalid_input` when specific fields can be named. */
  readonly fields?: readonly FieldError[];
  /** Present on `rate_limited`, and on `unavailable` when the wait is known. */
  readonly retryAfterSec?: number;
}

/** True when a response body follows the error contract. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return typeof body.error === 'string' && typeof body.code === 'string';
}
