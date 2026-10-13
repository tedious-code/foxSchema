/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compile-time ties between the designer's local copies and the engine.
 *
 * Value lists (column types, credential kinds, …) stay local because importing
 * them would pull the engine's zod into the bundle. Types come over type-only
 * and cost nothing. These checks fail the build when a copy drifts — the
 * failure the copies had already had: a token refresh's `headers` and `body`
 * unknown to the editor, so every edit dropped them.
 */

/** `true` when two unions have the same members; otherwise a message naming the side missing one. */
export type SameMembers<Designer, Engine> = [Designer] extends [Engine]
  ? [Engine] extends [Designer]
    ? true
    : ['the engine has a value the designer list is missing']
  : ['the designer list has a value the engine rejects'];

/**
 * `true` when the designer's shape knows every field of the engine's; otherwise
 * the fields it would drop on re-serialising.
 */
export type KnowsEveryField<Designer, Engine> = Exclude<keyof Engine, keyof Designer> extends never
  ? true
  : ['the designer shape would drop these engine fields', Exclude<keyof Engine, keyof Designer>];
