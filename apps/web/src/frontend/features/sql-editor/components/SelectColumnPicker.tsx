/**
 * Checkbox list of alias.column when the user clicks SELECT / FROM in the editor.
 * Select all → `*`; Remove all clears the list; toggles sync into the SQL text.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns3, X } from 'lucide-react';
import { extractTableAliases } from '@/shared/lib/sql-splitter';
import {
  clearSelectList,
  currentSelectListItems,
  ensureAllFromTablesAliased,
  insertIntoSelectList,
  removeFromSelectList,
  selectListIsStar,
  setSelectListToStar,
  shortAliasesByTable,
} from '@/features/sql-editor/lib/selectClauseEdit';
import { getCompletionContext, mutateSql } from '../lib/sqlEditorBridge';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export type SelectColumnPickerAnchor = {
  top: number;
  left: number;
};

interface Props {
  open: boolean;
  anchor: SelectColumnPickerAnchor | null;
  onClose: () => void;
}

type ColOpt = { key: string; label: string; expr: string };

export const SelectColumnPicker: React.FC<Props> = ({ open, anchor, onClose }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  // Bump to re-read live SQL after each mutation (options depend on FROM aliases).
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);

  // Opening the picker: attach short aliases to bare FROM tables (`orders` → `orders o`)
  // and rewrite SELECT qualifiers so checkboxes match.
  useEffect(() => {
    if (!open) return;
    const before = getCompletionContext().sql;
    const after = ensureAllFromTablesAliased(before);
    if (after !== before) {
      mutateSql(() => after);
      refresh();
    }
  }, [open]);

  // Close when clicking outside the box (defer so the opening click doesn't dismiss it).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);

  const { options, star, selected } = useMemo(() => {
    if (!open) return { options: [] as ColOpt[], star: false, selected: new Set<string>() };
    const ctx = getCompletionContext();
    const aliases = extractTableAliases(ctx.sql);
    // Keyed by qualified *and* bare name — the schema cache stores bare names,
    // while FROM may be written as `Carter.ORDER ord`.
    const aliasToTable = shortAliasesByTable(ctx.sql);
    const out: ColOpt[] = [];
    const seen = new Set<string>();
    for (const schema of ctx.schemas) {
      for (const table of schema.tables ?? []) {
        if (table.objectType !== 'TABLE' && table.objectType !== 'VIEW' && table.objectType !== 'MQT') {
          continue;
        }
        const bare = table.name.includes('.')
          ? table.name.slice(table.name.lastIndexOf('.') + 1)
          : table.name;
        const alias =
          aliasToTable.get(table.name.toLowerCase()) ||
          aliasToTable.get(bare.toLowerCase()) ||
          bare;
        const referenced =
          Object.keys(aliases).length === 0 ||
          aliases[alias.toLowerCase()] ||
          aliases[bare.toLowerCase()] ||
          aliases[table.name.toLowerCase()];
        if (!referenced) continue;
        for (const col of table.columns ?? []) {
          const expr = `${alias}.${col.name}`;
          const key = expr.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ key, label: expr, expr });
        }
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    const items = currentSelectListItems(ctx.sql).map((it) => it.toLowerCase());
    const selected = new Set<string>();
    for (const it of items) {
      if (it === '*') continue;
      selected.add(it);
      // Also mark matching alias.col options when SQL used table.col or bare col.
      const col = it.includes('.') ? it.slice(it.lastIndexOf('.') + 1) : it;
      for (const opt of out) {
        const optCol = opt.key.includes('.') ? opt.key.slice(opt.key.lastIndexOf('.') + 1) : opt.key;
        if (opt.key === it || optCol === col) selected.add(opt.key);
      }
    }
    return {
      options: out,
      star: selectListIsStar(ctx.sql),
      selected,
    };
    // tick forces re-read after mutateSql
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional refresh latch
  }, [open, tick]);

  if (!open || !anchor) return null;

  const apply = (fn: (sql: string) => string) => {
    mutateSql(fn);
    refresh();
  };

  return createPortal(
    <div
      ref={rootRef}
      data-testid="sql-select-column-picker"
      className="fixed z-[120] w-72 max-h-80 flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
      style={{
        top: Math.min(anchor.top, window.innerHeight - 340),
        left: Math.min(anchor.left, window.innerWidth - 300),
      }}
    >
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-slate-800 shrink-0">
        <Columns3 className="w-3.5 h-3.5 text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
        <span className="text-[11px] font-bold text-slate-200 flex-1">SELECT columns</span>
        <button data-testid="sql-select-close"
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="p-0.5 text-slate-500 hover:text-slate-200"
        >
          <X className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-800/80 shrink-0">
        <button
          type="button"
          data-testid="sql-select-all-star"
          title="SELECT *"
          onClick={() => apply(setSelectListToStar)}
          className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${
            star
              ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
              : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
          }`}
        >
          Select all (*)
        </button>
        <button
          type="button"
          data-testid="sql-select-remove-all"
          title="Clear SELECT list"
          onClick={() => apply(clearSelectList)}
          className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-700 text-slate-300 hover:border-rose-500/40 hover:text-rose-200 transition"
        >
          Remove all
        </button>
      </div>

      <ul className="overflow-y-auto flex-1 min-h-0 px-1 py-1">
        {options.length === 0 ? (
          <li className="px-2 py-3 text-[11px] text-slate-500">
            No columns found — load Schema and add tables in FROM.
          </li>
        ) : (
          options.map((opt) => {
            const checked = !star && selected.has(opt.key);
            return (
              <li key={opt.key}>
                <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800/70 cursor-pointer text-[11px] font-mono text-slate-200">
                  <input
                    type="checkbox"
                    checked={checked}
                    data-testid={`sql-select-col-${opt.key}`}
                    onChange={() => {
                      if (checked) {
                        apply((sql) => removeFromSelectList(sql, opt.expr));
                      } else {
                        apply((sql) => insertIntoSelectList(sql, opt.expr));
                      }
                    }}
                    className="accent-cyan-500"
                  />
                  <span className={checked ? '' : 'text-slate-500'}>{opt.label}</span>
                </label>
              </li>
            );
          })
        )}
      </ul>
      <div className="px-2 py-1.5 border-t border-slate-800 text-[10px] text-slate-500 shrink-0">
        {star
          ? 'SELECT * · pick columns to replace *'
          : options.length === 0
            ? 'No schema columns — load Schema for tables in FROM'
            : `${options.filter((o) => selected.has(o.key)).length}/${options.length} selected · click SELECT/FROM to reopen`}
      </div>
    </div>,
    document.body
  );
};
