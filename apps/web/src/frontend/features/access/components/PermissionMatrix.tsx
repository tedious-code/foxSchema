/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The object × privilege grid.
 *
 * The flat builder answers "one permission set, one scope", so a realistic
 * grant — read four tables, write one, run two procedures — is four passes
 * through the form and four separate blocks of SQL to reconcile by hand. Here
 * the whole answer is one screen: rows are objects, columns are privileges, and
 * the SQL is compiled from the ticks.
 *
 * Cells an engine cannot express are drawn and disabled rather than hidden,
 * carrying the reason on hover. Hiding them makes the grid look uniform across
 * engines that are not, and sends the reader looking for a checkbox that was
 * never there; "PostgreSQL has no GRANT for this — changing an object requires
 * owning it" answers the question they actually have.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Table2, Eye, Cog, FunctionSquare, Info } from 'lucide-react';
import {
  cellSupport,
  permissionBand,
  compileGridChanges,
  compileObjectGrid,
  gridObjectKey,
  describePermission,
  gridColumnsFor,
  type AccessPermission,
  type AccessPrincipal,
  type GridObjectKind,
  type GridChanges,
  type GridRow,
  type PermissionRequest,
} from '../lib/access';
import { Autocomplete } from '@/shared/components/Autocomplete';
import { inputCls } from './controls';

/** A row plus the identity the list needs to keep inputs stable while editing. */
interface MatrixRow extends GridRow {
  id: string;
}

const KIND_META: Record<
  GridObjectKind,
  { label: string; plural: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  table: { label: 'Table', plural: 'Tables', Icon: Table2 },
  view: { label: 'View', plural: 'Views', Icon: Eye },
  procedure: { label: 'Procedure', plural: 'Procedures', Icon: Cog },
  function: { label: 'Function', plural: 'Functions', Icon: FunctionSquare },
};

/**
 * Short column headings.
 *
 * The full label lives in `describePermission` and reaches the reader through
 * the header's tooltip; a grid nine columns wide has room for a word.
 */
const COLUMN_LABEL: Partial<Record<AccessPermission, string>> = {
  read: 'Select',
  insert: 'Insert',
  update: 'Update',
  delete: 'Delete',
  reference: 'Refs',
  'index-object': 'Index',
  'trigger-object': 'Trigger',
  'alter-object': 'Alter',
  'drop-object': 'Drop',
  'execute-procedure': 'Execute',
  'execute-function': 'Execute',
};

/**
 * Which band a column sits under, said in plain words first.
 *
 * DML changes rows, DDL changes the object. Splitting them is what makes a wide
 * grid scannable: the two halves carry very different consequences, and the
 * reader is usually looking for one or the other. "DML" and "DDL" mean nothing
 * to a reader who did not come up through databases, so the heading says what
 * the columns let the account do, and keeps the term for those who look for it.
 */
const BAND: Record<'DML' | 'DDL', { heading: string; title: string }> = {
  DML: {
    heading: 'Work with rows · DML',
    title: 'Data privileges: read rows (SELECT) and change them (INSERT, UPDATE, DELETE). The table itself is untouched.',
  },
  DDL: {
    heading: 'Change the table · DDL',
    title: 'Structure privileges: change the object itself — add an index or trigger, ALTER its columns, DROP it.',
  },
};

/** What a cell will do when the SQL runs, against what the principal holds now. */
type CellChange = 'held' | 'grant' | 'revoke' | 'none';
const CELL_STYLE: Record<CellChange, { td: string; title: string }> = {
  held: { td: '', title: 'Held now' },
  grant: { td: 'bg-emerald-500/15', title: 'Will be granted' },
  revoke: { td: 'bg-rose-500/20', title: 'Held now — will be revoked' },
  none: { td: '', title: '' },
};

let rowSeq = 0;
const newRow = (kind: GridObjectKind): MatrixRow => ({
  id: `row-${++rowSeq}`,
  kind,
  name: '',
  permissions: [],
});

const PermissionMatrixGrid: React.FC<{
  dialect: string;
  principal: AccessPrincipal;
  action: 'grant' | 'revoke' | 'deny';
  schema: string;
  withGrantOption?: boolean;
  /** Table names for the row autocomplete, already scoped to `schema`. */
  tableChoices?: readonly string[];
  /**
   * The database's grantable objects, to open the grid on.
   *
   * When present the grid starts as the catalog rather than one blank row, and
   * rows carry the schema they came from. Rows stay editable either way — a
   * reader can still rename one or add an object the catalog missed.
   */
  catalog?: readonly { schema: string; name: string; kind: GridObjectKind }[];
  /**
   * A group of privileges to tick across every row.
   *
   * Carries a nonce because the same preset applied twice is a real request —
   * the reader may have edited rows in between and want them reset to it.
   * Each row takes only the subset its own kind can express, so "Read and
   * write" on a procedure row means EXECUTE rather than four dead ticks.
   */
  applyPreset?: { permissions: readonly AccessPermission[]; nonce: number } | null;
  /** Called whenever the ticks change, with the requests they compile to. */
  onChange?: (requests: PermissionRequest[]) => void;
  /**
   * What the principal already holds, by `gridObjectKey`.
   *
   * When given, the grid opens ticked as the catalog stands — an existing
   * role's boxes are not all empty — and each cell shows what will change:
   * green for a GRANT, red for a REVOKE. `onChanges` then reports only those
   * differences, so nothing the grid does not show is ever revoked.
   */
  held?: ReadonlyMap<string, readonly AccessPermission[]>;
  onChanges?: (changes: GridChanges) => void;
  /** Bump to put every row back to what is held, dropping the reader's edits. */
  resetNonce?: number;
}> = ({
  dialect,
  principal,
  action,
  schema,
  withGrantOption,
  tableChoices = [],
  catalog,
  applyPreset,
  onChange,
  held,
  onChanges,
  resetNonce,
}) => {
  const [rows, setRows] = useState<MatrixRow[]>(() => [newRow('table')]);
  /**
   * What decides a row's ticks when the catalog reseeds it. A row the reader
   * edited keeps their ticks. Otherwise the last preset wins, so a preset
   * clicked while schemas are still loading also ticks the rows that arrive
   * after it — before, it ticked only what had loaded and the rest came in
   * empty. With neither, a row opens on what is held.
   */
  const edited = useRef(new Set<string>());
  const preset = useRef<readonly AccessPermission[] | null>(null);
  const rowKey = useCallback((r: { schema?: string; kind: GridObjectKind; name: string }) => gridObjectKey({ ...r, schema: r.schema?.trim() || schema }), [schema]);
  const opening = useCallback(
    (o: { schema?: string; kind: GridObjectKind; name: string }): AccessPermission[] => {
      const available = gridColumnsFor(dialect, o.kind).filter((c) => c.support.available).map((c) => c.permission);
      if (preset.current) return available.filter((p) => preset.current!.includes(p));
      return [...(held?.get(rowKey(o)) ?? [])];
    },
    [dialect, held, rowKey]
  );
  const heldKey = useMemo(
    () =>
      held
        ? [...held.entries()]
            .map(([k, v]) => `${k}=${[...v].sort().join(',')}`)
            .sort()
            .join('\u0000')
        : '',
    [held]
  );

  /**
   * Open the grid on the catalog, and keep the reader's ticks across a reload.
   *
   * The loader commits one schema at a time, so the catalog grows under the
   * reader and this reseeds on every commit. Ticks are carried across by
   * schema+kind+name — a reseed builds new row ids for the same objects, so
   * carrying them by id would drop work the reader did while the rest of the
   * database was still arriving.
   *
   * Keyed on the catalog's *contents* rather than its array identity. That is
   * an efficiency measure, not the thing protecting the ticks: without it a
   * fresh array on every render reseeds needlessly, but the carry-over above
   * would still preserve them.
   */
  const catalogKey = useMemo(
    () => (catalog ?? []).map((o) => `${o.schema}.${o.kind}.${o.name}`).join('\u0000'),
    [catalog]
  );
  React.useEffect(() => {
    if (!catalogKey) return;
    setRows((prev) => {
      const ticked = new Map(prev.map((r) => [rowKey(r), r.permissions]));
      return (catalog ?? []).map((o, i) => {
        const key = rowKey(o);
        return {
          id: `cat-${i}-${o.schema}.${o.kind}.${o.name}`,
          kind: o.kind,
          name: o.name,
          schema: o.schema,
          permissions: edited.current.has(key) ? (ticked.get(key) ?? []) : opening(o),
        };
      });
    });
    // `catalog` is intentionally absent: `catalogKey` is its content digest,
    // and depending on the array itself reseeds on every loader commit. A
    // change in what is held (a reload) reseeds the rows the reader left alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey, heldKey]);

  // Keyed on the principal's *fields*, never its object identity. The parent
  // builds `principal` as a literal in its JSX, so a fresh object arrives on
  // every render; keying on identity made this memo recompute each time, which
  // fired the effect below, which set parent state, which re-rendered, which
  // produced another fresh object. The panel died with "Maximum update depth
  // exceeded" the moment it was opened.
  //
  // Depending on the fields makes the component safe however it is called,
  // rather than making correctness the caller's job to remember.
  const principalType = principal.type;
  const principalName = principal.name;
  const requests = useMemo(
    () =>
      compileObjectGrid(
        // A row keeps the schema it was loaded from; `schema` is only the
        // fallback for a row typed by hand. Overwriting it here forced every
        // row to one schema, so a catalog spanning the database compiled to
        // grants naming objects in the wrong one.
        rows.map((r) => ({ ...r, schema: r.schema?.trim() || schema })),
        {
          dialect,
          principal: { type: principalType, name: principalName },
          action,
          schema,
          withGrantOption,
        }
      ),
    [rows, dialect, principalType, principalName, action, schema, withGrantOption]
  );

  // `onChange` is called from an effect rather than from the click handlers so
  // that every path that mutates rows reports, including the bulk toggles.
  React.useEffect(() => {
    onChange?.(requests);
  }, [requests, onChange]);

  const changes = useMemo(
    () =>
      held
        ? compileGridChanges(
            rows.map((r) => ({ ...r, schema: r.schema?.trim() || schema })),
            held,
            { dialect, principal: { type: principalType, name: principalName }, schema, withGrantOption }
          )
        : null,
    [held, rows, dialect, principalType, principalName, schema, withGrantOption]
  );
  React.useEffect(() => {
    if (changes) onChanges?.(changes);
  }, [changes, onChanges]);

  const resetTo = resetNonce;
  React.useEffect(() => {
    if (resetTo === undefined) return;
    edited.current.clear();
    preset.current = null;
    setRows((prev) => prev.map((r) => ({ ...r, permissions: [...(held?.get(rowKey(r)) ?? [])] })));
    // Fires on the nonce alone, like the preset below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetTo]);

  const presetNonce = applyPreset?.nonce;
  const presetPermissions = applyPreset?.permissions;
  React.useEffect(() => {
    if (presetNonce === undefined || !presetPermissions) return;
    preset.current = presetPermissions;
    edited.current.clear();
    setRows((prev) =>
      prev.map((r) => {
        const available = gridColumnsFor(dialect, r.kind)
          .filter((c) => c.support.available)
          .map((c) => c.permission);
        return { ...r, permissions: available.filter((p) => presetPermissions.includes(p)) };
      })
    );
    // Fires on the nonce alone: `presetPermissions` is a fresh array each
    // render, and depending on it would re-apply the preset over every edit
    // the reader made afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetNonce]);

  const update = useCallback(
    (id: string, patch: Partial<MatrixRow>) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          const next = { ...r, ...patch };
          edited.current.add(rowKey(next));
          return next;
        })
      );
    },
    [rowKey]
  );

  const toggle = useCallback(
    (id: string, permission: AccessPermission) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          edited.current.add(rowKey(r));
          const has = r.permissions.includes(permission);
          return {
            ...r,
            permissions: has
              ? r.permissions.filter((p) => p !== permission)
              : [...r.permissions, permission],
          };
        })
      );
    },
    [rowKey]
  );

  /** Tick or clear every available cell in one row — the common bulk action. */
  const toggleRow = useCallback(
    (id: string) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          edited.current.add(rowKey(r));
          const available = gridColumnsFor(dialect, r.kind)
            .filter((c) => c.support.available)
            .map((c) => c.permission);
          const allOn = available.length > 0 && available.every((p) => r.permissions.includes(p));
          return { ...r, permissions: allOn ? [] : available };
        })
      );
    },
    [dialect, rowKey]
  );

  /** Tick or clear one column across every row of that kind. */
  const toggleColumn = useCallback(
    (kind: GridObjectKind, permission: AccessPermission) => {
      if (!cellSupport(dialect, kind, permission).available) return;
      setRows((prev) => {
        const inKind = prev.filter((r) => r.kind === kind);
        const allOn =
          inKind.length > 0 && inKind.every((r) => r.permissions.includes(permission));
        return prev.map((r) => {
          if (r.kind !== kind) return r;
          edited.current.add(rowKey(r));
          const has = r.permissions.includes(permission);
          if (allOn && has) return { ...r, permissions: r.permissions.filter((p) => p !== permission) };
          if (!allOn && !has) return { ...r, permissions: [...r.permissions, permission] };
          return r;
        });
      });
    },
    [dialect, rowKey]
  );

  /** Whether the loaded rows span more than one schema. */
  const multiSchema = useMemo(
    () => new Set(rows.map((r) => r.schema ?? '')).size > 1,
    [rows]
  );

  const kinds = useMemo(() => {
    const present = new Set(rows.map((r) => r.kind));
    return (['table', 'view', 'procedure', 'function'] as const).filter((k) => present.has(k));
  }, [rows]);

  const ticked = rows.reduce((n, r) => n + r.permissions.length, 0);
  const heldCount = held ? [...held.values()].reduce((n, v) => n + v.length, 0) : 0;
  const changeCount = (reqs: readonly PermissionRequest[]) =>
    reqs.reduce((n, r) => n + r.permissions.length * (r.scope.type === 'tables' ? r.scope.tables.length : r.scope.type === 'routines' ? r.scope.routines.length : 1), 0);

  return (
    <div className="flex flex-col gap-4" data-testid="permission-matrix">
      {kinds.map((kind) => {
        const columns = gridColumnsFor(dialect, kind);
        const kindRows = rows.filter((r) => r.kind === kind);
        const meta = KIND_META[kind];
        const bands = columns.reduce<{ band: 'DML' | 'DDL'; span: number }[]>((acc, c) => {
          const band = permissionBand(c.permission);
          const last = acc[acc.length - 1];
          if (last && last.band === band) last.span += 1;
          else acc.push({ band, span: 1 });
          return acc;
        }, []);

        return (
          <div
            key={kind}
            data-testid={`matrix-section-${kind}`}
            className="rounded-lg border border-slate-800 overflow-hidden"
          >
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-900/60 border-b border-slate-800">
              <meta.Icon className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-300">
                {meta.plural}
              </span>
              <span className="text-[11px] text-slate-500">{kindRows.length}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left font-normal px-3 py-1.5 w-[38%]">Name</th>
                    {bands.map((b, i) => (
                      <th
                        key={`${b.band}-${i}`}
                        colSpan={b.span}
                        title={BAND[b.band].title}
                        className={`px-2 py-1.5 font-bold uppercase tracking-wide text-[10px] border-l border-slate-800 cursor-help ${
                          b.band === 'DDL' ? 'text-amber-500/70' : 'text-slate-500'
                        }`}
                      >
                        {BAND[b.band].heading}
                      </th>
                    ))}
                    <th className="w-16" />
                  </tr>
                  <tr className="text-slate-400 border-b border-slate-800">
                    <th className="text-left font-normal px-3 pb-1.5">
                      <button
                        type="button"
                        onClick={() => setRows((p) => [...p, newRow(kind)])}
                        data-testid={`matrix-add-${kind}`}
                        className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                      >
                        <Plus className="w-3 h-3" />
                        Add {meta.label.toLowerCase()}
                      </button>
                    </th>
                    {columns.map(({ permission, support }) => {
                      const descriptor = describePermission(permission);
                      return (
                        <th
                          key={permission}
                          className="px-1 pb-1.5 font-normal border-l border-slate-800/60"
                        >
                          <button
                            type="button"
                            disabled={!support.available}
                            onClick={() => toggleColumn(kind, permission)}
                            data-testid={`matrix-col-${kind}-${permission}`}
                            title={
                              support.available
                                ? `${descriptor.label} (${descriptor.privilegeHint}) — click to tick every row`
                                : support.reason
                            }
                            className={
                              support.available
                                ? 'w-full text-[10px] hover:text-slate-100'
                                : 'w-full text-[10px] text-slate-600 line-through cursor-not-allowed'
                            }
                          >
                            {COLUMN_LABEL[permission] ?? descriptor.label}
                          </button>
                        </th>
                      );
                    })}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {kindRows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-800/50 last:border-0">
                      <td className="px-3 py-1">
                        {/*
                          * With a whole database loaded, `orders` is ambiguous:
                          * several schemas have one, and the row's schema is
                          * what the GRANT will name. Shown only when the grid
                          * actually spans more than one, so the single-schema
                          * case (and every MySQL/Oracle connection, which has
                          * no schema level at all) stays uncluttered.
                          */}
                        {multiSchema && (
                          <span
                            className="mr-1.5 rounded bg-slate-800 px-1 py-0.5 font-mono text-[10px] text-slate-400"
                            data-testid={`matrix-schema-${row.id}`}
                            title="Schema this object belongs to"
                          >
                            {row.schema || '—'}
                          </span>
                        )}
                        {/*
                          * A row from the catalog names a real object: text,
                          * not an input. It used to be an editable box under
                          * the schema badge — two lines per row, and a rename
                          * there pointed the GRANT at an object that may not
                          * exist. Rows the reader adds keep their input.
                          */}
                        {row.id.startsWith('cat-') ? (
                          <span
                            data-testid={`matrix-name-${row.id}`}
                            className="font-mono text-[12px] text-slate-200"
                          >
                            {row.name}
                          </span>
                        ) : kind === 'table' || kind === 'view' ? (
                          <Autocomplete
                            value={row.name}
                            onChange={(v) => update(row.id, { name: v })}
                            options={tableChoices.map((t) => ({ value: t, label: t }))}
                            placeholder={`${meta.label} name`}
                            data-testid={`matrix-name-${row.id}`}
                          />
                        ) : (
                          <input
                            className={inputCls}
                            value={row.name}
                            onChange={(e) => update(row.id, { name: e.target.value })}
                            placeholder={`${meta.label} name`}
                            data-testid={`matrix-name-${row.id}`}
                          />
                        )}
                      </td>
                      {columns.map(({ permission, support }) => {
                        const on = row.permissions.includes(permission);
                        const had = held?.get(rowKey(row))?.includes(permission) ?? false;
                        const change: CellChange = !held || !support.available
                          ? 'none'
                          : on && had
                            ? 'held'
                            : on
                              ? 'grant'
                              : had
                                ? 'revoke'
                                : 'none';
                        return (
                          <td
                            key={permission}
                            data-change={change}
                            className={`text-center border-l border-slate-800/40 px-1 ${CELL_STYLE[change].td}`}
                          >
                            <input
                              type="checkbox"
                              checked={on && support.available}
                              disabled={!support.available}
                              onChange={() => toggle(row.id, permission)}
                              title={support.available ? CELL_STYLE[change].title || undefined : support.reason}
                              data-testid={`matrix-cell-${row.id}-${permission}`}
                              className={
                                support.available
                                  ? 'accent-emerald-500 cursor-pointer'
                                  : 'opacity-25 cursor-not-allowed'
                              }
                            />
                          </td>
                        );
                      })}
                      <td className="px-1 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => toggleRow(row.id)}
                          data-testid={`matrix-row-all-${row.id}`}
                          title={`Tick or clear every privilege on ${row.name || 'this row'}`}
                          className="mr-1.5 text-[10px] text-slate-500 hover:text-slate-200"
                        >
                          All
                        </button>
                        <button
                          type="button"
                          onClick={() => setRows((p) => p.filter((r) => r.id !== row.id))}
                          title="Remove this row"
                          data-testid={`matrix-remove-${row.id}`}
                          className="text-slate-600 hover:text-red-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {kindRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={columns.length + 2}
                        className="px-3 py-3 text-center text-slate-600"
                      >
                        No {meta.plural.toLowerCase()} yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        {(['view', 'procedure', 'function'] as const)
          .filter((k) => !kinds.includes(k))
          .map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRows((p) => [...p, newRow(k)])}
              data-testid={`matrix-add-section-${k}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-700 text-[11px] text-slate-400 hover:text-slate-200"
            >
              <Plus className="w-3 h-3" />
              {KIND_META[k].plural}
            </button>
          ))}
      </div>

      {held && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" data-testid="matrix-legend">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-flex h-3 w-3 items-center justify-center rounded-sm bg-emerald-500 text-[9px] font-bold leading-none text-slate-950">✓</span> Held now
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500/40" /> Will be granted
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-rose-500/50" /> Held now, will be revoked
          </span>
          <span className="text-slate-500">
            Rows: read and change data (DML). Structure: change the table itself (DDL). Hover a heading for more.
          </span>
        </div>
      )}

      <div
        data-testid="matrix-summary"
        className="flex items-start gap-2 text-[11px] text-slate-500"
      >
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          {changes
            ? `${heldCount} privilege${heldCount === 1 ? '' : 's'} held now · ${changeCount(changes.grant)} to grant · ${changeCount(changes.revoke)} to revoke. Untick a box to revoke it; nothing the grid does not show is touched.`
            : ticked === 0
            ? 'Tick the privileges each object needs. Struck-through columns are ones this engine cannot grant on a single object — hover for why.'
            : `${ticked} privilege${ticked === 1 ? '' : 's'} ticked, compiled into ${
                requests.length
              } statement group${requests.length === 1 ? '' : 's'}. Objects sharing a privilege set are granted together.`}
        </span>
      </div>
    </div>
  );
};

/**
 * Memoised: a catalog of 1,000 objects is about 8,600 checkboxes, and a cell
 * click used to render the whole grid twice, once for its own state and again
 * when the parent stored the change set. The parent's props are stable.
 */
export const PermissionMatrix = React.memo(PermissionMatrixGrid);
