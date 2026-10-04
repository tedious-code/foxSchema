/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Date / timestamp field control for Data Peek forms.
 * Users can type in the catalog format or pick from a small calendar popover.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export function timestampFormatHint(kind: 'date' | 'timestamp'): string {
  return kind === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:MM:SS';
}

/** Convert a date / datetime-local control value into the draft string the form validates. */
export function draftFromDateInput(kind: 'date' | 'timestamp', value: string): string {
  if (!value) return '';
  if (kind === 'date') return value;
  const [datePart, timePart = '00:00'] = value.split('T');
  const time = timePart.length === 5 ? `${timePart}:00` : timePart;
  return `${datePart} ${time}`;
}

/** Convert a draft timestamp/date into a value an HTML date/datetime-local input accepts. */
export function dateInputFromDraft(kind: 'date' | 'timestamp', draft: string): string {
  const v = (draft ?? '').trim();
  if (!v) return '';
  // Manual parse (no nested optional regex groups) — `security/detect-unsafe-regex`
  // rejects `(?::\d{2})?` even when every class is bounded.
  const space = v.indexOf(' ');
  const tSep = v.indexOf('T');
  const cut = space >= 0 ? space : tSep >= 0 ? tSep : -1;
  const datePart = cut >= 0 ? v.slice(0, cut) : v;
  const dateBits = datePart.split('-');
  if (dateBits.length !== 3) return '';
  const [y, mo, d] = dateBits;
  if (!y || !mo || !d || y.length !== 4) return '';
  if (![y, mo, d].every((p) => /^\d+$/.test(p))) return '';
  const ymd = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  if (kind === 'date') return ymd;
  if (cut < 0) return '';
  const parts = timestampClockParts(v);
  if (!parts) return '';
  return `${ymd}T${parts.clock}`;
}

interface Props {
  fieldName: string;
  kind: 'date' | 'timestamp';
  value: string;
  showError: boolean;
  disabled?: boolean;
  onChange: (next: string) => void;
  onBlur: () => void;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

function timestampClockParts(draft: string): {
  value: string;
  dateTimeSeparator: number;
  clock: string;
  suffix: string;
} | null {
  const value = (draft ?? '').trim();
  const space = value.indexOf(' ');
  const tSep = value.indexOf('T');
  const dateTimeSeparator = space >= 0 ? space : tSep >= 0 ? tSep : -1;
  if (dateTimeSeparator < 0) return null;
  const rest = value.slice(dateTimeSeparator + 1);
  const minute = /^(\d{1,2}):(\d{2})/.exec(rest);
  if (!minute) return null;
  let consumed = minute[0].length;
  let clock = `${minute[1]!.padStart(2, '0')}:${minute[2]!}`;
  if (rest[consumed] === ':') {
    const seconds = rest.slice(consumed + 1, consumed + 3);
    if (/^\d{2}$/.test(seconds)) {
      clock += `:${seconds}`;
      consumed += 3;
    }
  }
  return {
    value,
    dateTimeSeparator,
    clock,
    suffix: rest.slice(consumed),
  };
}

function replaceTimestampDate(draft: string, date: string): string {
  if (dateInputFromDraft('date', draft) === date) return draft;
  const parts = timestampClockParts(draft);
  if (!parts) return draftFromDateInput('timestamp', `${date}T00:00`);
  return `${date}${parts.value.slice(parts.dateTimeSeparator)}`;
}

function replaceTimestampClock(draft: string, clock: string, fallbackDate: string): string {
  const parts = timestampClockParts(draft);
  const normalizedClock = clock.length === 5 ? `${clock}:00` : clock;
  if (!parts) return `${fallbackDate} ${normalizedClock}`;
  return `${parts.value.slice(0, parts.dateTimeSeparator + 1)}${normalizedClock}${parts.suffix}`;
}

export const PeekDatePicker: React.FC<Props> = ({
  fieldName,
  kind,
  value,
  showError,
  disabled,
  onChange,
  onBlur,
}) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(value);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTyped(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [open]);

  const parsed = useMemo(() => {
    const html = dateInputFromDraft(kind, value);
    if (!html) {
      const now = new Date();
      return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
    }
    const [datePart] = html.split('T');
    const [ys, ms, ds] = datePart!.split('-').map(Number);
    return { y: ys!, m: (ms ?? 1) - 1, d: ds ?? 1 };
  }, [kind, value]);

  const [view, setView] = useState(parsed);
  useEffect(() => {
    if (open) setView({ y: parsed.y, m: parsed.m, d: parsed.d });
  }, [open, parsed.y, parsed.m, parsed.d]);

  const inputClass = `mt-0.5 w-full rounded-md border bg-slate-950 px-2.5 py-1.5 text-[13px] font-mono text-slate-100 outline-none disabled:opacity-50 disabled:text-slate-500 disabled:cursor-not-allowed ${
    showError ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-700 accent-focus'
  }`;

  const commitTyped = () => {
    const next = typed.trim();
    onChange(next);
    onBlur();
  };

  const pickDay = (day: number) => {
    const y = view.y;
    const m = String(view.m + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    if (kind === 'date') {
      onChange(`${y}-${m}-${d}`);
    } else {
      onChange(replaceTimestampDate(value, `${y}-${m}-${d}`));
    }
    setOpen(false);
  };

  const firstDow = new Date(view.y, view.m, 1).getDay();
  const dim = daysInMonth(view.y, view.m);
  const cells: Array<number | null> = [...Array(firstDow).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="relative flex items-stretch gap-1" ref={rootRef}>
      <input
        data-testid={`peek-row-field-${fieldName}`}
        value={typed}
        disabled={disabled}
        aria-invalid={showError || undefined}
        placeholder={timestampFormatHint(kind)}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={commitTyped}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitTyped();
          }
        }}
        className={`${inputClass} flex-1`}
      />
      <button
        type="button"
        data-testid={`peek-row-datepicker-${fieldName}`}
        title={`Pick ${kind === 'date' ? 'date' : 'date & time'} (${timestampFormatHint(kind)})`}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-0.5 shrink-0 rounded-md border border-slate-700 bg-slate-950 px-2 text-slate-400 hover:text-sky-200 hover:border-sky-500/40 hover:bg-sky-500/10 disabled:opacity-40"
      >
        <CalendarDays className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
      </button>
      {kind === 'timestamp' && (
        <input
          data-testid={`peek-row-datetime-native-${fieldName}`}
          type="datetime-local"
          step={1}
          value={dateInputFromDraft('timestamp', value)}
          disabled={disabled}
          onChange={(e) => onChange(draftFromDateInput('timestamp', e.target.value))}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
      )}
      {open && (
        <div
          data-testid={`peek-row-datepicker-pop-${fieldName}`}
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-slate-700 bg-slate-900 p-2 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between gap-1">
            <button data-testid="peek-date-view-toggle"
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
              onClick={() =>
                setView((v) => {
                  const m = v.m - 1;
                  return m < 0 ? { y: v.y - 1, m: 11, d: 1 } : { ...v, m, d: 1 };
                })
              }
            >
              ‹
            </button>
            <span className="text-[11px] font-semibold text-slate-200">
              {new Date(view.y, view.m, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' })}
            </span>
            <button data-testid="peek-date-today"
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
              onClick={() =>
                setView((v) => {
                  const m = v.m + 1;
                  return m > 11 ? { y: v.y + 1, m: 0, d: 1 } : { ...v, m, d: 1 };
                })
              }
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-slate-500 mb-1">
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) =>
              day == null ? (
                <span key={`e-${i}`} />
              ) : (
                <button data-testid={`peek-date-day-${view.y}-${view.m}-${day}`}
                  key={`${view.y}-${view.m}-${day}`}
                  type="button"
                  className={`rounded py-1 text-[11px] ${
                    day === parsed.d && view.m === parsed.m && view.y === parsed.y
                      ? 'bg-sky-500/30 text-sky-100'
                      : 'text-slate-200 hover:bg-slate-800'
                  }`}
                  onClick={() => pickDay(day)}
                >
                  {day}
                </button>
              )
            )}
          </div>
          {kind === 'timestamp' && (
            <label className="mt-2 block text-[10px] text-slate-500">
              Time
              <input
                type="time"
                step={1}
                data-testid={`peek-row-time-${fieldName}`}
                className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px] text-slate-100"
                value={(() => {
                  const clock = timestampClockParts(value)?.clock;
                  if (!clock) return '00:00:00';
                  return clock.length === 5 ? `${clock}:00` : clock;
                })()}
                onChange={(e) => {
                  const datePart =
                    dateInputFromDraft('date', value) ||
                    `${view.y}-${String(view.m + 1).padStart(2, '0')}-${String(view.d).padStart(2, '0')}`;
                  onChange(replaceTimestampClock(value, e.target.value, datePart));
                }}
              />
            </label>
          )}
          <p className="mt-2 text-[10px] text-slate-500">Type {timestampFormatHint(kind)} or pick a day</p>
        </div>
      )}
    </div>
  );
};
