/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data Peek row editor — add / edit / clone form with:
 * - faker-backed Generate dropdown (person / location / number / date…)
 * - simple `=` formulas on number fields
 * - date picker (type format or pick)
 * - edit-mode column selection
 * - preview → save or discard before the write runs
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Lock, Sparkles, X } from 'lucide-react';
import type { TableSchema } from '@/shared/lib/types';
import {
  buildPeekFields,
  validatePeekRow,
  type PeekField,
  type PeekFieldMode,
} from '@/features/sql-editor/lib/peekRowValidation';
import {
  PEEK_GENERATORS,
  generatePeekValueAsync,
  resolvePeekNumberInput,
  suggestPeekGenerator,
  type PeekGeneratorId,
} from '@/features/sql-editor/lib/peekValueGenerators';
import {
  buildPeekInsert,
  buildPeekUpdate,
  draftToArray,
  draftToRowValues,
  type PeekKeyColumn,
} from '@/features/sql-editor/lib/rowDml';
import { PeekDatePicker } from '@/features/sql-editor/components/PeekDatePicker';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { sectionLabelCls } from '@/shared/components/surfaces';

/** Same union as {@link PeekFieldMode} — kept as an alias for existing imports. */
export type PeekRowEditorMode = PeekFieldMode;

export type PeekRowEditorSubmit = {
  draft: Record<string, string>;
  /** Edit mode: columns the user chose to include in SET. */
  updateColumns?: string[];
  /** Previewed SQL the user confirmed. */
  previewSql: string;
};

interface Props {
  open: boolean;
  mode: PeekRowEditorMode;
  tableName: string;
  table: TableSchema;
  columns: string[];
  dialect: string;
  draft: Record<string, string>;
  keyNames: string[];
  identityColumns: Set<string>;
  /** Edit mode: original row values for diff / UPDATE. */
  originalRow?: unknown[];
  keyColumns?: PeekKeyColumn[];
  onCancel: () => void;
  onSubmit: (payload: PeekRowEditorSubmit) => void;
}

const TITLES: Record<PeekRowEditorMode, string> = {
  add: 'Add row',
  edit: 'Edit row',
  clone: 'Clone row',
};

const GENERATOR_GROUPS = (() => {
  const map = new Map<string, typeof PEEK_GENERATORS>();
  for (const g of PEEK_GENERATORS) {
    const list = map.get(g.group) ?? [];
    list.push(g);
    map.set(g.group, list);
  }
  return [...map.entries()];
})();

function FieldControl({
  field,
  value,
  showError,
  onChange,
  onBlur,
}: {
  field: PeekField;
  value: string;
  showError: boolean;
  onChange: (next: string) => void;
  onBlur: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [menuOpen]);

  const inputClass = `mt-0.5 w-full rounded-md border bg-slate-950 px-2.5 py-1.5 text-[13px] font-mono text-slate-100 outline-none disabled:opacity-50 disabled:text-slate-500 disabled:cursor-not-allowed ${
    showError ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-700 accent-focus'
  }`;

  if (field.readOnly) {
    return (
      <input
        data-testid={`peek-row-field-${field.name}`}
        value={value}
        disabled
        placeholder={field.hint}
        className={inputClass}
      />
    );
  }

  if (field.kind === 'date' || field.kind === 'timestamp') {
    return (
      <PeekDatePicker
        fieldName={field.name}
        kind={field.kind}
        value={value}
        showError={showError}
        onChange={onChange}
        onBlur={onBlur}
      />
    );
  }

  const isNumber = field.kind === 'integer' || field.kind === 'decimal';
  const canGenerate =
    field.kind === 'text' ||
    field.kind === 'decimal' ||
    field.kind === 'integer' ||
    field.kind === 'other' ||
    field.kind === 'uuid' ||
    field.kind === 'boolean';

  const apply = async (id: PeekGeneratorId) => {
    setGenerating(true);
    try {
      onChange(await generatePeekValueAsync(id, field));
    } finally {
      setGenerating(false);
      setMenuOpen(false);
    }
  };

  return (
    <div className="relative flex items-stretch gap-1" ref={menuRef}>
      <input
        data-testid={`peek-row-field-${field.name}`}
        value={value}
        aria-invalid={showError || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (isNumber) onChange(resolvePeekNumberInput(value));
          onBlur();
        }}
        placeholder={isNumber ? `${field.hint} · =1+2` : field.hint}
        className={`${inputClass} flex-1`}
      />
      {canGenerate && (
        <>
          <button
            type="button"
            data-testid={`peek-row-generate-${field.name}`}
            title="Generate sample value (faker)"
            aria-label={`Generate value for ${field.name}`}
            aria-expanded={menuOpen}
            disabled={generating}
            onClick={() => setMenuOpen((o) => !o)}
            className="mt-0.5 shrink-0 rounded-md border border-slate-700 bg-slate-950 px-2 text-slate-400 hover:text-amber-200 hover:border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-40"
          >
            <Sparkles className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          </button>
          {menuOpen && (
            <div
              data-testid={`peek-row-generate-menu-${field.name}`}
              className="absolute right-0 top-full z-20 mt-1 max-h-72 min-w-[12rem] overflow-y-auto rounded-md border border-slate-700 bg-slate-900 shadow-xl"
            >
              <button
                type="button"
                data-testid={`peek-row-generate-suggested-${field.name}`}
                className="block w-full px-3 py-1.5 text-left text-[11px] font-semibold text-amber-100 hover:bg-amber-500/15"
                onClick={() => void apply(suggestPeekGenerator(field))}
              >
                Suggested (
                {PEEK_GENERATORS.find((g) => g.id === suggestPeekGenerator(field))?.label})
              </button>
              {GENERATOR_GROUPS.map(([group, items]) => (
                <div key={group}>
                  <div className="border-t border-slate-800 px-3 py-1 text-[9px] font-bold uppercase tracking-wide text-slate-600">
                    {group}
                  </div>
                  {items.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      data-testid={`peek-row-generate-${g.id}-${field.name}`}
                      className="block w-full px-3 py-1.5 text-left text-[11px] font-medium text-slate-200 hover:bg-slate-800"
                      onClick={() => void apply(g.id)}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const PeekRowEditor: React.FC<Props> = ({
  open,
  mode,
  tableName,
  table,
  columns,
  dialect,
  draft: initialDraft,
  keyNames,
  identityColumns,
  originalRow,
  keyColumns = [],
  onCancel,
  onSubmit,
}) => {
  const [draft, setDraft] = useState(initialDraft);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [step, setStep] = useState<'form' | 'preview'>('form');
  const [previewSql, setPreviewSql] = useState('');
  const [previewSnapshot, setPreviewSnapshot] = useState<{
    draft: Record<string, string>;
    updateColumns: string[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [updateColumns, setUpdateColumns] = useState<Set<string>>(new Set());

  const fields = useMemo(
    () => buildPeekFields({ mode, columns, table, keyNames, identityColumns }),
    [mode, columns, table, keyNames, identityColumns]
  );

  useEffect(() => {
    if (open) {
      setDraft(initialDraft);
      setTouched({});
      setSubmitAttempted(false);
      setStep('form');
      setPreviewSql('');
      setPreviewSnapshot(null);
      setPreviewError(null);
      // Edit: start with no columns selected; typing a field auto-selects it.
      setUpdateColumns(new Set());
    }
  }, [open, initialDraft]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (step === 'preview') {
          setStep('form');
          return;
        }
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onCancel, step]);

  const errors = useMemo(() => validatePeekRow(fields, draft), [fields, draft]);
  const errorCount = Object.keys(errors).length;

  const setField = (name: string, next: string) => {
    setDraft((d) => ({ ...d, [name]: next }));
    if (mode === 'edit') {
      setUpdateColumns((prev) => {
        const n = new Set(prev);
        n.add(name);
        return n;
      });
    }
  };

  const generateFillable = async () => {
    const next = { ...draft };
    const selected = mode === 'edit' && updateColumns.size > 0 ? updateColumns : null;
    for (const f of fields) {
      if (f.readOnly) continue;
      if (selected && !selected.has(f.name)) continue;
      next[f.name] = await generatePeekValueAsync(suggestPeekGenerator(f), f);
      if (mode === 'edit') {
        setUpdateColumns((prev) => new Set(prev).add(f.name));
      }
    }
    setDraft(next);
  };

  const buildPreview = (
    snapshotDraft: Record<string, string>,
    snapshotUpdateColumns: Set<string>
  ): { sql: string } | { error: string } => {
    if (mode === 'edit') {
      if (!originalRow) return { error: 'Missing original row.' };
      if (snapshotUpdateColumns.size === 0) {
        return { error: 'Select at least one column to update.' };
      }
      const plan = buildPeekUpdate({
        tableName,
        dialect,
        columns,
        originalRow,
        draftRow: draftToArray(columns, snapshotDraft, originalRow),
        keyColumns,
        onlyColumns: snapshotUpdateColumns,
      });
      if ('error' in plan) return { error: plan.error };
      return { sql: plan.displaySql || plan.sql };
    }
    const plan = buildPeekInsert({
      tableName,
      dialect,
      values: draftToRowValues(columns, snapshotDraft),
      identityColumns,
    });
    if ('error' in plan) return { error: plan.error };
    return { sql: plan.displaySql || plan.sql };
  };

  if (!open) return null;

  const goPreview = () => {
    setSubmitAttempted(true);
    if (errorCount > 0) return;
    const snapshotDraft = { ...draft };
    const snapshotUpdateColumns = new Set(updateColumns);
    const built = buildPreview(snapshotDraft, snapshotUpdateColumns);
    if ('error' in built) {
      setPreviewError(built.error);
      return;
    }
    setPreviewError(null);
    setPreviewSql(built.sql);
    setPreviewSnapshot({
      draft: snapshotDraft,
      updateColumns: [...snapshotUpdateColumns],
    });
    setStep('preview');
  };

  const confirmSave = () => {
    if (!previewSnapshot) return;
    onSubmit({
      draft: previewSnapshot.draft,
      updateColumns: mode === 'edit' ? previewSnapshot.updateColumns : undefined,
      previewSql,
    });
  };

  const editableFields = fields.filter((f) => !f.readOnly);

  return createPortal(
    <div
      data-testid="peek-row-editor"
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/50 px-4 py-3 shrink-0 gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-100">
              {step === 'preview' ? 'Preview write' : TITLES[mode]}
            </h2>
            <p className="text-[11px] text-slate-500 truncate font-mono">{tableName}</p>
          </div>
          {step === 'form' && (
            <button
              type="button"
              data-testid="peek-row-generate-all"
              onClick={() => void generateFillable()}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100"
              title="Fill fields with faker sample data"
            >
              <Sparkles className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
              Generate
            </button>
          )}
          <button data-testid="peek-row-close"
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
          </button>
        </div>

        {step === 'form' ? (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
            {mode === 'edit' && (
              <div
                data-testid="peek-row-column-picker"
                className="rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className={sectionLabelCls}>
                    Columns to update
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      data-testid="peek-row-select-all-cols"
                      className="text-[10px] font-semibold text-sky-300 hover:text-sky-200"
                      onClick={() => setUpdateColumns(new Set(editableFields.map((f) => f.name)))}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      data-testid="peek-row-select-none-cols"
                      className="text-[10px] font-semibold text-slate-400 hover:text-slate-200"
                      onClick={() => setUpdateColumns(new Set())}
                    >
                      None
                    </button>
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {editableFields.map((f) => {
                    const on = updateColumns.has(f.name);
                    return (
                      <label
                        key={f.name}
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono cursor-pointer ${
                          on
                            ? 'border-sky-500/40 bg-sky-500/10 text-sky-100'
                            : 'border-slate-700 text-slate-400'
                        }`}
                      >
                        <input
                          type="checkbox"
                          data-testid={`peek-row-col-${f.name}`}
                          checked={on}
                          onChange={(e) => {
                            setUpdateColumns((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.add(f.name);
                              else n.delete(f.name);
                              return n;
                            });
                          }}
                          className="accent-sky-500"
                        />
                        {f.name}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            {fields.map((f) => {
              const error = errors[f.name];
              const showError = Boolean(error) && (submitAttempted || touched[f.name]);
              const dimmed = mode === 'edit' && !f.readOnly && !updateColumns.has(f.name);
              return (
                <label
                  key={f.name}
                  className={`block ${dimmed ? 'opacity-45' : ''}`}
                  data-testid={`peek-row-field-wrap-${f.name}`}
                >
                  <span className={`${sectionLabelCls} flex items-center gap-1.5`}>
                    {f.name}
                    {f.isKey && <span className="text-amber-400/80 normal-case">PK</span>}
                    {f.isIdentity && (
                      <span className="text-sky-400/80 normal-case font-semibold">identity</span>
                    )}
                    {!f.nullable && !f.readOnly && <span className="text-rose-400/80">*</span>}
                    {f.readOnly && (
                      <Lock className="w-3 h-3 text-slate-600" strokeWidth={SQL_ICON_STROKE} />
                    )}
                    <span className="ml-auto normal-case font-mono text-[10px] text-slate-600">
                      {f.type}
                    </span>
                  </span>
                  <FieldControl
                    field={f}
                    value={draft[f.name] ?? ''}
                    showError={showError}
                    onChange={(next) => setField(f.name, next)}
                    onBlur={() => setTouched((t) => ({ ...t, [f.name]: true }))}
                  />
                  {showError && (
                    <span
                      data-testid={`peek-row-error-${f.name}`}
                      className="mt-0.5 block text-[10px] font-semibold text-rose-300"
                    >
                      {error}
                    </span>
                  )}
                </label>
              );
            })}
            {previewError && (
              <p data-testid="peek-row-preview-error" className="text-[11px] font-semibold text-rose-300">
                {previewError}
              </p>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="peek-row-preview">
            <p className="text-[11px] text-slate-400">
              Review the SQL below. Save to run it, or discard to keep editing.
            </p>
            {mode === 'edit' && (
              <ul className="space-y-1 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                {(previewSnapshot?.updateColumns ?? []).map((name) => {
                  const idx = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
                  const before = idx >= 0 && originalRow ? String(originalRow[idx] ?? '') : '';
                  const after = previewSnapshot?.draft[name] ?? '';
                  return (
                    <li key={name} className="text-[11px] font-mono text-slate-300">
                      <span className="text-sky-300">{name}</span>
                      <span className="text-slate-600">: </span>
                      <span className="text-rose-300/80">{before || 'NULL'}</span>
                      <span className="text-slate-500"> → </span>
                      <span className="text-emerald-300">{after || 'NULL'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <pre
              data-testid="peek-row-preview-sql"
              className="whitespace-pre-wrap break-all rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-200"
            >
              {previewSql}
            </pre>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-slate-950/40 px-4 py-3 shrink-0">
          {step === 'form' && submitAttempted && errorCount > 0 && (
            <span
              data-testid="peek-row-error-summary"
              className="mr-auto flex items-center gap-1.5 text-[11px] font-semibold text-rose-300"
            >
              <AlertTriangle className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
              {errorCount} field{errorCount === 1 ? '' : 's'} need fixing
            </span>
          )}
          {step === 'preview' ? (
            <>
              <button
                type="button"
                data-testid="peek-row-discard"
                onClick={() => setStep('form')}
                className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
              >
                Discard
              </button>
              <button
                type="button"
                data-testid="peek-row-save"
                onClick={confirmSave}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25"
              >
                <Check className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                Save
              </button>
            </>
          ) : (
            <>
              <button data-testid="peek-row-cancel"
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="peek-row-submit"
                onClick={goPreview}
                title={errorCount > 0 ? 'Fix the highlighted fields first' : undefined}
                className={`px-3 py-1.5 text-xs font-bold rounded-md border ${
                  errorCount > 0
                    ? 'border-slate-700 bg-slate-800/60 text-slate-500'
                    : 'border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25'
                }`}
              >
                Preview
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
