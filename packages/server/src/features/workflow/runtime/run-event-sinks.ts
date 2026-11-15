/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Run events copied to files, so an operator can ship the engine's logs to
 * wherever they keep logs.
 *
 * `json` appends one JSON object per line; `text` appends one readable line.
 * A sink's target is a file name inside the log directory, never a path: the
 * setting comes from FoxSchema's admin screen, and a path would let that screen
 * write anywhere this process can. `events` is the engine's own event store,
 * which is always on.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowLogSink } from '@foxschema/workflow-contract';
import type { RunEvent } from '@foxschema/workflow-engine';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_FILE: Record<'json' | 'text', string> = {
  json: 'run-events.jsonl',
  text: 'run-events.log',
};

/** One readable line: when, what, which run and pipe, and the message. */
export function formatTextLine(event: RunEvent): string {
  const level = typeof event.data?.level === 'string' ? event.data.level.toUpperCase() : undefined;
  const status = typeof event.data?.status === 'string' ? event.data.status : undefined;
  const where = [event.pipelineId, event.pipeId].filter(Boolean).join('/');
  return [event.at, level ?? event.type, `run=${event.workflowRunId}`, where, status, event.message]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

export class RunEventSinks {
  private readonly streams = new Map<string, { kind: 'json' | 'text'; stream: WriteStream }>();
  private applied = '';

  constructor(
    private readonly directory: string | undefined,
    private readonly onError: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** Open the sinks `sinks` asks for. Settings that did not change leave the files alone. */
  configure(sinks: readonly WorkflowLogSink[]): void {
    const wanted = sinks.filter(
      (sink): sink is WorkflowLogSink & { kind: 'json' | 'text' } =>
        sink.enabled && (sink.kind === 'json' || sink.kind === 'text'),
    );
    const signature = JSON.stringify(wanted.map((sink) => [sink.kind, sink.target ?? '']));
    if (signature === this.applied) return;
    this.applied = signature;
    void this.close();
    if (wanted.length === 0) return;
    if (!this.directory) {
      this.onError('run event sinks are enabled, but there is no log directory (WORKFLOW_LOG_DIR); nothing is written');
      return;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's log directory, from the environment
    mkdirSync(this.directory, { recursive: true });
    for (const sink of wanted) {
      const name = sink.target?.trim() || DEFAULT_FILE[sink.kind];
      if (!FILE_NAME.test(name)) {
        this.onError(`run event sink target must be a file name, not a path: ${name}`);
        continue;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a checked file name inside the log directory
      const stream = createWriteStream(join(this.directory, name), { flags: 'a' });
      stream.on('error', (error) => this.onError(`run event sink ${name}: ${error.message}`));
      this.streams.set(name, { kind: sink.kind, stream });
    }
  }

  write(event: RunEvent): void {
    for (const { kind, stream } of this.streams.values()) {
      stream.write(`${kind === 'json' ? JSON.stringify(event) : formatTextLine(event)}\n`);
    }
  }

  /** Flush and close every open file. */
  async close(): Promise<void> {
    const open = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(
      open.map(({ stream }) => new Promise<void>((resolve) => stream.end(() => resolve()))),
    );
  }
}
