/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** A new pipe's id: its type's last segment and a random suffix (the designer draws again on a clash). */
export function generatePipeId(type: string): string {
  const short = type.split('.').pop() ?? 'pipe';
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${short}_${randomPart}`;
}

/**
 * A default name no other pipe in the stage has: the catalog label, then
 * "label 2", "label 3", … — the id is random, so the name is what tells two
 * pipes of one type apart on the canvas.
 */
export function nextPipeName(label: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(label)) return label;
  let n = 2;
  while (used.has(`${label} ${n}`)) n += 1;
  return `${label} ${n}`;
}
