import React, { useEffect, useRef, useState } from 'react';
import { Download, Eye, Plus, Trash2, Upload } from 'lucide-react';
import {
  expandSqlLiteral,
  isSecretUnset,
  type SqlVariable,
} from '@/shared/lib/sql-variables';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { useSyncStore } from '@/features/compare';
import { useAuthStore } from '@/app/store/authStore';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

const TABLE_PREVIEW_ROWS = 20;

/** Parse a typed scalar/list token without regex (avoids eslint unsafe-regex noise). */
function parseTypedToken(s: string): unknown {
  if (s === 'NULL') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  const asNum = Number(s);
  if (
    s.length > 0 &&
    Number.isFinite(asNum) &&
    !s.includes(' ') &&
    (s[0] === '-' || (s[0]! >= '0' && s[0]! <= '9'))
  ) {
    return asNum;
  }
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function previewVariable(v: SqlVariable): string {
  if (v.secret) {
    if (isSecretUnset(v)) return '(secret · unset)';
    if (v.kind === 'table') {
      const cols = v.columns?.length ?? 0;
      const rows = v.rows?.length ?? 0;
      return `•••• · ${rows}×${cols}`;
    }
    return '••••';
  }
  if (v.kind === 'table') {
    const cols = v.columns?.length ?? 0;
    const rows = v.rows?.length ?? 0;
    return `${rows}×${cols} table`;
  }
  if (v.kind === 'list') {
    const vals = v.values ?? [];
    if (vals.length === 0) return '(empty list)';
    const head = vals.slice(0, 3).map(expandSqlLiteral).join(', ');
    return vals.length > 3 ? `${head}, … (${vals.length})` : head;
  }
  if (v.value === undefined) return '(unset)';
  return expandSqlLiteral(v.value);
}

function scalarEditText(v: SqlVariable): string {
  if (v.secret || v.value === null || v.value === undefined) return '';
  return typeof v.value === 'string' ? v.value : String(v.value);
}

function listEditText(v: SqlVariable): string {
  if (v.secret) return '';
  return (v.values ?? []).map(expandSqlLiteral).join(', ');
}

function parseListDraft(raw: string): unknown[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseTypedToken);
}

/**
 * Global SQL Editor variables — `${{name}}` / `${{name.col}}`.
 * Supports secrets, per-connection overrides, table preview, export/import.
 */
export const SqlVariablesPanel: React.FC = () => {
  const canWrite = useAuthStore((s) => s.can('editor.variables.write'));
  const canDelete = useAuthStore((s) => s.can('editor.variables.delete'));
  const variables = useSqlEditorStore((s) => s.variables);
  const upsertVariable = useSqlEditorStore((s) => s.upsertVariable);
  const deleteVariable = useSqlEditorStore((s) => s.deleteVariable);
  const setVariableSecret = useSqlEditorStore((s) => s.setVariableSecret);
  const setVariableOverride = useSqlEditorStore((s) => s.setVariableOverride);
  const exportVariablesJson = useSqlEditorStore((s) => s.exportVariablesJson);
  const importVariables = useSqlEditorStore((s) => s.importVariables);
  const connections = useSyncStore((s) => s.connections);

  const [adding, setAdding] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [valueDraft, setValueDraft] = useState('');
  const [secretDraft, setSecretDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [expandedOverrides, setExpandedOverrides] = useState<string | null>(null);
  const [previewTableId, setPreviewTableId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) nameRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId) editRef.current?.select();
  }, [editingId]);

  const commitAdd = () => {
    const err = upsertVariable({
      name: nameDraft,
      kind: 'scalar',
      value: valueDraft,
      secret: secretDraft,
    });
    if (err) {
      setError(err);
      return;
    }
    setAdding(false);
    setNameDraft('');
    setValueDraft('');
    setSecretDraft(false);
    setError(null);
  };

  const commitEdit = (id: string, kind: 'scalar' | 'list') => {
    const v = variables.find((x) => x.id === id);
    if (!v) {
      setEditingId(null);
      return;
    }
    const base = {
      id,
      name: v.name,
      secret: v.secret,
      overrides: v.overrides,
    };
    const err =
      kind === 'list'
        ? upsertVariable({ ...base, kind: 'list', values: parseListDraft(editValue) })
        : upsertVariable({
            ...base,
            kind: 'scalar',
            value:
              editValue.trim() === ''
                ? editValue
                : parseTypedToken(editValue.trim()),
          });
    if (err) {
      setError(err);
      return;
    }
    setEditingId(null);
    setError(null);
  };

  const downloadExport = () => {
    const json = exportVariablesJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'foxschema-variables.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as unknown;
      const overwrite =
        variables.length === 0 ||
        window.confirm('Import will overwrite variables with the same name. Continue?');
      const err = importVariables(data, { overwrite });
      if (err) setError(err);
      else setError(null);
    } catch {
      setError('Could not parse import JSON');
    }
  };

  const previewVar = previewTableId
    ? variables.find((v) => v.id === previewTableId)
    : undefined;

  return (
    <div className="flex flex-col gap-1.5 min-h-0 flex-1" data-testid="sql-variables">
      {error && (
        <p className="text-[12px] text-rose-400 leading-snug" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          title="Export variables as JSON"
          data-testid="sql-variable-export"
          onClick={downloadExport}
          className="flex items-center gap-0.5 text-[13px] font-bold text-slate-400 hover:text-cyan-300 px-1 py-0.5"
        >
          <Download className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} /> Export
        </button>
        <button
          type="button"
          title="Import variables from JSON"
          data-testid="sql-variable-import"
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-0.5 text-[13px] font-bold text-slate-400 hover:text-cyan-300 px-1 py-0.5"
        >
          <Upload className="w-3.5 h-3.5 text-violet-400" strokeWidth={SQL_ICON_STROKE} /> Import
        </button>
        <input data-testid="sql-variable-import-file"
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void onImportFile(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
      </div>

      {adding ? (
        <div className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-950/60 p-1.5">
          <input
            ref={nameRef}
            data-testid="sql-variable-name-input"
            placeholder="name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAdd();
              if (e.key === 'Escape') {
                setAdding(false);
                setError(null);
              }
            }}
            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[13px] text-slate-100 outline-none accent-focus"
          />
          <input
            data-testid="sql-variable-value-input"
            placeholder="value"
            type={secretDraft ? 'password' : 'text'}
            value={valueDraft}
            onChange={(e) => setValueDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAdd();
              if (e.key === 'Escape') {
                setAdding(false);
                setError(null);
              }
            }}
            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[13px] text-slate-100 outline-none accent-focus"
          />
          <label className="flex items-center gap-1 text-[12px] text-slate-400">
            <input data-testid="sql-variable-secret-input"
              type="checkbox"
              checked={secretDraft}
              onChange={(e) => setSecretDraft(e.target.checked)}
              className="rounded border-slate-600"
            />
            Secret (masked; not saved to disk)
          </label>
          <div className="flex gap-1 justify-end">
            <button data-testid="sql-variable-cancel"
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="text-[12px] text-slate-500 hover:text-slate-300 px-1.5 py-0.5"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="sql-variable-add-confirm"
              onClick={commitAdd}
              className="text-[12px] font-semibold text-cyan-400 hover:text-cyan-300 px-1.5 py-0.5"
            >
              Save
            </button>
          </div>
        </div>
      ) : null}

      {variables.length === 0 && !adding ? (
        <p className="text-[14px] font-medium text-slate-500 leading-snug">
          Add a scalar, use <code className="text-slate-400">-- @set</code>, or save from
          results. Refs: <code className="text-slate-400">${'{{name}}'}</code> /{' '}
          <code className="text-slate-400">${'{{name.col}}'}</code>.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 overflow-y-auto min-h-0 flex-1 pr-0.5">
          {variables.map((v) => {
            const hasOverrides = Boolean(v.overrides && Object.keys(v.overrides).length > 0);
            return (
              <li
                key={v.id}
                className="group flex flex-col gap-0.5 rounded px-1 py-0.5 hover:bg-slate-800/50"
                data-testid={`sql-variable-${v.name}`}
              >
                <div className="flex items-start gap-1">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-[14px] font-bold text-slate-200 truncate">
                        {v.name}
                      </span>
                      <span className="text-[12px] uppercase tracking-wider text-slate-500 shrink-0 font-bold">
                        {v.kind}
                      </span>
                      {v.secret && (
                        <span className="text-[11px] uppercase tracking-wider text-amber-500/90 shrink-0">
                          secret
                        </span>
                      )}
                      {hasOverrides && (
                        <span
                          className="text-[11px] text-cyan-500/80 shrink-0"
                          title="Has per-connection overrides"
                        >
                          · override
                        </span>
                      )}
                    </div>
                    {v.kind === 'table' ? (
                      <button data-testid={`sql-variable-preview-table-${v.name}`}
                        type="button"
                        title="Preview table"
                        onClick={() =>
                          setPreviewTableId((id) => (id === v.id ? null : v.id))
                        }
                        className="mt-0.5 flex items-center gap-1 text-left text-[12px] font-mono text-slate-400 hover:text-cyan-300 truncate max-w-full"
                      >
                        <Eye className="w-3.5 h-3.5 shrink-0 text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
                        <span className="truncate">
                          {previewVariable(v)}
                          {!v.secret && v.columns && v.columns.length > 0
                            ? ` · ${v.columns.slice(0, 4).join(', ')}${v.columns.length > 4 ? '…' : ''}`
                            : ''}
                        </span>
                      </button>
                    ) : editingId === v.id ? (
                      <input data-testid={`sql-variable-value-edit-${v.name}`}
                        ref={editRef}
                        type={v.secret ? 'password' : 'text'}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() =>
                          commitEdit(v.id, v.kind === 'list' ? 'list' : 'scalar')
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitEdit(v.id, v.kind === 'list' ? 'list' : 'scalar');
                          }
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="mt-0.5 w-full bg-slate-950 border border-cyan-600/50 rounded px-1.5 py-0.5 text-[12px] font-mono text-slate-100 outline-none"
                      />
                    ) : (
                      <button data-testid={`sql-variable-value-${v.name}`}
                        type="button"
                        title="Edit value"
                        onClick={() => {
                          setEditingId(v.id);
                          setError(null);
                          setEditValue(
                            v.kind === 'list' ? listEditText(v) : scalarEditText(v)
                          );
                        }}
                        className="mt-0.5 block w-full text-left text-[12px] font-mono text-slate-400 hover:text-cyan-300 truncate"
                      >
                        {previewVariable(v)}
                      </button>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                      <label className="flex items-center gap-1 text-[11px] text-slate-500">
                        <input data-testid={`sql-variable-secret-${v.name}`}
                          type="checkbox"
                          checked={Boolean(v.secret)}
                          onChange={(e) => setVariableSecret(v.id, e.target.checked)}
                          className="rounded border-slate-600"
                        />
                        Secret
                      </label>
                      {(v.kind === 'scalar' || v.kind === 'list') && connections.length > 0 && (
                        <button data-testid={`sql-variable-overrides-${v.name}`}
                          type="button"
                          className="text-[11px] text-slate-500 hover:text-cyan-400"
                          onClick={() =>
                            setExpandedOverrides((id) => (id === v.id ? null : v.id))
                          }
                        >
                          {expandedOverrides === v.id ? 'Hide' : 'Per connection'}…
                        </button>
                      )}
                    </div>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      data-testid={`sql-variable-delete-${v.name}`}
                      title="Delete variable"
                      aria-label={`Delete ${v.name}`}
                      onClick={() => deleteVariable(v.id)}
                      className="p-0.5 text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition shrink-0 mt-0.5"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
                    </button>
                  )}
                </div>

                {expandedOverrides === v.id && (v.kind === 'scalar' || v.kind === 'list') && (
                  <div className="ml-1 mb-1 flex flex-col gap-1 border-l border-slate-800 pl-2">
                    {connections.map((c) => {
                      const o = v.overrides?.[c.id];
                      const label = c.name || c.dialect;
                      return (
                        <div key={c.id} className="flex flex-col gap-0.5">
                          <span className="text-[11px] text-slate-500 truncate" title={label}>
                            {label}
                          </span>
                          <div className="flex gap-1">
                            <input data-testid={`sql-variable-input-${c.id}`}
                              type={v.secret ? 'password' : 'text'}
                              placeholder={
                                v.kind === 'list' ? 'a, b, c' : 'override value'
                              }
                              defaultValue={
                                v.kind === 'list'
                                  ? (o?.values ?? []).map(expandSqlLiteral).join(', ')
                                  : o && Object.prototype.hasOwnProperty.call(o, 'value')
                                    ? o.value === null || o.value === undefined
                                      ? ''
                                      : String(o.value)
                                    : ''
                              }
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                if (!raw) {
                                  setVariableOverride(v.id, c.id, null);
                                  return;
                                }
                                if (v.kind === 'list') {
                                  setVariableOverride(v.id, c.id, {
                                    values: parseListDraft(raw),
                                  });
                                } else {
                                  setVariableOverride(v.id, c.id, {
                                    value: parseTypedToken(raw),
                                  });
                                }
                              }}
                              className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-[12px] font-mono text-slate-200 outline-none accent-focus"
                            />
                            {o && (
                              <button data-testid={`sql-variable-clear-override-${c.id}`}
                                type="button"
                                title="Clear override"
                                onClick={() => setVariableOverride(v.id, c.id, null)}
                                className="text-[11px] text-slate-500 hover:text-rose-400 shrink-0"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {previewTableId === v.id && previewVar?.kind === 'table' && (
                  <div className="mt-1 mb-1 max-h-40 overflow-auto rounded border border-slate-800 bg-slate-950/80 text-[11px]">
                    {previewVar.secret ? (
                      <p className="p-1.5 text-slate-500">(secret table — values hidden)</p>
                    ) : (
                      <table className="w-full border-collapse font-mono">
                        <thead>
                          <tr>
                            {(previewVar.columns ?? []).map((col) => (
                              <th
                                key={col}
                                className="sticky top-0 bg-slate-900 text-left text-slate-400 px-1.5 py-0.5 border-b border-slate-800"
                              >
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(previewVar.rows ?? []).slice(0, TABLE_PREVIEW_ROWS).map((row, ri) => (
                            <tr key={ri} className="border-b border-slate-900/80">
                              {(previewVar.columns ?? []).map((_, ci) => (
                                <td
                                  key={ci}
                                  className="px-1.5 py-0.5 text-slate-300 truncate max-w-[8rem]"
                                >
                                  {row[ci] === null || row[ci] === undefined
                                    ? 'NULL'
                                    : String(row[ci])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {(previewVar.rows?.length ?? 0) > TABLE_PREVIEW_ROWS && (
                      <p className="px-1.5 py-0.5 text-slate-500">
                        … {(previewVar.rows?.length ?? 0) - TABLE_PREVIEW_ROWS} more rows
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!adding && canWrite && (
        <button
          type="button"
          data-testid="sql-variable-add"
          onClick={() => {
            setAdding(true);
            setError(null);
          }}
          className="flex items-center gap-0.5 self-start text-[14px] font-bold text-slate-400 hover:text-cyan-300 transition mt-0.5"
        >
          <Plus className="w-3.5 h-3.5 text-emerald-400" strokeWidth={SQL_ICON_STROKE} /> Add variable
        </button>
      )}
    </div>
  );
};
