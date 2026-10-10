import React, { useMemo, useState } from 'react';
import { inputCls } from '@/shared/components/controls';

/** Searchable checkbox list for tables or columns. */
export const ObjectPicker: React.FC<{
  label: string;
  items: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  emptyHint?: string;
  testId: string;
}> = ({ label, items, selected, onChange, emptyHint, testId }) => {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? items.filter((n) => n.toLowerCase().includes(q))
        : items,
    [items, q]
  );

  const toggle = (name: string) => {
    onChange(
      selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name]
    );
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase text-slate-500">{label}</span>
        <span className="text-[10px] text-slate-500">
          {selected.length} selected
          {items.length > 0 ? ` · ${items.length} available` : ''}
        </span>
      </div>
      <input
        data-testid={`${testId}-filter`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search…"
        className={inputCls}
      />
      <div
        className="max-h-40 overflow-y-auto rounded-md border border-slate-800 bg-slate-950/50 divide-y divide-slate-900"
        data-testid={`${testId}-list`}
      >
        {items.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-slate-500">
            {emptyHint ?? 'Load schema objects first.'}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-slate-500">No matches.</p>
        ) : (
          filtered.map((name) => (
            <label
              key={name}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono text-slate-200 hover:bg-slate-900 cursor-pointer"
            >
              <input
                type="checkbox"
                data-testid={`${testId}-item-${name}`}
                checked={selected.includes(name)}
                onChange={() => toggle(name)}
              />
              <span className="truncate">{name}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
};
