/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared setup for the designer's small JSON editors.
 */
import type { EditorProps } from '@monaco-editor/react';
import { useUiStore } from '@/app/store/uiStore';
// Also what makes Monaco load from the bundle rather than its default CDN, when
// the Workflow screen is the first to open an editor.
import { MONACO_THEME, MONACO_THEME_LIGHT } from '@/features/sql-editor/monaco';

/** FoxSchema's editor theme for the app's current light or dark mode. */
export function useJsonEditorTheme(): string {
  return useUiStore((s) => s.resolvedMode) === 'light' ? MONACO_THEME_LIGHT : MONACO_THEME;
}

/** Options every small JSON editor in the designer shares. */
export const JSON_EDITOR_OPTIONS: EditorProps['options'] = {
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbers: 'off',
  folding: false,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
};
