import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  MONACO_THEME,
  MONACO_THEME_LIGHT,
  monacoLanguage,
  FOXSCRIPT_LANG,
  MONACO_EDITOR_BASE_OPTIONS,
} from '@/features/sql-editor/lib/monacoSetup';
import { ensureFoxschemaSqlLanguage } from '@/features/sql-editor/lib/foxschemaSqlLanguage';
import {
  disposeFoxscriptVirtualDocs,
  ensureFoxscriptVirtualProviders,
  syncFoxscriptVirtualDocs,
} from '@/features/sql-editor/lib/foxscriptVirtualDocs';
import {
  ensureFoxscriptSemanticTokens,
  refreshFoxscriptSemanticTokens,
} from '@/features/sql-editor/lib/foxscriptSemanticTokens';
import { MONACO_FONT_PX, useUiStore } from '@/platform/uiStore';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import {
  parseFoxScript,
  type SplitStatement,
} from '@/shared/lib/sql-splitter';
import { ensureSqlCompletions, shouldOpenClauseSuggest } from '../lib/completion';
import { disarmPasswordAutofill } from '../lib/passwordAutofill';
import { applyFoxscriptMarkers, clearFoxscriptMarkers } from '../lib/foxscriptDiagnostics';
import {
  setSqlCaretOffsetGetter,
  setSqlInsertHandler,
  setSqlSelectionGetter,
} from '../lib/sqlEditorBridge';
import { buildVariableHoverDecorations } from '../lib/variableHover';
import { isSelectOrFromKeyword } from '@/features/sql-editor/lib/selectClauseEdit';
import {
  SelectColumnPicker,
  type SelectColumnPickerAnchor,
} from './SelectColumnPicker';
import { StatementRunGutter } from './StatementRunGutter';
import { statementSelectionRange } from '../lib/statementSelection';
import { statementCopyText } from '../lib/statementBadges';

interface Props {
  value: string;
  statements: SplitStatement[];
  /** Statement indexes included in toolbar Run. */
  checkedStatements?: number[];
  onToggleStatement?: (index: number) => void;
  /** Per-cell play, same pipeline as toolbar Run. */
  onRunCell?: (index: number) => void;
  cellRunning?: boolean;
  sqlNeedsDestination?: boolean;
  dialect: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter shortcut → run. */
  onRun?: () => void;
  /** Fired when Monaco selection becomes empty / non-empty (for Run label). */
  onSelectionChange?: (hasSelection: boolean) => void;
  /** Caret moved — offset in the model, so Run can label the right statement. */
  onCaretChange?: (offset: number | null) => void;
}

/**
 * Editable Monaco pane for the SQL Editor. Notebook-style cell banding spans
 * each statement's line range; the glyph margin shows ✓ / ⚠ on the first line.
 * The run rail on the left numbers each statement In [n], with its play button,
 * include checkbox and a copy-with-values button; clicking the number selects
 * the statement.
 * Model language is FoxScript (`foxscript`) once Monarch + packs load.
 */
export const SqlEditorPane: React.FC<Props> = ({
  value,
  statements,
  checkedStatements = [],
  onToggleStatement,
  onRunCell,
  cellRunning = false,
  sqlNeedsDestination = false,
  dialect,
  onChange,
  onRun,
  onSelectionChange,
  onCaretChange,
}) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decoRef = useRef<any>(null);
  const varDecoRef = useRef<any>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onCaretChangeRef = useRef(onCaretChange);
  onCaretChangeRef.current = onCaretChange;
  const monacoTheme = useUiStore((s) => s.resolvedMode) === 'light' ? MONACO_THEME_LIGHT : MONACO_THEME;
  const fontSizePref = useUiStore((s) => s.fontSize);
  const monacoFontSize = MONACO_FONT_PX[fontSizePref] ?? MONACO_FONT_PX.md;
  const variables = useSqlEditorStore((s) => s.variables);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const [editorLanguage, setEditorLanguage] = useState(() => monacoLanguage(dialect));
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [columnPickerAnchor, setColumnPickerAnchor] = useState<SelectColumnPickerAnchor | null>(
    null
  );
  const [editorEpoch, setEditorEpoch] = useState(0);
  const editorOptions = useMemo(
    () => ({
      ...MONACO_EDITOR_BASE_OPTIONS,
      renderLineHighlight: 'line' as const,
      fontSize: monacoFontSize,
      glyphMargin: true,
      tabSize: 2,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      'semanticHighlighting.enabled': true,
    }),
    [monacoFontSize]
  );

  // Keep a live editor in sync when the appearance font size changes.
  useEffect(() => {
    editorRef.current?.updateOptions?.({ fontSize: monacoFontSize });
  }, [monacoFontSize]);

  const decorate = (text: string) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor) return;

    // One FoxScript parse drives glyphs, markers, and virtual docs.
    const fox = parseFoxScript(text);

    decoRef.current?.clear?.();
    if (!fox.blocks.length) {
      decoRef.current = null;
    } else {
      const decorations: object[] = [];
      for (const block of fox.blocks) {
        const status = block.status;
        const ok = status.level === 'ok';
        const isCode = block.type === 'code';
        decorations.push({
          range: {
            startLineNumber: block.range.startLine,
            startColumn: 1,
            endLineNumber: block.range.startLine,
            endColumn: 1,
          },
          options: {
            glyphMarginClassName: ok ? 'fox-stmt-glyph-ok' : 'fox-stmt-glyph-warn',
            glyphMarginHoverMessage: {
              value: ok
                ? isCode
                  ? 'Code cell looks complete — use the ▶ on the left to run this cell'
                  : 'Statement looks complete — use the ▶ on the left to run this cell'
                : status.reasons.join(' · '),
            },
            stickiness: 1,
          },
        });
        decorations.push({
          range: {
            startLineNumber: block.range.startLine,
            startColumn: 1,
            endLineNumber: block.range.endLine,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: isCode ? 'fox-cell-band-code' : 'fox-cell-band-sql',
            linesDecorationsClassName: isCode ? 'fox-cell-edge-code' : 'fox-cell-edge-sql',
            stickiness: 1,
          },
        });
      }
      decoRef.current = editor.createDecorationsCollection(decorations);
    }

    varDecoRef.current?.clear?.();
    if (monaco) {
      const vars = useSqlEditorStore.getState().variables;
      const varDecos = buildVariableHoverDecorations(monaco, text, vars);
      varDecoRef.current =
        varDecos.length > 0 ? editor.createDecorationsCollection(varDecos) : null;
    }

    const model = editor.getModel?.();
    if (monaco && model) {
      applyFoxscriptMarkers(monaco, model, fox);
      syncFoxscriptVirtualDocs(monaco, model, fox);
    }
  };

  // Re-decorate (debounced) whenever the buffer or variables change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => decorate(value), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, variables]);

  // Schema load → refresh table/column semantic tokens.
  useEffect(() => {
    refreshFoxscriptSemanticTokens();
  }, [schemaCache]);

  /** Select the statement (the rail's In [n] number was clicked). */
  const revealStatement = (stmt: SplitStatement) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const range = statementSelectionRange(stmt, model);
    editor.revealRangeInCenterIfOutsideViewport(range);
    editor.setSelection(range);
    editor.focus();
    onSelectionChangeRef.current?.(true);
  };

  useEffect(() => {
    return () => {
      setSqlInsertHandler(null);
      setSqlSelectionGetter(null);
      setSqlCaretOffsetGetter(null);
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      if (monaco && model) {
        clearFoxscriptMarkers(monaco, model);
        disposeFoxscriptVirtualDocs(model);
      }
    };
  }, []);

  useEffect(() => {
    setEditorLanguage((prev) =>
      prev === FOXSCRIPT_LANG ? prev : monacoLanguage(dialect)
    );
  }, [dialect]);

  return (
    <>
    {/* A form with no password field, so Enter stays in the editor. Without
        it Chrome treats this origin's saved login as belonging to the textarea. */}
    <form
      autoComplete="off"
      className="flex h-full min-h-0 w-full"
      onSubmit={(event) => event.preventDefault()}
    >
    <StatementRunGutter
      statements={statements}
      checked={checkedStatements}
      editorRef={editorRef}
      editorEpoch={editorEpoch}
      running={cellRunning}
      sqlNeedsDestination={sqlNeedsDestination}
      safeMode={safeMode}
      onToggle={(index) => onToggleStatement?.(index)}
      onRunCell={onRunCell}
      onReveal={revealStatement}
      copyTextFor={(stmt) => statementCopyText(stmt.text, variables)}
    />
    <div className="h-full min-w-0 flex-1">
    <Editor
      height="100%"
      theme={monacoTheme}
      language={editorLanguage}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        setEditorEpoch((n) => n + 1);
        const disarm = () => disarmPasswordAutofill(editor.getDomNode?.() ?? null);
        disarm();
        // Monaco writes autocomplete="off" while building the textarea, and
        // Chrome ignores "off" on a site that has a saved login. Stamp again
        // after that write, and whenever the editor is focused.
        requestAnimationFrame(disarm);
        editor.onDidFocusEditorText(disarm);
        ensureSqlCompletions(monaco);
        ensureFoxscriptVirtualProviders(monaco);
        ensureFoxscriptSemanticTokens(monaco, () => useSqlEditorStore.getState().schemaCache);
        // Upgrade to FoxScript (SQL+JS/TS) highlighting after packs load.
        void ensureFoxschemaSqlLanguage(monaco).then((ok) => {
          if (!ok) return;
          setEditorLanguage(FOXSCRIPT_LANG);
          const model = editor.getModel();
          if (model) {
            monaco.editor.setModelLanguage(model, FOXSCRIPT_LANG);
            const fox = parseFoxScript(model.getValue());
            applyFoxscriptMarkers(monaco, model, fox);
            syncFoxscriptVirtualDocs(monaco, model, fox);
          }
        });
        // `onDidType` is on Monaco's ICodeEditor but not in the public
        // editor.api typings, so it is reached through one narrow cast.
        const typing = editor as typeof editor & {
          onDidType?: (listener: (text: string) => void) => void;
        };
        typing.onDidType?.((typed: string) => {
          if (typed !== ' ' && typed !== '=') return;
          const model = editor.getModel?.();
          const pos = editor.getPosition?.();
          if (!model || !pos) return;
          // The clause keyword touching the caret is on the caret's own line,
          // so read that line instead of copying the whole buffer per space.
          const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
          if (!shouldOpenClauseSuggest(before)) return;
          editor.trigger('keyboard', 'editor.action.triggerSuggest', { auto: true });
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current?.());
        // Ctrl/Cmd+S → bookmark current query
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          useSqlEditorStore.getState().saveBookmark();
        });
        // Ctrl/Cmd+Shift+F → format (dispatch toolbar button)
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
          () => {
            document.querySelector<HTMLButtonElement>('[data-testid="sql-format-btn"]')?.click();
          }
        );
        // Ctrl/Cmd+Shift+S → toggle Safe mode
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
          () => {
            const st = useSqlEditorStore.getState();
            st.setSafeMode(!st.safeMode);
          }
        );
        // Ctrl/Cmd+Shift+C → open SELECT column picker at cursor
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC,
          () => {
            const ed = editorRef.current;
            const pos = ed?.getPosition?.();
            if (!ed || !pos) return;
            const coords = ed.getScrolledVisiblePosition(pos);
            const dom = ed.getDomNode?.() as HTMLElement | null;
            const rect = dom?.getBoundingClientRect();
            setColumnPickerAnchor({
              top: (rect?.top ?? 0) + (coords?.top ?? 0) + 20,
              left: (rect?.left ?? 0) + (coords?.left ?? 0),
            });
            setColumnPickerOpen(true);
          }
        );
        editor.onMouseDown((e: { target?: { position?: { lineNumber: number; column: number } | null; element?: HTMLElement | null } }) => {
          const pos = e.target?.position;
          const model = editor.getModel?.();
          if (!pos || !model) return;
          const offset = model.getOffsetAt(pos);
          const sql = model.getValue();
          if (!isSelectOrFromKeyword(sql, offset)) return;
          const dom = editor.getDomNode?.() as HTMLElement | null;
          const rect = dom?.getBoundingClientRect();
          const coords = editor.getScrolledVisiblePosition(pos);
          setColumnPickerAnchor({
            top: (rect?.top ?? 0) + (coords?.top ?? 0) + 18,
            left: (rect?.left ?? 0) + (coords?.left ?? 0),
          });
          setColumnPickerOpen(true);
        });
        setSqlSelectionGetter(() => {
          const ed = editorRef.current;
          const model = ed?.getModel?.();
          const sel = ed?.getSelection?.();
          if (!ed || !model || !sel || sel.isEmpty()) return null;
          const text = model.getValueInRange(sel);
          const trimmed = text.trim();
          return trimmed.length > 0 ? trimmed : null;
        });
        setSqlCaretOffsetGetter(() => {
          const ed = editorRef.current;
          const model = ed?.getModel?.();
          const pos = ed?.getPosition?.();
          if (!model || !pos) return null;
          return model.getOffsetAt(pos);
        });
        editor.onDidChangeCursorSelection(() => {
          const sel = editor.getSelection();
          onSelectionChangeRef.current?.(Boolean(sel && !sel.isEmpty()));
          const model = editor.getModel?.();
          const pos = editor.getPosition?.();
          onCaretChangeRef.current?.(model && pos ? model.getOffsetAt(pos) : null);
        });
        setSqlInsertHandler((text) => {
          const ed = editorRef.current;
          const m = monacoRef.current;
          if (!ed || !m) return;
          const sel = ed.getSelection();
          const pos = ed.getPosition();
          const range =
            sel && !sel.isEmpty()
              ? sel
              : pos
                ? new m.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
                : null;
          if (!range) return;
          ed.executeEdits('schema-insert', [{ range, text, forceMoveMarkers: true }]);
          ed.focus();
        });
        decorate(editor.getValue());
      }}
      options={editorOptions}
    />
    </div>
    </form>
    <SelectColumnPicker
      open={columnPickerOpen}
      anchor={columnPickerAnchor}
      onClose={() => setColumnPickerOpen(false)}
    />
    </>
  );
};

export default SqlEditorPane;
