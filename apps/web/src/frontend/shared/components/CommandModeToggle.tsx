/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Command mode: the same statement as a shell command for the engine's own
 * client, for someone who would rather run it themselves.
 *
 * Three shapes, because where the server lives decides what is useful: the
 * client run directly, the same thing inside `docker exec`, or a script to
 * save and review.
 *
 * The password is never in any of them. Fox Schema does not hold it in the
 * browser, and a password on a command line shows up in `ps` and in shell
 * history — so the client is told to prompt, and this says so before the user
 * runs something that appears to hang.
 */
import React, { useMemo, useState } from 'react';
import { Copy, Check, Terminal, Download } from 'lucide-react';
import { buildCliCommand, formatCommand, type CliTarget, type CommandFormat } from '@foxschema/ui-shared';

interface Props {
  sql: string;
  dialect: string;
  target: CliTarget;
  /** Pre-fills the container box, for a connection already known to be one. */
  defaultContainer?: string;
  'data-testid'?: string;
}

const FORMAT_LABEL: Record<CommandFormat, string> = {
  raw: 'Command',
  docker: 'Docker',
  script: 'Shell script',
};

const FORMAT_HINT: Record<CommandFormat, string> = {
  raw: 'Runs the client on this machine.',
  docker: 'Runs the client inside a container. -i keeps stdin open, without which the statement is discarded.',
  script: 'A file to save, read, and run. Stops at the first error.',
};

export const CommandModeToggle: React.FC<Props> = ({
  sql,
  dialect,
  target,
  defaultContainer = '',
  'data-testid': testId = 'command-mode',
}) => {
  const [copied, setCopied] = useState(false);
  const [format, setFormat] = useState<CommandFormat>('raw');
  const [container, setContainer] = useState(defaultContainer);

  const built = useMemo(
    () => (sql.trim() ? buildCliCommand(sql, dialect, target) : null),
    [sql, dialect, target]
  );

  const formatted = useMemo(
    () => (built && !('error' in built) ? formatCommand(built, { format, container }) : null),
    [built, format, container]
  );

  if (!built) return null;

  if ('error' in built) {
    return (
      <p data-testid={`${testId}-error`} className="text-[11px] text-amber-200">
        {built.error}
      </p>
    );
  }

  const text = formatted && !('error' in formatted) ? formatted.text : '';

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be refused; the text is on screen to select by hand.
      setCopied(false);
    }
  };

  const save = () => {
    if (!formatted || 'error' in formatted || !formatted.filename) return;
    const blob = new Blob([formatted.text], { type: 'text/x-shellscript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = formatted.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
          <Terminal className="w-3.5 h-3.5" />
          Run it yourself — needs <code className="text-slate-300">{built.client}</code>
        </span>

        <div className="flex items-center gap-1.5">
          <select
            data-testid={`${testId}-format`}
            aria-label="Command format"
            value={format}
            onChange={(e) => setFormat(e.target.value as CommandFormat)}
            className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-[11px] text-slate-100"
          >
            {(Object.keys(FORMAT_LABEL) as CommandFormat[]).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>

          {format === 'script' && (
            <button
              type="button"
              data-testid={`${testId}-save`}
              onClick={save}
              disabled={!text}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-600 bg-slate-800 text-[11px] font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
            >
              <Download className="w-3 h-3" />
              Save .sh
            </button>
          )}

          <button
            type="button"
            data-testid={`${testId}-copy`}
            onClick={() => void copy()}
            disabled={!text}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-600 bg-slate-800 text-[11px] font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {format === 'docker' && (
        <input
          data-testid={`${testId}-container`}
          aria-label="Container name"
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          placeholder="container name, e.g. foxschema-postgres"
          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-[11px] font-mono text-slate-200 placeholder:text-slate-600"
        />
      )}

      {formatted && 'error' in formatted ? (
        <p data-testid={`${testId}-format-error`} className="text-[11px] text-amber-200">
          {formatted.error}
        </p>
      ) : (
        <pre
          data-testid={`${testId}-command`}
          className="whitespace-pre-wrap break-all rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-[11px] font-mono text-slate-200"
        >
          {text}
        </pre>
      )}

      <p className="text-[11px] text-slate-500">
        {FORMAT_HINT[format]} {built.explanation}
        {built.auth === 'prompts' && ' It waits for the password — that is the prompt, not a hang.'}
        {built.auth === 'none' && ' No login: file permissions decide who may write.'}
      </p>

      {built.note && <p className="text-[11px] text-slate-500">{built.note}</p>}
    </div>
  );
};
