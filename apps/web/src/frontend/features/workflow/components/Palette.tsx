/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/Palette.tsx).
 */
import { ArrowDownToLine, ArrowUpFromLine, Search, Shuffle, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CatalogEntry, CatalogCategory, PipeRole } from '../lib/catalog';

const ROLE_ICON: Record<PipeRole, typeof Zap> = {
  source: ArrowDownToLine,
  transform: Shuffle,
  sink: ArrowUpFromLine,
};

/** Keep only the entries `keep` accepts, dropping subgroups and categories left empty. */
function filterCategories(
  categories: CatalogCategory[],
  keep: (entry: CatalogEntry) => boolean,
): CatalogCategory[] {
  return categories
    .map((category) => {
      const subgroups = category.subgroups
        ?.map((subgroup) => ({
          ...subgroup,
          entries: subgroup.entries.filter(keep),
        }))
        .filter((subgroup) => subgroup.entries.length > 0);
      return {
        ...category,
        entries: category.entries.filter(keep),
        ...(subgroups ? { subgroups } : {}),
      };
    })
    .filter((category) => category.entries.length > 0);
}

function PaletteItem({
  entry,
  onAdd,
}: {
  entry: CatalogEntry;
  onAdd: (entry: CatalogEntry) => void;
}) {
  const Icon = ROLE_ICON[entry.role] ?? Zap;
  return (
    <div
      className="palette-item"
      title={`${entry.type} v${entry.version}`}
      draggable
      onClick={() => onAdd(entry)}
      onDragStart={(ev) => {
        ev.dataTransfer.setData('application/x-fox-workflow-pipe', entry.type);
        ev.dataTransfer.effectAllowed = 'move';
      }}
    >
      <span className={`role-icon ${entry.role}`}>
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <span className="palette-item-text">
        <span className="palette-item-label">{entry.label}</span>
        <span className="palette-item-type">{entry.type}</span>
      </span>
    </div>
  );
}

export function Palette({
  categories,
  onAdd,
}: {
  categories: CatalogCategory[];
  onAdd: (entry: CatalogEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const visibleCategories = useMemo(
    () =>
      filterCategories(
        categories,
        (entry) => showAdvanced || entry.palette !== 'advanced',
      ),
    [categories, showAdvanced],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleCategories;
    return filterCategories(
      visibleCategories,
      (entry) =>
        entry.label.toLowerCase().includes(q) ||
        entry.type.toLowerCase().includes(q) ||
        entry.category.toLowerCase().includes(q),
    );
  }, [visibleCategories, query]);

  const advancedCount = useMemo(
    () =>
      categories.reduce(
        (sum, category) =>
          sum +
          category.entries.filter((entry) => entry.palette === 'advanced')
            .length,
        0,
      ),
    [categories],
  );

  return (
    <aside className="palette">
      <div className="palette-header">
        <h3>Nodes</h3>
        <div className="palette-search-wrap">
          <Search size={14} className="palette-search-icon" />
          <input data-testid="workflow-palette-search-pipes"
            className="palette-search"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Search pipes…"
            aria-label="Search pipes"
          />
        </div>
        {advancedCount > 0 && (
          <label className="palette-advanced-toggle">
            <input data-testid="workflow-palette-show-advanced"
              type="checkbox"
              checked={showAdvanced}
              onChange={(event) => setShowAdvanced(event.target.checked)}
            />
            Show advanced pipes ({advancedCount})
          </label>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="empty">
          {categories.length === 0 ? 'Loading connectors…' : 'No matches.'}
        </p>
      ) : (
        filtered.map((category) => (
          <details key={category.id} open>
            <summary>
              {category.label}
              <span className="palette-count">{category.entries.length}</span>
            </summary>
            {category.subgroups
              ? category.subgroups.map((subgroup) => (
                  <div key={subgroup.id} className="palette-subgroup">
                    {subgroup.label && (
                      <div className="palette-subgroup-label">
                        {subgroup.label}
                      </div>
                    )}
                    {subgroup.entries.map((entry) => (
                      <PaletteItem key={entry.type} entry={entry} onAdd={onAdd} />
                    ))}
                  </div>
                ))
              : category.entries.map((entry) => (
                  <PaletteItem key={entry.type} entry={entry} onAdd={onAdd} />
                ))}
          </details>
        ))
      )}
    </aside>
  );
}
