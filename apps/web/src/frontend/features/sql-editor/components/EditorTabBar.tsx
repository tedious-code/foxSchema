import React, { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import type { SqlTab } from '@/features/sql-editor/state/sqlEditorTabLogic';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

interface Props {
  tabs: SqlTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, title: string) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
}

/**
 * Multi-tab bar for the SQL Editor. Close is on the left; drag tabs to reorder.
 * Rename via double-click or the pencil; middle-click or × closes.
 * Always keeps at least one tab (store replaces the last with a fresh empty query).
 */
export const EditorTabBar: React.FC<Props> = ({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onAdd,
  onRename,
  onMove,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const suppressClickRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onlyTab = tabs.length <= 1;
  const onlyTabEmpty = onlyTab && !(tabs[0]?.sql ?? '').trim();

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startEdit = (tab: SqlTab, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingId(tab.id);
    setDraft(tab.title);
  };

  const commitEdit = () => {
    if (!editingId) return;
    onRename(editingId, draft);
    setEditingId(null);
  };

  /** Stop the draggable tab from eating button clicks (HTML5 DnD quirk). */
  const blockDragFromControl = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div
      className="flex items-stretch gap-0 border-b border-slate-800 bg-slate-950/40 overflow-x-auto"
      data-testid="sql-editor-tabs"
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId;
        const editing = editingId === tab.id;
        const isDragging = dragFrom === index;
        const isOver = dragOver === index && dragFrom !== null && dragFrom !== index;
        const closeDisabled = onlyTabEmpty;
        const closeTitle = onlyTab
          ? onlyTabEmpty
            ? 'Last empty query — add another tab first'
            : 'Clear this query (editor always keeps one tab)'
          : `Close ${tab.title}`;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            draggable={!editing}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onSelect(tab.id);
            }}
            onDoubleClick={() => startEdit(tab)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                if (!closeDisabled) onClose(tab.id);
              }
            }}
            onDragStart={(e) => {
              if (editing) {
                e.preventDefault();
                return;
              }
              const target = e.target as HTMLElement | null;
              if (target?.closest('button, input')) {
                e.preventDefault();
                return;
              }
              setDragFrom(index);
              suppressClickRef.current = false;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(index));
              if (e.currentTarget instanceof HTMLElement) {
                e.dataTransfer.setDragImage(e.currentTarget, 12, 12);
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragOver !== index) setDragOver(index);
            }}
            onDragLeave={() => {
              if (dragOver === index) setDragOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from =
                dragFrom ?? Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
              if (Number.isFinite(from) && from !== index) {
                onMove(from, index);
                suppressClickRef.current = true;
              }
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) {
                suppressClickRef.current = true;
              }
              setDragFrom(null);
              setDragOver(null);
            }}
            title="Drag to reorder · Double-click or use pencil to rename"
            className={`group flex items-center gap-1 pl-1.5 pr-2 py-1.5 text-[11px] font-semibold border-r border-slate-800/80 cursor-grab active:cursor-grabbing shrink-0 max-w-[12rem] select-none ${
              active
                ? 'bg-slate-900 text-slate-100 border-b-2 border-b-cyan-500 -mb-px'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/40'
            } ${isDragging ? 'opacity-50' : ''} ${
              isOver ? 'bg-slate-800/80 ring-2 ring-inset ring-cyan-500/50' : ''
            }`}
          >
            <button
              type="button"
              draggable={false}
              aria-label={closeTitle}
              title={closeTitle}
              data-testid={`sql-tab-close-${tab.id}`}
              disabled={closeDisabled}
              onMouseDown={blockDragFromControl}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (!closeDisabled) onClose(tab.id);
              }}
              className={`p-0.5 rounded transition shrink-0 ${
                closeDisabled
                  ? 'text-slate-600 opacity-40 cursor-not-allowed'
                  : active
                    ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                    : 'opacity-0 group-hover:opacity-100 text-slate-600 hover:text-slate-300'
              }`}
            >
              <X className="w-3 h-3 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
            </button>
            {editing ? (
              <input
                ref={inputRef}
                data-testid="sql-tab-rename"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="bg-slate-950 border border-cyan-600/50 rounded px-1 py-0 text-[11px] outline-none w-28 text-slate-100 cursor-text"
              />
            ) : (
              <>
                <span className="truncate min-w-0" title={tab.title}>
                  {tab.title}
                </span>
                <button
                  type="button"
                  draggable={false}
                  data-testid={`sql-tab-rename-btn-${tab.id}`}
                  aria-label={`Rename ${tab.title}`}
                  title="Rename query"
                  onMouseDown={blockDragFromControl}
                  onClick={(e) => startEdit(tab, e)}
                  className={`p-0.5 rounded transition shrink-0 ${
                    active
                      ? 'text-slate-500 hover:text-cyan-400 hover:bg-slate-800'
                      : 'opacity-0 group-hover:opacity-100 text-slate-600 hover:text-slate-300'
                  }`}
                >
                  <Pencil className="w-3 h-3 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                </button>
              </>
            )}
          </div>
        );
      })}
      <button
        type="button"
        data-testid="sql-tab-add"
        onClick={onAdd}
        title="New tab"
        aria-label="New tab"
        className="px-2 text-slate-500 hover:text-slate-200 hover:bg-slate-900/40 transition shrink-0"
      >
        <Plus className="w-3.5 h-3.5 text-emerald-400" strokeWidth={SQL_ICON_STROKE} />
      </button>
    </div>
  );
};
