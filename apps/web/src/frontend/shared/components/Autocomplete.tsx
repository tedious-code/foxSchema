import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type AutocompleteOption = {
  value: string;
  /** Shown instead of value when present. */
  label?: string;
  hint?: string;
};

export type AutocompleteTheme = {
  input: string;
  list: string;
  optionActive: string;
  optionIdle: string;
  empty: string;
  chevron: string;
};

/**
 * Preset skins — callers can still override `className` on the input.
 *
 * The list is deliberately tall and high-contrast: it doubles as the dropdown
 * for pickers that used to be a native `<select>`, so a reader scanning for a
 * table or principal should see ten rows at once, not four.
 */
export const autocompleteThemes = {
  /** Access Assistant, connections, admin panels. */
  slate: {
    input:
      'w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[12px] font-mono text-slate-100 outline-none accent-focus disabled:opacity-50 placeholder:text-slate-500',
    list: 'absolute z-50 left-0 right-0 mt-1 max-h-80 overflow-y-auto rounded-md border border-slate-500 bg-slate-900 shadow-2xl shadow-black/60 py-1',
    optionActive: 'bg-sky-500/25 text-sky-50',
    optionIdle: 'text-slate-200 hover:bg-slate-800',
    empty:
      'absolute z-50 left-0 right-0 mt-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-[12px] text-slate-500',
    chevron: 'text-slate-400 hover:text-slate-100',
  },
  /** SQL Editor blueprint / schema pickers. */
  violet: {
    input:
      'w-full bg-white/5 border border-violet-400/35 rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-slate-100 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20 disabled:opacity-50 placeholder:text-slate-500',
    list: 'absolute z-50 left-0 right-0 mt-1 max-h-80 overflow-y-auto rounded-lg border border-violet-400/50 bg-slate-800/95 backdrop-blur-md shadow-2xl shadow-violet-950/60 py-1',
    optionActive: 'bg-violet-500/30 text-violet-50',
    optionIdle: 'text-slate-200 hover:bg-violet-500/15',
    empty:
      'absolute z-50 left-0 right-0 mt-1 rounded-lg border border-slate-600/50 bg-slate-800/95 px-2.5 py-2 text-[12px] text-slate-400',
    chevron: 'text-violet-300/70 hover:text-violet-100',
  },
} satisfies Record<string, AutocompleteTheme>;

export type AutocompleteThemeName = keyof typeof autocompleteThemes;

/** Rank options for typeahead — exported for unit tests and custom UIs. */
export function filterAutocompleteOptions(
  options: readonly AutocompleteOption[],
  query: string,
  maxResults = 120
): AutocompleteOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options.slice(0, maxResults);
  const scored: { o: AutocompleteOption; score: number }[] = [];
  for (const o of options) {
    const v = o.value.toLowerCase();
    const l = (o.label ?? o.value).toLowerCase();
    let score = 0;
    if (v === q) score = 100;
    else if (v.startsWith(q)) score = 80;
    else if (v.includes(q)) score = 50;
    else if (l.includes(q)) score = 30;
    else continue;
    scored.push({ o, score });
  }
  scored.sort((a, b) => b.score - a.score || a.o.value.localeCompare(b.o.value));
  return scored.slice(0, maxResults).map((x) => x.o);
}

/**
 * Accessible combobox with keyboard navigation and optional exact-match on blur.
 * Free text is allowed — suggestions assist typing, they do not restrict it.
 *
 * Opening the list shows every option, with the current value highlighted,
 * until the reader types. Filtering by the value that is already in the box
 * left exactly one row visible whenever a picker was reopened, which made it
 * useless for browsing — the reason people reach for a dropdown at all.
 */
export const Autocomplete: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: readonly AutocompleteOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Overrides theme input classes when set. */
  className?: string;
  theme?: AutocompleteThemeName;
  maxResults?: number;
  /** Snap typed text to a catalog option when blur matches case-insensitively. */
  resolveExactOnBlur?: boolean;
  'data-testid'?: string;
}> = ({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  theme = 'slate',
  maxResults = 120,
  resolveExactOnBlur = true,
  'data-testid': testId,
}) => {
  const skin = autocompleteThemes[theme];
  const [open, setOpen] = useState(false);
  // Whether the reader has typed since the list opened. Until then the box
  // holds a picked value, and filtering by it would hide everything else.
  const [typed, setTyped] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const filtered = useMemo(
    () => filterAutocompleteOptions(options, typed ? value : '', maxResults),
    [options, value, typed, maxResults]
  );

  const currentIndex = useMemo(() => {
    const v = value.trim().toLowerCase();
    if (!v) return -1;
    return filtered.findIndex((o) => o.value.toLowerCase() === v);
  }, [filtered, value]);

  useEffect(() => {
    setHighlight(currentIndex >= 0 ? currentIndex : 0);
  }, [currentIndex, open, typed]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelectorAll('[role="option"]')[highlight];
    // jsdom draws no layout and has no scrollIntoView.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const show = () => {
    if (disabled) return;
    setTyped(false);
    setOpen(true);
  };

  const pick = (v: string) => {
    onChange(v);
    setTyped(false);
    setOpen(false);
  };

  const resolveExact = () => {
    if (!resolveExactOnBlur) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const exact = options.find((o) => o.value.toLowerCase() === trimmed.toLowerCase());
    if (exact && exact.value !== value) onChange(exact.value);
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const hasOptions = options.length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[highlight] ? optionId(highlight) : undefined}
        data-testid={testId}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onFocus={show}
        onClick={() => {
          if (!open) show();
        }}
        onBlur={() => {
          window.setTimeout(() => {
            resolveExact();
            setOpen(false);
            setTyped(false);
          }, 140);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) show();
            else setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter' && open && filtered[highlight]) {
            e.preventDefault();
            pick(filtered[highlight]!.value);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        className={`${className ?? skin.input} ${hasOptions ? 'pr-8' : ''}`.trim()}
      />
      {hasOptions && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? 'Hide options' : 'Show options'}
          data-testid={testId ? `${testId}-toggle` : undefined}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            inputRef.current?.focus();
            show();
          }}
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 disabled:opacity-40 ${skin.chevron}`}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
      {open && !disabled && filtered.length > 0 && (
        <ul id={listId} ref={listRef} role="listbox" className={skin.list}>
          {filtered.map((o, i) => {
            const active = i === highlight;
            const current = i === currentIndex;
            return (
              <li
                // Two options may share a value and differ only in hint — a
                // user and a role with the same name — and both must render.
                key={`${o.value}\u0000${o.label ?? ''}\u0000${o.hint ?? ''}`}
                id={optionId(i)}
                role="option"
                aria-selected={active}
                data-value={o.value}
              >
                <button data-testid={testId ? `${testId}-option-${o.value}` : undefined}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.value)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`w-full flex items-baseline gap-2 px-3 py-2 text-left text-[13px] font-mono ${
                    active ? skin.optionActive : skin.optionIdle
                  }`}
                >
                  <span className={`truncate ${current ? 'font-bold' : 'font-semibold'}`}>
                    {o.label ?? o.value}
                  </span>
                  {o.hint && (
                    <span className="ml-auto shrink-0 text-[11px] text-slate-400 font-sans">{o.hint}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && !disabled && typed && value.trim() && filtered.length === 0 && (
        <div className={skin.empty}>No matches</div>
      )}
    </div>
  );
};
