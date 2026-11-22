/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reading a run's event log: what level each event is, which ones are
 * problems, and the plain-text form a user can download and attach to a
 * ticket. Pure functions; the Runs panel renders them.
 */
import type { RunEvent, RunRecord } from "../api/engineClient";

export type EventLevel = "error" | "warn" | "info" | "debug";

const FAILED_STATUSES = new Set(["failed"]);
const WARN_STATUSES = new Set([
  "cancelled",
  "skipped",
  "interrupted",
  "paused",
]);

function dataString(event: RunEvent, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === "string" ? value : undefined;
}

/** How loud an event is. A failed status or an error log is an error. */
export function eventLevel(event: RunEvent): EventLevel {
  const level = dataString(event, "level");
  if (level === "error" || level === "warn") return level;
  const status = dataString(event, "status");
  if (status && FAILED_STATUSES.has(status)) return "error";
  if (event.type === "reject" || event.type === "retry.attempt") return "warn";
  if (status && WARN_STATUSES.has(status)) return "warn";
  if (event.type === "batch.sample" || event.type === "batch.progress")
    return "debug";
  return "info";
}

/** Events worth reading when something went wrong. */
export function isProblem(event: RunEvent): boolean {
  const level = eventLevel(event);
  return level === "error" || level === "warn";
}

/** Where the event happened: `pipeline/pipe`, `pipeline`, or '' for the run itself. */
export function eventScope(event: RunEvent): string {
  if (event.pipelineId && event.pipeId)
    return `${event.pipelineId}/${event.pipeId}`;
  return event.pipelineId ?? "";
}

/** Data fields the summary line already says; an event with only these has nothing to expand. */
const SUMMARISED_FIELDS = new Set(["status", "level"]);

/** Whether the event carries more than its summary line shows. */
export function hasDetail(event: RunEvent): boolean {
  return Object.keys(event.data ?? {}).some(
    (key) => !SUMMARISED_FIELDS.has(key),
  );
}

/** `14:03:12.185`, in the viewer's time zone. */
export function eventTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** The short what-happened for an event: status, batch size, sample size. */
export function eventSummary(event: RunEvent): string {
  const parts: string[] = [];
  const status = dataString(event, "status");
  if (event.type === "batch.sample") {
    const direction = dataString(event, "direction");
    const count = event.data?.recordCount;
    parts.push(
      `sample ${direction ?? ""} ${typeof count === "number" ? `${count} row(s)` : ""}`.trim(),
    );
  } else if (event.type === "batch.progress") {
    const records = event.data?.records;
    parts.push(
      `batch ${status ?? ""}${typeof records === "number" ? ` · ${records} row(s)` : ""}`.trim(),
    );
  } else if (status) {
    parts.push(status);
  }
  if (event.message) parts.push(event.message);
  return parts.join(" — ");
}

/** `run.status` becomes `run`, `pipe.status` becomes `pipe`; other types stay. */
export function eventKind(event: RunEvent): string {
  if (
    event.type === "retry.attempt" &&
    dataString(event, "kind") === "ai.failover"
  )
    return "ai.failover";
  return event.type.endsWith(".status")
    ? event.type.slice(0, -".status".length)
    : event.type;
}

/** Milliseconds as `850 ms`, `2.4 s` or `3 m 05 s`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
}

/** A finished run's wall time, when it has one. */
export function runDuration(
  run: Pick<RunRecord, "startedAt" | "finishedAt">,
): number | undefined {
  if (!run.finishedAt) return undefined;
  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}

/**
 * The run as a plain-text log: a header, then one line per event with its
 * data underneath. What a user downloads to keep or send to someone.
 */
export function runLogText(run: RunRecord, events: RunEvent[]): string {
  const header = [
    `Run ${run.id}`,
    `Workflow ${run.workflowId} v${run.workflowVersion}`,
    `Status ${run.status}${run.error ? ` — ${run.error}` : ""}`,
    `Trigger ${run.trigger}`,
    `Started ${run.startedAt}${run.finishedAt ? `  Finished ${run.finishedAt} (${formatDuration(runDuration(run))})` : ""}`,
    "",
  ];
  const lines = events.flatMap((event) => {
    const where = [eventKind(event), eventScope(event)]
      .filter(Boolean)
      .join(" ");
    const summary = eventSummary(event);
    const line = `#${event.seq} ${event.at} ${eventLevel(event).toUpperCase().padEnd(5)} ${where}${summary ? ` — ${summary}` : ""}`;
    return hasDetail(event)
      ? [line, `    ${JSON.stringify(event.data)}`]
      : [line];
  });
  return [...header, ...lines, ""].join("\n");
}

/** Hands the browser a file to save. */
export function downloadFile(
  filename: string,
  contents: string,
  type: string,
): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
