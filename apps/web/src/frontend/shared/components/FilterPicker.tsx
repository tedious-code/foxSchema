/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A dropdown with a filter, for lists too long for a native `<select>`.
 *
 * Built for the SQL editor's destinations — 254 saved connections is a real
 * install — and shared so every long pick list behaves the same: one filter over
 * what a row shows and what its tooltip shows, a portal so no scrolling ancestor
 * clips the list, and either a checklist or a single choice.
 */
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { dialectLabel } from '@/shared/lib/dialectLabel';
import { useAnchoredPopover } from '@/shared/lib/useAnchoredPopover';

export interface FilterPickerOption {
  id: string;
  label: string;
  /** A short tag before the label: a dialect, a credential kind. */
  badge?: string;
  /** The row's tooltip; searched. */
  detail?: string;
  /** Muted text after the label; searched. */
  note?: string;
  /** Searched, not shown. */
  keywords?: readonly (string | undefined)[];
  /** When set, rows are listed under this section heading (e.g. dialect). */
  group?: string;
  testId?: string;
}

interface CommonProps {
  options: readonly FilterPickerOption[];
  /** What the closed trigger says. */
  summary: React.ReactNode;
  id?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  placeholder?: string;
  /** Prefix for the trigger, filter and backdrop test ids. */
  testId?: string;
  /** A leading cell per row, such as a destination's group number. */
  renderLead?: (option: FilterPickerOption) => React.ReactNode;
}

export type FilterPickerProps = CommonProps &
  (
    | { mode: 'multi'; selectedIds: readonly string[]; onToggle: (id: string) => void }
    | {
        mode: 'single';
        selectedId: string | null;
        /** Called with `''` when the clear row is picked. */
        onSelect: (id: string) => void;
        /** Adds a first row that clears the choice. */
        clearLabel?: string;
      }
  );

/** Fields searched when filtering a saved connection in any picker. */
export function connectionSearchHaystack(connection: {
  name?: string;
  dialect: string;
  host?: string;
  port?: number | string;
  database?: string;
  schema?: string;
  username?: string;
}): string[] {
  return [
    connection.name,
    dialectLabel(connection.dialect),
    connection.dialect,
    connection.host,
    connection.port != null && connection.port !== '' ? String(connection.port) : undefined,
    connection.database,
    connection.schema,
    connection.username,
  ].filter((v): v is string => Boolean(v && String(v).trim()));
}

/** A saved connection as a row: dialect badge; host/db/user/port searchable. */
export function connectionPickerOption(connection: {
  id: string;
  name?: string;
  dialect: string;
  host?: string;
  port?: number | string;
  database?: string;
  schema?: string;
  username?: string;
}): FilterPickerOption {
  const hostPort = [connection.host, connection.port != null && connection.port !== '' ? `:${connection.port}` : '']
    .join('')
    .trim();
  const detail = [hostPort || undefined, connection.database, connection.schema, connection.username]
    .filter(Boolean)
    .join(' / ');
  return {
    id: connection.id,
    label: connection.name || '(unnamed)',
    badge: dialectLabel(connection.dialect),
    group: dialectLabel(connection.dialect),
    detail: detail || undefined,
    keywords: connectionSearchHaystack(connection),
  };
}

const TRIGGER =
  'flex w-full min-w-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-left text-[11px] text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50';
const ROW =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] font-semibold text-slate-300 hover:bg-slate-800/60 hover:text-slate-100';

function optionMatches(option: FilterPickerOption, query: string): boolean {
  return [option.label, option.badge, option.detail, option.note, option.group, ...(option.keywords ?? [])].some(
    (value) => value?.toLowerCase().includes(query)
  );
}

/** Stable order: group label A→Z, then label within each group. Ungrouped last. */
export function sortOptionsByGroup(options: readonly FilterPickerOption[]): FilterPickerOption[] {
  return [...options].sort((a, b) => {
    const ga = a.group ?? '\uffff';
    const gb = b.group ?? '\uffff';
    return ga.localeCompare(gb) || a.label.localeCompare(b.label);
  });
}

export function FilterPicker(props: FilterPickerProps): React.ReactElement {
  const {
    options,
    summary,
    id,
    title,
    disabled,
    className = 'min-w-0',
    triggerClassName = TRIGGER,
    placeholder = 'Filter…',
    testId,
    renderLead,
  } = props;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(open);
  const part = (name: string) => (testId ? `${testId}-${name}` : undefined);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    const filtered = query ? options.filter((option) => optionMatches(option, query)) : [...options];
    const hasGroups = filtered.some((o) => o.group);
    return hasGroups ? sortOptionsByGroup(filtered) : filtered;
  }, [options, query]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) anchorRef.current?.focus();
  };

  const choose = (value: string) => {
    if (props.mode !== 'single') return;
    props.onSelect(value);
    close(true);
  };

  const isSelected = (optionId: string) =>
    props.mode === 'multi' ? props.selectedIds.includes(optionId) : props.selectedId === optionId;

  const row = (option: FilterPickerOption) => {
    const selected = isSelected(option.id);
    const body = (
      <>
        {renderLead?.(option)}
        {option.badge && (
          <span className="shrink-0 rounded border border-slate-700/70 bg-slate-950/70 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
            {option.badge}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" title={option.detail || undefined}>
          {option.label}
        </span>
        {option.note && <span className="shrink-0 text-[10px] font-medium text-slate-500">{option.note}</span>}
      </>
    );
    if (props.mode === 'multi') {
      return (
        <label key={option.id} data-testid={option.testId} className={ROW}>
          <input data-testid={part(`option-${option.id}`)}
            type="checkbox"
            checked={selected}
            onChange={() => props.onToggle(option.id)}
            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-cyan-600"
          />
          {body}
        </label>
      );
    }
    return (
      <button
        key={option.id}
        type="button"
        role="option"
        aria-selected={selected}
        data-testid={option.testId}
        onClick={() => choose(option.id)}
        className={`${ROW} ${selected ? 'bg-slate-800/60 text-slate-100' : ''}`}
      >
        <Check className={`h-3.5 w-3.5 shrink-0 text-cyan-400 ${selected ? '' : 'invisible'}`} />
        {body}
      </button>
    );
  };

  const clearLabel = props.mode === 'single' ? props.clearLabel : undefined;

  const listBody: React.ReactNode[] = [];
  let lastGroup: string | undefined;
  for (const option of shown) {
    if (option.group && option.group !== lastGroup) {
      lastGroup = option.group;
      listBody.push(
        <div
          key={`group-${option.group}`}
          data-testid={part(`group-${option.group}`)}
          className="sticky top-0 z-[1] px-1.5 pt-1.5 pb-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500 bg-slate-900"
        >
          {option.group}
        </div>
      );
    }
    listBody.push(row(option));
  }

  return (
    <div className={className}>
      <button
        ref={anchorRef}
        id={id}
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={part('trigger')}
        onClick={() => setOpen((current) => !current)}
        className={triggerClassName}
      >
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {open &&
        createPortal(
          <>
            {/* Click-away sits behind the panel, so a click outside closes it
                without document listeners guessing what counts as inside. */}
            <div className="fixed inset-0 z-[500]" onClick={() => close(false)} data-testid={part('backdrop')} />
            <div
              ref={popoverRef}
              style={style}
              className="z-[501] w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-slate-700 bg-slate-900 p-1.5 shadow-2xl"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  close(true);
                }
              }}
            >
              <input
                autoFocus
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && shown[0]) {
                    event.preventDefault();
                    choose(shown[0].id);
                  }
                }}
                placeholder={placeholder}
                data-testid={part('filter')}
                className="mb-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100 accent-focus focus:outline-none"
              />
              <div
                role="listbox"
                aria-multiselectable={props.mode === 'multi' || undefined}
                className="max-h-64 overflow-y-auto"
              >
                {clearLabel && !query && (
                  <button data-testid={part('clear')}
                    type="button"
                    role="option"
                    aria-selected={props.mode === 'single' && !props.selectedId}
                    onClick={() => choose('')}
                    className={`${ROW} font-medium text-slate-500`}
                  >
                    <Check className="invisible h-3.5 w-3.5 shrink-0" />
                    {clearLabel}
                  </button>
                )}
                {shown.length === 0 ? (
                  <p className="px-1.5 py-2 text-[11px] text-slate-500">
                    {query ? `Nothing matches “${filter}”.` : 'Nothing to choose from.'}
                  </p>
                ) : (
                  listBody
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
