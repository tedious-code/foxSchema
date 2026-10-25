import type { TableSchema } from '@/shared/lib/types';
import type { SqlVariable } from '@/shared/lib/sql-variables';

/** One connection's cached tables for autocomplete / explorer. */
export interface SchemaCacheEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tables?: TableSchema[];
  error?: string;
  /** Object types requested for this cache entry (re-fetch when scope changes). */
  scope?: string[];
  /** Wall-clock ms when this entry became ready (TTL / LRU). */
  loadedAt?: number;
}

export interface CompletionSchemaSource {
  connectionId: string;
  tables: TableSchema[];
  /**
   * The schema these tables came from.
   *
   * `/schema/load` takes one schema per connection, so the tables here are that
   * schema's and their names are bare. Without the name, nothing downstream
   * could tell that `demo_a.` refers to the very tables it already holds.
   */
  schema?: string;
}

export interface CompletionContext {
  sql: string;
  /** Schemas for checked credentials that have been loaded. */
  schemas: CompletionSchemaSource[];
  /** Global SQL Editor variables for `${{` autocomplete. */
  variables: SqlVariable[];
}

type ContextGetter = () => CompletionContext;
type InsertHandler = (text: string) => void;

let contextGetter: ContextGetter = () => ({ sql: '', schemas: [], variables: [] });
let insertHandler: InsertHandler | null = null;

/** Wired once from SqlEditorView so the completion provider stays leak-free. */
export function setCompletionContextGetter(fn: ContextGetter): void {
  contextGetter = fn;
}

export function getCompletionContext(): CompletionContext {
  return contextGetter();
}

/** Wired from SqlEditorPane onMount / disposed on unmount. */
export function setSqlInsertHandler(fn: InsertHandler | null): void {
  insertHandler = fn;
}

let fallbackInsert: InsertHandler | null = null;

/**
 * Where inserted SQL goes when no editor pane is mounted.
 *
 * Wired once from the store. The bridge must not import the store — the
 * dependency runs the other way — so the store hands its writer in here.
 */
export function setSqlInsertFallback(fn: InsertHandler | null): void {
  fallbackInsert = fn;
}

/**
 * Put text into the editor, and say whether anywhere took it.
 *
 * The pane clears its handler on unmount, so every caller reachable from
 * another workspace — Clone Table and the table blueprint both live in
 * Utilities — used to drop its SQL on the floor while the modal reported
 * "inserted into the editor". Falling back to the active tab's buffer means
 * the text survives the trip and is there when the view switches.
 */
export function insertAtCursor(text: string): boolean {
  const target = insertHandler ?? fallbackInsert;
  target?.(text);
  return target !== null;
}

type SqlMutator = (fn: (sql: string) => string) => void;
let sqlMutator: SqlMutator | null = null;

/** Wired from SqlEditorView — mutate active tab SQL (SELECT column inject). */
export function setSqlMutator(fn: SqlMutator | null): void {
  sqlMutator = fn;
}

export function mutateSql(fn: (sql: string) => string): boolean {
  if (!sqlMutator) return false;
  sqlMutator(fn);
  return true;
}

type SelectionGetter = () => string | null;
let selectionGetter: SelectionGetter = () => null;

/** Wired from SqlEditorPane — non-empty Monaco selection text, else null. */
export function setSqlSelectionGetter(fn: SelectionGetter | null): void {
  selectionGetter = fn ?? (() => null);
}

/** Current editor selection used by Run (selection overrides the rail's run checks). */
export function getSelectedSql(): string | null {
  return selectionGetter();
}

type CaretGetter = () => number | null;
let caretGetter: CaretGetter = () => null;

/** Wired from SqlEditorPane — character offset of the caret in the model. */
export function setSqlCaretOffsetGetter(fn: CaretGetter | null): void {
  caretGetter = fn ?? (() => null);
}

/**
 * Where the caret sits, so Run can default to the statement the user is
 * actually looking at. Without this the default was "statement 1", and an
 * editor holding a page of queries would silently re-run the top one when the
 * user pressed Run on their UPDATE further down.
 */
export function getCaretOffset(): number | null {
  return caretGetter();
}

/** CALL / function invocation args — skip RESULT / RETURN metadata. */
export function isCallParamMode(mode: string): boolean {
  return mode === 'IN' || mode === 'OUT' || mode === 'INOUT';
}

export function filterCallParameters<T extends { mode: string }>(params: T[]): T[] {
  return params.filter((p) => isCallParamMode(p.mode));
}
