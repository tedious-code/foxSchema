/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Keyboard shortcuts cheat sheet, opened from the top toolbar `?` button
 * or by pressing `?` outside text inputs.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, X } from 'lucide-react';
import { useEscapeKey } from '@/shared/lib/useEscapeKey';

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string[]; description: string }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    items: [
      { keys: ['⌘ / Ctrl', 'K'], description: 'Open command palette (workspaces, connections, recents)' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: ['Esc'], description: 'Close active dialog or popover' },
    ],
  },
  {
    title: 'SQL Editor',
    items: [
      { keys: ['⌘ / Ctrl', 'Enter'], description: 'Run selected SQL or statement under cursor' },
      { keys: ['⌘ / Ctrl', 'Shift', 'F'], description: 'Format SQL and JS/TS code cells' },
      { keys: ['⌘ / Ctrl', 'S'], description: 'Bookmark the active query' },
      { keys: ['⌘ / Ctrl', 'Shift', 'S'], description: 'Toggle Safe Mode (confirm write statements)' },
    ],
  },
  {
    title: 'Workflow Designer',
    items: [
      { keys: ['⌘ / Ctrl', 'S'], description: 'Save current workflow' },
      { keys: ['Shift', 'Drag'], description: 'Box-select multiple pipes on the canvas' },
      { keys: ['Delete / Backspace'], description: 'Remove selected pipes or connections' },
    ],
  },
];

export const KeyboardShortcutsModal: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  useEscapeKey(onClose, open);
  if (!open) return null;

  return createPortal(
    <div
      data-testid="shortcuts-modal"
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-modal-title"
        className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/50 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Keyboard className="h-4 w-4 text-cyan-400" />
            <h2 id="shortcuts-modal-title" className="text-sm font-bold text-slate-100">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            type="button"
            data-testid="shortcuts-close-btn"
            aria-label="Close shortcuts"
            onClick={onClose}
            className="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5 space-y-5">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {group.title}
              </h3>
              <ul className="divide-y divide-slate-800/70 rounded-lg border border-slate-800 bg-slate-950/40">
                {group.items.map((item) => (
                  <li
                    key={item.description}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                  >
                    <span className="text-slate-300">{item.description}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-200"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
};
