/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What GET /api/system/services answers: the state of the processes the app
 * runs, for the Services card on Home (docs/plans/2026-11-01-service-status.md).
 * The Web UI is not reported: the page asking is the proof it runs.
 */

export interface ApiServiceStatus {
  /** The API answered, so it runs. */
  state: 'running';
  version: string;
  uptimeSec: number;
}

export interface EngineServiceStatus {
  /**
   * - `running`: its /health answered.
   * - `not_configured`: it did not answer, and this server lacks what running
   *   it needs (named in `detail`).
   * - `unreachable`: it did not answer, though everything is set.
   */
  state: 'running' | 'not_configured' | 'unreachable';
  /** Why it is not running, or a note while it runs (not taking new runs). */
  detail?: string;
  version?: string;
  /** Running and admitting new runs (Workflow settings state `enabled`). */
  acceptsRuns?: boolean;
}

export interface ServiceStatusReport {
  api: ApiServiceStatus;
  engine: EngineServiceStatus;
}
