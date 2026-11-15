/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether this process has started the in-process workflow engine. Kept in its
 * own file so settings health can read it without importing the host.
 */
let ready = false;

export function markWorkflowEngineReady(value: boolean): void {
  ready = value;
}

export function isWorkflowEngineReady(): boolean {
  return ready;
}
