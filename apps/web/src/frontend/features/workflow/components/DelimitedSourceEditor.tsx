/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/DelimitedSourceEditor.tsx).
 */
import { useMemo, useState } from 'react';
import { Eye, FileText, Plus, X } from 'lucide-react';
import { api, type ParsePreview } from '../api/engineClient';
import { compileZodSchema } from '../lib/zodSchema';

/**
 * Config editor for the delimited file sources (`source.file.csv`,
 * `source.file.text`): parsing options, a Zod-authored validation schema
 * (regex rules included), and a preview table that parses a pasted sample or
 * the head of the configured file with the exact code a run would use.
 */

type Kind = 'csv' | 'text';

interface Props {
  kind: Kind;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

/** Show tabs/newlines in delimiter inputs as \t / \n so they stay typeable. */
const escapeDelimiter = (value: string): string =>
  value.replace(/[\\\t\n]/g, (c) => (c === '\\' ? '\\\\' : c === '\t' ? '\\t' : '\\n'));

const unescapeDelimiter = (value: string): string =>
  value.replace(/\\(\\|t|n)/g, (_, c: string) =>
    c === 't' ? '\t' : c === 'n' ? '\n' : '\\',
  );

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Value types a column can declare — mirrors COLUMN_TYPES in the core. */
const COLUMN_TYPES = ['string', 'integer', 'number', 'boolean', 'date'] as const;
/** Suggested regex-check kinds — mirrors COLUMN_CHECK_KINDS in the core. */
const CHECK_KINDS = ['null', 'length', 'format'] as const;

interface ColumnCheck {
  pattern: string;
  kind?: string;
  message?: string;
}

interface ColumnRuleFields {
  type?: string;
  /** Legacy single regex — migrated into `checks` in the editor when present. */
  pattern?: string;
  checks?: ColumnCheck[];
  required?: boolean;
}

interface FixedColumn extends ColumnRuleFields {
  name: string;
  start: number;
  length: number;
}

interface FieldRule extends ColumnRuleFields {
  name: string;
}

const parseChecks = (value: unknown): ColumnCheck[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!v || typeof v !== 'object') return [];
    const raw = v as ColumnCheck;
    // Keep blank patterns — staged "Add regex" rows until the user types.
    return [
      {
        pattern: str(raw.pattern),
        ...(raw.kind ? { kind: String(raw.kind) } : {}),
        ...(raw.message ? { message: String(raw.message) } : {}),
      },
    ];
  });
};

/** Normalize rule fields: fold legacy `pattern` into `checks` for editing. */
const ruleFields = (raw: ColumnRuleFields): ColumnRuleFields => {
  const checks = parseChecks(raw.checks);
  const legacy = str(raw.pattern);
  if (legacy && !checks.some((check) => check.pattern === legacy)) {
    checks.unshift({ pattern: legacy });
  }
  return {
    ...(raw.type ? { type: String(raw.type) } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    ...(raw.required ? { required: true } : {}),
  };
};

/** Persist only non-default type/checks/required fields. */
const compactRuleFields = (fields: ColumnRuleFields): ColumnRuleFields => {
  const next: ColumnRuleFields = {};
  if (fields.type && fields.type !== 'string') next.type = fields.type;
  const checks = fields.checks ?? [];
  // Keep blank pattern rows while editing — runtime skips them.
  if (checks.length > 0) {
    next.checks = checks.map((check) => ({
      pattern: check.pattern,
      ...(check.kind ? { kind: check.kind } : {}),
      ...(check.message ? { message: check.message } : {}),
    }));
  }
  if (fields.required) next.required = true;
  return next;
};

const fixedColumns = (value: unknown): FixedColumn[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        if (!v || typeof v !== 'object') return [];
        const raw = v as FixedColumn;
        return [
          {
            name: str(raw.name),
            start: num(raw.start, 1),
            length: num(raw.length, 1),
            ...ruleFields(raw),
          },
        ];
      })
    : [];

const fieldRules = (value: unknown): FieldRule[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        if (!v || typeof v !== 'object') return [];
        const raw = v as FieldRule;
        const name = str(raw.name);
        if (!name) return [];
        return [{ name, ...ruleFields(raw) }];
      })
    : [];

/**
 * Shared type + multi-regex editor for fixed columns and delimited field rules.
 * Checks are labeled null / length / format (or custom) for clearer failures.
 */
function ColumnRuleEditor({
  name,
  nameEditable = false,
  fields,
  onNameChange,
  onFieldsChange,
  onRemove,
}: {
  name: string;
  nameEditable?: boolean;
  fields: ColumnRuleFields;
  onNameChange?: (name: string) => void;
  onFieldsChange: (changes: ColumnRuleFields) => void;
  onRemove?: () => void;
}) {
  const checks = fields.checks ?? [];
  const patchCheck = (index: number, changes: Partial<ColumnCheck>) => {
    const next = [...checks];
    const merged = { ...next[index]!, ...changes };
    if (!merged.kind) delete merged.kind;
    if (!merged.message) delete merged.message;
    next[index] = merged;
    onFieldsChange({ ...fields, checks: next });
  };

  return (
    <div className="column-rule-editor">
      <div
        className={
          nameEditable ? 'fixed-column-rule fixed-column-rule-named' : 'fixed-column-rule'
        }
      >
        {nameEditable && (
          <input data-testid={`workflow-source-rule-name-${name}`}
            type="text"
            placeholder="field name"
            title="Field name this rule applies to"
            value={name}
            onChange={(ev) => onNameChange?.(ev.target.value)}
          />
        )}
        <select data-testid={`workflow-source-rule-type-${name}`}
          title="Value type — validated and converted"
          value={fields.type ?? 'string'}
          onChange={(ev) => onFieldsChange({ ...fields, type: ev.target.value })}
        >
          {COLUMN_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <label
          className="checkbox-row"
          title="Reject rows where this column is empty"
        >
          <input data-testid={`workflow-source-rule-required-${name}`}
            type="checkbox"
            checked={fields.required ?? false}
            onChange={(ev) =>
              onFieldsChange({ ...fields, required: ev.target.checked })
            }
          />
          req
        </label>
        {onRemove && (
          <button data-testid={`workflow-source-rule-remove-${name}`} type="button" title="Remove rule" onClick={onRemove}>
            <X size={12} />
          </button>
        )}
      </div>
      {checks.map((check, index) => (
        <div className="column-check-row" key={index}>
          <select data-testid={`workflow-source-rule-check-kind-${name}-${index}`}
            title="Check purpose (shown in error messages)"
            value={check.kind ?? ''}
            onChange={(ev) =>
              patchCheck(index, { kind: ev.target.value || undefined })
            }
          >
            <option value="">custom</option>
            {CHECK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <input data-testid={`workflow-source-rule-check-pattern-${name}-${index}`}
            type="text"
            placeholder={
              check.kind === 'null'
                ? 'e.g. ^(?!(?:NULL|N/?A)$).+$'
                : check.kind === 'length'
                  ? 'e.g. ^.{1,50}$'
                  : check.kind === 'format'
                    ? 'e.g. ^\\S+@\\S+$'
                    : 'regex pattern'
            }
            title="Regex the raw text must match"
            value={check.pattern}
            onChange={(ev) => patchCheck(index, { pattern: ev.target.value })}
          />
          <button data-testid={`workflow-source-rule-check-remove-${name}-${index}`}
            type="button"
            title="Remove regex check"
            onClick={() =>
              onFieldsChange({
                ...fields,
                checks: checks.filter((_, i) => i !== index),
              })
            }
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button data-testid={`workflow-source-rule-check-add-${name}`}
        type="button"
        className="linkish"
        onClick={() =>
          onFieldsChange({
            ...fields,
            checks: [...checks, { pattern: '', kind: 'format' }],
          })
        }
      >
        <Plus size={11} /> Add regex
      </button>
    </div>
  );
}

export function DelimitedSourceEditor({ kind, config, onChange }: Props) {
  const [zodText, setZodText] = useState(() => str(config.schemaSource));
  const [zodError, setZodError] = useState<string | null>(null);
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const schema =
    config.schema && typeof config.schema === 'object' && !Array.isArray(config.schema)
      ? (config.schema as Record<string, unknown>)
      : undefined;
  const delimiters = strings(config.delimiters);
  const fields = strings(config.fields);
  const columns = fixedColumns(config.columns);
  const rules = fieldRules(config.rules);
  const format = str(config.format, 'delimited') === 'fixed' ? 'fixed' : 'delimited';

  const patch = (changes: Record<string, unknown>) => {
    const next = { ...config, ...changes };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') delete next[key];
    }
    onChange(next);
  };

  const patchZod = (code: string) => {
    setZodText(code);
    // zod loads with the first schema typed; results arrive in keystroke order.
    void compileZodSchema(code).then((compiled) => {
      if (compiled === null) {
        setZodError(null);
        patch({ schema: undefined, schemaSource: undefined });
        return;
      }
      if ('error' in compiled) {
        // Keep the last good schema until the code compiles again.
        setZodError(compiled.error);
        return;
      }
      setZodError(null);
      patch({ schema: compiled.schema, schemaSource: code });
    });
  };

  const runPreview = async (source: 'sample' | 'file') => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await api.previewParse({
        kind,
        config,
        ...(source === 'sample' ? { sample } : {}),
      });
      setPreview(result);
    } catch (error) {
      setPreview(null);
      setPreviewError((error as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const invalidByIndex = useMemo(
    () =>
      new Map(
        (preview?.invalid ?? []).map((row) => [
          row.index,
          { line: row.line, message: row.message },
        ]),
      ),
    [preview],
  );

  /** Compact "rows 2, 5, 8" / "lines 3, 7" list for the preview summary. */
  const failedRowLabels = useMemo(() => {
    const rows = preview?.invalid ?? [];
    if (rows.length === 0) return '';
    const labels = rows.map((row) => String(row.line ?? row.index + 1));
    const shown = labels.slice(0, 8);
    const rest = labels.length - shown.length;
    return `${shown.join(', ')}${rest > 0 ? `, …(+${rest})` : ''}`;
  }, [preview]);

  return (
    <div className="delimited-editor">
      <label>File path</label>
      <input data-testid="workflow-source-path"
        type="text"
        value={str(config.path)}
        placeholder={kind === 'csv' ? 'imports/orders.csv' : 'imports/report.txt'}
        onChange={(ev) => patch({ path: ev.target.value })}
      />
      <p className="hint">
        Relative to the engine's workflow files folder (<code>FOXFLOW_FILES_DIR</code>).
      </p>

      {kind === 'csv' ? (
        <div className="delimited-grid">
          <div>
            <label>Delimiter</label>
            <input data-testid="workflow-source-delimiter"
              type="text"
              maxLength={2}
              value={escapeDelimiter(str(config.delimiter, ','))}
              onChange={(ev) => {
                const raw = unescapeDelimiter(ev.target.value);
                if (raw.length <= 1) patch({ delimiter: raw || undefined });
              }}
            />
          </div>
          <div>
            <label>Skip lines</label>
            <input data-testid="workflow-source-skip-lines"
              type="number"
              min={0}
              value={num(config.skipLines, 0)}
              onChange={(ev) =>
                patch({ skipLines: Math.max(0, Number(ev.target.value) || 0) || undefined })
              }
            />
          </div>
        </div>
      ) : (
        <>
          <div className="delimited-grid">
            <div>
              <label>Format</label>
              <select data-testid="workflow-source-format"
                value={format}
                onChange={(ev) =>
                  patch({
                    format: ev.target.value === 'fixed' ? 'fixed' : undefined,
                  })
                }
              >
                <option value="delimited">Delimited</option>
                <option value="fixed">Fixed width (offsets)</option>
              </select>
            </div>
            <div>
              <label>Offset (skip lines)</label>
              <input data-testid="workflow-source-offset"
                type="number"
                min={0}
                value={num(config.offset, 0)}
                onChange={(ev) =>
                  patch({ offset: Math.max(0, Number(ev.target.value) || 0) || undefined })
                }
              />
            </div>
          </div>

          {format === 'delimited' ? (
            <>
              <label>Field delimiters (any splits — \t for tab)</label>
              {delimiters.map((delimiter, index) => (
                <div className="delimiter-row" key={index}>
                  <input data-testid={`workflow-source-delimiter-${index}`}
                    type="text"
                    value={escapeDelimiter(delimiter)}
                    onChange={(ev) => {
                      const next = [...delimiters];
                      next[index] = unescapeDelimiter(ev.target.value);
                      patch({ delimiters: next });
                    }}
                  />
                  <button data-testid={`workflow-source-remove-delimiter-${index}`}
                    type="button"
                    title="Remove delimiter"
                    onClick={() =>
                      patch({ delimiters: delimiters.filter((_, i) => i !== index) })
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button data-testid="workflow-source-add-delimiter"
                type="button"
                className="linkish"
                onClick={() => patch({ delimiters: [...delimiters, ';'] })}
              >
                <Plus size={11} /> Add delimiter
              </button>

              <label>Record delimiter (flat map)</label>
              <input data-testid="workflow-source-record-delimiter"
                type="text"
                placeholder="optional, e.g. |"
                value={escapeDelimiter(str(config.recordDelimiter))}
                onChange={(ev) =>
                  patch({ recordDelimiter: unescapeDelimiter(ev.target.value) || undefined })
                }
              />

              <label>Field names (comma-separated, positional)</label>
              <input data-testid="workflow-source-field-names"
                type="text"
                placeholder="id, name, email — extras become field_N"
                value={fields.join(', ')}
                onChange={(ev) => {
                  const next = ev.target.value
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean);
                  patch({ fields: next.length > 0 ? next : undefined });
                }}
              />

              <label>Column rules (type + multi-regex)</label>
              <small className="form-help">
                Match rules to field names. Add several regexes per column for
                null / length / format checks — all must pass before type
                conversion.
              </small>
              {rules.map((rule, index) => {
                const patchRule = (changes: Partial<FieldRule>) => {
                  const next = [...rules];
                  const merged = { ...rule, ...changes };
                  const { name, ...fieldsOnly } = merged;
                  next[index] = { name, ...compactRuleFields(fieldsOnly) };
                  patch({ rules: next.length > 0 ? next : undefined });
                };
                return (
                  <ColumnRuleEditor
                    key={index}
                    name={rule.name}
                    nameEditable
                    fields={rule}
                    onNameChange={(name) => patchRule({ name })}
                    onFieldsChange={patchRule}
                    onRemove={() =>
                      patch({
                        rules: rules.filter((_, i) => i !== index),
                      })
                    }
                  />
                );
              })}
              <button data-testid="workflow-source-add-rule"
                type="button"
                className="linkish"
                onClick={() => {
                  const used = new Set(rules.map((rule) => rule.name));
                  const fromFields = fields.find((name) => !used.has(name));
                  patch({
                    rules: [
                      ...rules,
                      { name: fromFields ?? `field_${rules.length + 1}` },
                    ],
                  });
                }}
              >
                <Plus size={11} /> Add column rule
              </button>
            </>
          ) : (
            <>
              <label>Columns (1-based start, length, type + multi-regex)</label>
              {columns.map((column, index) => {
                const patchColumn = (changes: Partial<FixedColumn>) => {
                  const next = [...columns];
                  const merged = { ...column, ...changes };
                  const { name, start, length, ...fieldsOnly } = merged;
                  next[index] = {
                    name,
                    start,
                    length,
                    ...compactRuleFields(fieldsOnly),
                  };
                  patch({ columns: next });
                };
                return (
                  <div className="fixed-column-group" key={index}>
                    <div className="fixed-column-row">
                      <input data-testid={`workflow-source-column-name-${index}`}
                        type="text"
                        placeholder="name"
                        value={column.name}
                        onChange={(ev) => patchColumn({ name: ev.target.value })}
                      />
                      <input data-testid={`workflow-source-column-start-${index}`}
                        type="number"
                        min={1}
                        title="Start (1-based)"
                        value={column.start}
                        onChange={(ev) =>
                          patchColumn({ start: Math.max(1, Number(ev.target.value) || 1) })
                        }
                      />
                      <input data-testid={`workflow-source-column-length-${index}`}
                        type="number"
                        min={1}
                        title="Length"
                        value={column.length}
                        onChange={(ev) =>
                          patchColumn({ length: Math.max(1, Number(ev.target.value) || 1) })
                        }
                      />
                      <button data-testid={`workflow-source-column-remove-${index}`}
                        type="button"
                        title="Remove column"
                        onClick={() =>
                          patch({ columns: columns.filter((_, i) => i !== index) })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <ColumnRuleEditor
                      name={column.name}
                      fields={column}
                      onFieldsChange={patchColumn}
                    />
                  </div>
                );
              })}
              <button data-testid="workflow-source-add-column"
                type="button"
                className="linkish"
                onClick={() => {
                  const last = columns.at(-1);
                  // Next column starts right after the previous one ends.
                  const start = last ? last.start + last.length : 1;
                  patch({
                    columns: [...columns, { name: `col_${columns.length + 1}`, start, length: 10 }],
                  });
                }}
              >
                <Plus size={11} /> Add column
              </button>
            </>
          )}

          <label>Header line</label>
          <select data-testid="workflow-source-header"
            value={str(config.header, 'none')}
            onChange={(ev) =>
              patch({ header: ev.target.value === 'none' ? undefined : ev.target.value })
            }
          >
            <option value="none">No header — every line is data</option>
            <option value="skip">Always skip the first line</option>
            <option value="auto">Auto — skip only if it matches the column names</option>
          </select>

          <label className="checkbox-row">
            <input data-testid="workflow-source-trim"
              type="checkbox"
              checked={bool(config.trim, true)}
              onChange={(ev) => patch({ trim: ev.target.checked ? undefined : false })}
            />
            Trim values
          </label>
          <label className="checkbox-row">
            <input data-testid="workflow-source-skip-empty"
              type="checkbox"
              checked={bool(config.skipEmpty, true)}
              onChange={(ev) =>
                patch({ skipEmpty: ev.target.checked ? undefined : false })
              }
            />
            Skip empty lines/segments
          </label>
        </>
      )}

      <div className="body-validation">
        <label>
          Row validation schema (
          <a href="https://zod.dev" target="_blank" rel="noreferrer">
            Zod
          </a>
          , optional)
        </label>
        <textarea data-testid="workflow-source-row-schema"
          rows={4}
          className="code"
          spellCheck={false}
          placeholder={'z.object({ email: z.string().regex(/^\\S+@\\S+$/), id: z.string().regex(/^\\d+$/) })'}
          value={zodText}
          onChange={(ev) => patchZod(ev.target.value)}
        />
        {zodError ? (
          <div className="field-error">Zod: {zodError}</div>
        ) : (
          <small className="form-help">
            Values arrive as strings — regex rules (`z.string().regex(...)`)
            are the natural checks. Enforced on every row during the run.
          </small>
        )}
        {schema && (
          <details className="body-schema-preview">
            <summary>Generated JSON Schema</summary>
            <pre>{JSON.stringify(schema, null, 2)}</pre>
          </details>
        )}
        <label>On invalid row</label>
        <select data-testid="workflow-source-on-invalid"
          value={str(config.onInvalid, 'fail')}
          onChange={(ev) =>
            patch({ onInvalid: ev.target.value === 'fail' ? undefined : ev.target.value })
          }
        >
          <option value="fail">Fail the run</option>
          <option value="skip">Skip the row</option>
          <option value="reject">Route to the rejects output</option>
        </select>
        {str(config.onInvalid) === 'reject' && (
          <small className="form-help">
            Invalid rows leave through the node&apos;s <strong>rejects</strong>{' '}
            port with <code>_error</code> attached — connect it to any sink to
            keep a dead-letter file or table.
          </small>
        )}
      </div>

      <div className="delimited-preview">
        <label>Preview (sample data)</label>
        <textarea data-testid="workflow-source-sample"
          rows={4}
          className="code"
          spellCheck={false}
          placeholder={
            kind === 'csv'
              ? 'id,email\n1,ada@example.com\n2,not-an-email'
              : format === 'fixed'
                ? '000001John Smith         M19881015…  (fixed columns)'
                : 'skip this header line\n1;ada@example.com|2;not-an-email'
          }
          value={sample}
          onChange={(ev) => setSample(ev.target.value)}
        />
        <div className="delimited-preview-actions">
          <button data-testid="workflow-source-preview-sample"
            type="button"
            disabled={previewing || !sample.trim()}
            onClick={() => void runPreview('sample')}
          >
            <Eye size={11} /> Preview sample
          </button>
          <button data-testid="workflow-source-preview-file-head"
            type="button"
            disabled={previewing || !str(config.path)}
            title={str(config.path) ? 'Parse the head of the configured file' : 'Set a file path first'}
            onClick={() => void runPreview('file')}
          >
            <FileText size={11} /> Preview file head
          </button>
        </div>

        {previewError && <div className="field-error">{previewError}</div>}
        {preview?.error && <div className="field-error">{preview.error}</div>}
        {preview && !preview.error && (
          <>
            <div className={preview.invalid.length ? 'field-error' : 'hint body-schema-ok'}>
              {preview.invalid.length
                ? `${preview.total} record${preview.total === 1 ? '' : 's'} — ${preview.invalid.length} fail validation (line${preview.invalid.length === 1 ? '' : 's'} ${failedRowLabels})`
                : `✓ ${preview.total} record${preview.total === 1 ? '' : 's'}${schema || rules.length > 0 || columns.some((c) => c.checks?.length || c.type || c.required) ? ', all pass validation' : ''}`}
              {preview.truncated ? ' (preview truncated)' : ''}
            </div>
            {preview.records.length > 0 && (
              <div className="delimited-preview-table">
                <table>
                  <thead>
                    <tr>
                      <th title="Record #">#</th>
                      <th title="Source line">Line</th>
                      {preview.fields.map((field) => (
                        <th key={field}>{field}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.records.map((record, index) => {
                      const failure = invalidByIndex.get(index);
                      const line = preview.lines?.[index] ?? failure?.line;
                      return (
                        <tr
                          key={index}
                          className={failure ? 'invalid' : ''}
                          title={failure?.message}
                        >
                          <td>{index + 1}</td>
                          <td>{line ?? '—'}</td>
                          {preview.fields.map((field) => (
                            <td key={field}>{String(record[field] ?? '')}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {preview.invalid.slice(0, 8).map((row) => (
              <div className="field-error" key={row.index}>
                {row.line != null
                  ? `Line ${row.line} (row ${row.index + 1})`
                  : `Row ${row.index + 1}`}
                : {row.message}
              </div>
            ))}
            {preview.invalid.length > 8 && (
              <small className="form-help">
                …and {preview.invalid.length - 8} more invalid rows.
              </small>
            )}
          </>
        )}
      </div>
    </div>
  );
}
