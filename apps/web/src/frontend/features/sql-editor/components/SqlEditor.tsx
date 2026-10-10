import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { MONACO_THEME, MONACO_THEME_LIGHT, MONACO_DIFF_THEME, MONACO_DIFF_THEME_LIGHT, monacoLanguage, MONACO_EDITOR_BASE_OPTIONS } from '@/features/sql-editor/lib/monacoSetup';
import { MONACO_FONT_PX, useUiStore } from '@/app/store/uiStore';

/**
 * Highlight every (case-insensitive) occurrence of `term` in a Monaco editor,
 * reusing/replacing the previous decorations collection. Mirrors the search
 * highlight in the object browser so a matched keyword is visible in the SQL.
 */
function decorate(editor: any, term: string, prev: any): any {
  prev?.clear?.();
  const model = editor?.getModel?.();
  if (!model || !term.trim()) return null;
  const matches = model.findMatches(term, true, false, false, null, false);
  if (!matches.length) return null;
  return editor.createDecorationsCollection(
    matches.map((m: any) => ({ range: m.range, options: { inlineClassName: 'fox-search-hl' } }))
  );
}

interface SqlViewerProps {
  value: string;
  dialect: string;
  /** When false (default) the editor is read-only. */
  editable?: boolean;
  onChange?: (value: string) => void;
  height?: string | number;
  /** Highlight occurrences of this term (the object-browser search keyword). */
  highlight?: string;
}

/** Single-pane SQL editor/viewer backed by Monaco. */
export const SqlEditor: React.FC<SqlViewerProps> = ({ value, dialect, editable = false, onChange, height = '100%', highlight }) => {
  const editorRef = useRef<any>(null);
  const decoRef = useRef<any>(null);
  const monacoTheme = useUiStore((s) => s.resolvedMode) === 'light' ? MONACO_THEME_LIGHT : MONACO_THEME;
  const fontSizePref = useUiStore((s) => s.fontSize);
  const monacoFontSize = MONACO_FONT_PX[fontSizePref] ?? MONACO_FONT_PX.md;
  const options = useMemo(
    () => ({
      ...MONACO_EDITOR_BASE_OPTIONS,
      renderLineHighlight: 'none' as const,
      fontSize: monacoFontSize,
      readOnly: !editable,
      domReadOnly: !editable,
    }),
    [monacoFontSize, editable]
  );

  const apply = useCallback(() => {
    if (editorRef.current) decoRef.current = decorate(editorRef.current, highlight ?? '', decoRef.current);
  }, [highlight]);

  useEffect(() => {
    apply();
  }, [apply, value]);

  useEffect(() => {
    editorRef.current?.updateOptions?.({ fontSize: monacoFontSize });
  }, [monacoFontSize]);

  return (
    <Editor
      height={height}
      theme={monacoTheme}
      language={monacoLanguage(dialect)}
      value={value}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={(editor) => {
        editorRef.current = editor;
        apply();
      }}
      options={options}
    />
  );
};

interface SqlDiffProps {
  /** Left side (the diff "original"). */
  original: string;
  /** Right side (the diff "modified"). */
  modified: string;
  dialect: string;
  inline?: boolean;
  ignoreCase?: boolean;
  height?: string | number;
  /** Highlight occurrences of this term on both sides of the diff. */
  highlight?: string;
  /** Object status — picks the diff highlight color (green/amber/red). Defaults to MODIFIED (amber). */
  status?: 'ADDED' | 'MODIFIED' | 'REMOVED';
}

/** Side-by-side (or inline) SQL diff backed by Monaco's DiffEditor. */
export const SqlDiffEditor: React.FC<SqlDiffProps> = ({ original, modified, dialect, inline = false, ignoreCase = false, height = '100%', highlight, status = 'MODIFIED' }) => {
  // Monaco's diff is case-sensitive; normalize both sides to collapse case-only differences
  const orig = ignoreCase ? original.toUpperCase() : original;
  const mod = ignoreCase ? modified.toUpperCase() : modified;

  const diffRef = useRef<any>(null);
  const decoModRef = useRef<any>(null);
  const decoOrigRef = useRef<any>(null);
  const isLight = useUiStore((s) => s.resolvedMode) === 'light';
  const monacoTheme = isLight ? MONACO_DIFF_THEME_LIGHT[status] : MONACO_DIFF_THEME[status];
  const fontSizePref = useUiStore((s) => s.fontSize);
  const monacoFontSize = MONACO_FONT_PX[fontSizePref] ?? MONACO_FONT_PX.md;

  const apply = useCallback(() => {
    const diff = diffRef.current;
    if (!diff) return;
    decoModRef.current = decorate(diff.getModifiedEditor(), highlight ?? '', decoModRef.current);
    decoOrigRef.current = decorate(diff.getOriginalEditor(), highlight ?? '', decoOrigRef.current);
  }, [highlight]);

  useEffect(() => {
    apply();
  }, [apply, orig, mod]);

  useEffect(() => {
    const diff = diffRef.current;
    if (!diff) return;
    diff.getModifiedEditor()?.updateOptions?.({ fontSize: monacoFontSize });
    diff.getOriginalEditor()?.updateOptions?.({ fontSize: monacoFontSize });
  }, [monacoFontSize]);

  return (
    <DiffEditor
      height={height}
      theme={monacoTheme}
      language={monacoLanguage(dialect)}
      original={orig}
      modified={mod}
      onMount={(editor) => {
        diffRef.current = editor;
        apply();
      }}
      options={{
        ...MONACO_EDITOR_BASE_OPTIONS,
        renderLineHighlight: 'none' as const,
        fontSize: monacoFontSize,
        readOnly: true,
        renderSideBySide: !inline,
        ignoreTrimWhitespace: false,
        renderOverviewRuler: false,
        diffWordWrap: 'off',
        diffAlgorithm: 'advanced',
      }}
    />
  );
};
