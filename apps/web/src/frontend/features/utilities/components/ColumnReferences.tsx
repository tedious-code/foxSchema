/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where a column is named inside the views, routines and triggers that read it.
 *
 * The engine renames a column; it does not rewrite the SQL inside a view or a
 * routine. "View v_open_orders may use it" tells somebody there is work without
 * telling them where, so this shows the lines: as written, and — when the change
 * renames — as they will have to read. Read-only on purpose; Fox does not edit
 * somebody else's routine, it shows them what to change.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ColumnDependent, ColumnReferenceLine } from '@/shared/lib/column-change';
import { sectionLabelCls } from '@/shared/components/surfaces';

const KIND_LABEL: Record<ColumnDependent['objectType'], string> = {
  VIEW: 'View',
  FUNCTION: 'Function',
  PROCEDURE: 'Procedure',
  TRIGGER: 'Trigger',
};

/**
 * A line with its matches marked, split on the offsets the plan reported rather
 * than searched for again here: one matcher, in `columnReferenceLines`, so the
 * highlight cannot disagree with what the plan found.
 */
const Highlighted: React.FC<{ line: ColumnReferenceLine }> = ({ line }) => {
  const parts: React.JSX.Element[] = [];
  let at = 0;
  line.matches.forEach(({ start, end }, i) => {
    if (start > at) parts.push(<span key={`t${i}`}>{line.text.slice(at, start)}</span>);
    parts.push(
      <mark key={`m${i}`} className="rounded bg-amber-400/25 px-0.5 text-amber-200">
        {line.text.slice(start, end)}
      </mark>
    );
    at = end;
  });
  if (at < line.text.length) parts.push(<span key="tail">{line.text.slice(at)}</span>);
  return <>{parts}</>;
};

/**
 * How many lines of one object we list.
 *
 * A generated view can name a column on hundreds of lines; a reader scrolling
 * past the two hundredth has long since got the point, and every one of them
 * is a row React has to build. The rest stay one click away, in the whole
 * definition, and the count above still says how many there are.
 */
const MAX_LINES = 50;

const Dependent: React.FC<{ dependent: ColumnDependent }> = ({ dependent }) => {
  const [open, setOpen] = useState(false);
  const { name, objectType, references, definition } = dependent;
  const renaming = references.some((r) => r.renamed !== undefined);
  const testId = `column-refs-${objectType.toLowerCase()}-${name}`;
  const shown = references.slice(0, MAX_LINES);
  const hidden = references.length - shown.length;

  return (
    <article className="rounded border border-slate-700/70 bg-slate-900/40" data-testid={testId}>
      <header className="flex items-center gap-2 border-b border-slate-700/70 px-3 py-1.5">
        <span className="text-[11px] font-bold text-slate-400">{KIND_LABEL[objectType]}</span>
        <code className="text-[12px] text-slate-200">{name}</code>
        <span className="text-[11px] text-slate-500">
          {references.length} {references.length === 1 ? 'line' : 'lines'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {open ? 'Hide definition' : 'Whole definition'}
        </button>
      </header>

      <ul className="divide-y divide-slate-800/70" data-testid={`${testId}-lines`}>
        {shown.map((r) => (
          <li key={r.line} className="flex gap-2 px-3 py-1 font-mono text-[11px] leading-relaxed">
            <span className="w-8 shrink-0 select-none text-right text-slate-600" aria-hidden>
              {r.line}
            </span>
            <span className="min-w-0 flex-1 overflow-x-auto">
              <span className="block whitespace-pre text-slate-200">
                <Highlighted line={r} />
              </span>
              {r.renamed !== undefined && (
                <span className="block whitespace-pre text-emerald-300/90" data-testid={`${testId}-after-${r.line}`}>
                  {r.renamed}
                </span>
              )}
            </span>
          </li>
        ))}
        {hidden > 0 && (
          <li
            className="px-3 py-1 text-[11px] text-slate-500"
            data-testid={`${testId}-more`}
          >
            … and {hidden} more {hidden === 1 ? 'line' : 'lines'} — open the whole definition to read them.
          </li>
        )}
      </ul>

      {open && (
        <pre
          className="max-h-64 overflow-auto border-t border-slate-800/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300"
          data-testid={`${testId}-definition`}
        >
          {definition}
        </pre>
      )}

      {renaming && (
        <p className="px-3 pb-2 pt-1 text-[11px] text-slate-500">
          Fox does not rewrite this {KIND_LABEL[objectType].toLowerCase()}; the green line is what it needs to say.
        </p>
      )}
    </article>
  );
};

export interface ColumnReferencesProps {
  dependents: ColumnDependent[];
  /** The column as it is now, for the empty-state wording. */
  column: string;
}

export const ColumnReferences: React.FC<ColumnReferencesProps> = ({ dependents, column }) => {
  if (dependents.length === 0) return null;
  const lines = dependents.reduce((n, d) => n + d.references.length, 0);
  return (
    <section data-testid="column-change-references">
      <h2 className={sectionLabelCls}>
        Where <code className="text-slate-300">{column}</code> is named — {lines}{' '}
        {lines === 1 ? 'line' : 'lines'} in {dependents.length}{' '}
        {dependents.length === 1 ? 'object' : 'objects'}
      </h2>
      <div className="mt-1 space-y-2">
        {dependents.map((d) => (
          <Dependent key={`${d.objectType}-${d.name}`} dependent={d} />
        ))}
      </div>
    </section>
  );
};
