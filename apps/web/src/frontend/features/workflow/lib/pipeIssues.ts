/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which pipe a problem belongs to, so the canvas can mark it: a failed pipe in
 * the last Test run, a validation error the API pinned to a pipe, or a config
 * that is not valid JSON and so cannot be saved.
 */

/** What the canvas shows on a pipe; `null` when there is nothing to flag. */
export type PipeIssue =
  | { kind: 'run-failed'; message: string }
  /**
   * Stopped rather than failed: cut short by a pipe downstream that failed,
   * or by the run being cancelled. `causeId` names the failed pipe when known.
   */
  | { kind: 'run-stopped'; message: string; causeId?: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'config'; message: string };

/**
 * Where a validation error points. The API names the culprit as
 * `pipeline <id>, pipe <id>: …` (shape and usability checks) or
 * `pipeline <id>: …` (roots, cycles); anything else names no pipe.
 */
export function validationTarget(
  message: string,
): { pipelineId: string; pipeId?: string; detail: string } | null {
  // `detail` is what follows the location prefix: the part worth showing on a pipe.
  const rest = (match: RegExpExecArray) =>
    message.slice(match.index + match[0].length).trim() || message;
  const both = /\bpipeline ([\w.-]+), pipe ([\w.-]+):/.exec(message);
  if (both) return { pipelineId: both[1]!, pipeId: both[2]!, detail: rest(both) };
  const pipeline = /\bpipeline ([\w.-]+):/.exec(message);
  return pipeline ? { pipelineId: pipeline[1]!, detail: rest(pipeline) } : null;
}

/**
 * Statuses the engine reports for a pipe that failed. `cancelled` is not one:
 * the engine records it for a pipe stopped by a failure downstream ("Stopped
 * because pipe X failed.") or by a cancelled run.
 */
const FAILED = new Set(['failed', 'error', 'timeout', 'timed_out']);

export function isFailedStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED.has(status);
}

export function isStoppedStatus(status: string | undefined): boolean {
  return status === 'cancelled';
}

/** The pipe a "Stopped because pipe X failed." message names, if any. */
export function stoppedByPipe(message: string | undefined): string | undefined {
  return message ? /^Stopped because pipe ([\w.-]+) failed\.$/.exec(message)?.[1] : undefined;
}

/** Whether a pipe's raw config would fail to save, and why. */
export function configProblem(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? null
      : 'Config must be a JSON object.';
  } catch (error) {
    return `Config is not valid JSON: ${(error as Error).message}`;
  }
}

/**
 * Tell the pipe that failed from the ones that only stopped because of it.
 *
 * Before the engine recorded upstream pipes as stopped, a pipe that threw
 * left every pipe upstream of it recorded as failed with the same error: a
 * run where only `paid` threw listed `start`, `check` and `route` as failed
 * too. Runs recorded then still read that way, so the canvas still traces it. A failed pipe is the origin when none of
 * the pipes it feeds failed with the same message; any other failed pipe is
 * traced downstream, along pipes that failed with that message, to its origin.
 *
 * Returns, per failed pipe id, the id of the pipe that caused it (itself when
 * it is an origin).
 */
export function failureOrigins(
  failed: ReadonlyMap<string, string>,
  edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, string> {
  const downstream = new Map<string, string[]>();
  for (const edge of edges) {
    const list = downstream.get(edge.source) ?? [];
    list.push(edge.target);
    downstream.set(edge.source, list);
  }
  const sameFailure = (id: string) =>
    (downstream.get(id) ?? []).filter(
      (target) => failed.has(target) && failed.get(target) === failed.get(id),
    );

  const origin = new Map<string, string>();
  for (const id of failed.keys()) {
    // Walk downstream through same-message failures; the first pipe with no
    // such successor is the cause. `seen` guards against a cycle.
    let current = id;
    const seen = new Set([current]);
    for (;;) {
      const next = sameFailure(current).find((target) => !seen.has(target));
      if (!next) break;
      seen.add(next);
      current = next;
    }
    origin.set(id, current);
  }
  return origin;
}
