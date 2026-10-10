/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Form controls shared by the Access panels, so the Permission Builder and
 * User Management read as one screen rather than two.
 */
import React from 'react';
import { sectionLabelCls } from '@/shared/components/surfaces';

export const inputCls =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[12px] text-slate-100 outline-none accent-focus';

/** The micro-label above a control. Exported because two panels had their own copy. */
/**
 * Re-exported rather than respelled: this string is the same micro-label the
 * rest of the app uses, and it drifted into eight variants precisely because
 * each feature kept its own copy.
 */
export const labelCls = sectionLabelCls;

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div>
    <span className={labelCls}>{label}</span>
    {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    <div className="mt-1">{children}</div>
  </div>
);

export const Segmented: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean; title?: string }[];
  testId: string;
}> = ({ value, onChange, options, testId }) => (
  <div
    className="inline-flex rounded-md border border-slate-700 overflow-hidden"
    data-testid={testId}
  >
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        disabled={o.disabled}
        title={o.title}
        data-testid={`${testId}-${o.value}`}
        onClick={() => onChange(o.value)}
        className={`px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-35 disabled:cursor-not-allowed ${
          value === o.value ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

export const EmptyState: React.FC<{ title: string; body: string; testId?: string }> = ({
  title,
  body,
  testId,
}) => (
  <div
    data-testid={testId}
    className="rounded-md border border-slate-800 bg-slate-900/40 px-4 py-6 text-center"
  >
    <p className="text-sm font-bold text-slate-300">{title}</p>
    <p className="mt-1 text-[11px] text-slate-500 max-w-md mx-auto">{body}</p>
  </div>
);
