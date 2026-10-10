/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How large a file this process can actually import, measured rather than
 * guessed, plus the numbers to explain the answer to a user.
 *
 * There are two independent ceilings, and a fixed constant can only ever be
 * right about one of them on one machine:
 *
 *  1. V8 caps a single string at ~512 MiB. The buffered import path reads the
 *     whole upload with readFileSync(path, 'utf8'), so a file past that cannot
 *     be read at all — it throws before any parsing starts.
 *  2. Parsing costs roughly ten times the file size in heap: the row matrix
 *     holds one JS string per cell, each with its own object header, where the
 *     file held bytes. Observed ratios for CSV at 3.7 / 11.1 / 22.2 MB were
 *     9.6x, 10.9x and 8.4x.
 *
 * Which one binds depends on the host. A 512 MB container hits (2) at ~25 MB;
 * a 16 GB workstation hits (1) first. Reading the live heap means both get an
 * honest answer, and the warning can name the real number instead of a
 * hardcoded one that is wrong in both directions.
 */
import { constants as bufferConstants } from 'node:buffer';
import { getHeapStatistics } from 'node:v8';

/**
 * Heap bytes consumed per byte of source file, once parsed into the row matrix.
 * Measured; see the module comment. Rounded up, because being wrong here means
 * an OOM kill rather than a friendly error.
 */
export const PARSE_HEAP_FACTOR = 11;

/**
 * Share of remaining heap a single import may plan to use.
 *
 * Not 1.0: the process still has to serve other requests, hold connection
 * pools, and build the INSERT batches while the matrix is resident. Half
 * leaves room for one more import of the same size plus normal traffic.
 */
export const HEAP_BUDGET_SHARE = 0.5;

/** Never advertise less than this, or a small container rejects everything. */
const FLOOR_BYTES = 8 * 1024 * 1024;

/**
 * Never advertise more than this for the buffered path, whatever the heap
 * says: V8 will not create the string. Leaves a margin under the exact cap for
 * multi-byte characters, which cost more string units than file bytes.
 */
const MAX_STRING_BYTES = Math.floor(bufferConstants.MAX_STRING_LENGTH * 0.9);

export interface ImportCapacity {
  /** Largest file this process should accept for a buffered import. */
  maxBytes: number;
  /** Which ceiling produced maxBytes — worth telling the user. */
  limitedBy: 'heap' | 'string-length' | 'floor';
  /** v8 heap_size_limit, for the explanation. */
  heapLimitBytes: number;
  /** Heap not currently in use. */
  heapAvailableBytes: number;
}

export function importCapacity(): ImportCapacity {
  const stats = getHeapStatistics();
  const heapLimitBytes = stats.heap_size_limit;
  const heapAvailableBytes = Math.max(0, heapLimitBytes - stats.used_heap_size);

  const fromHeap = Math.floor((heapAvailableBytes * HEAP_BUDGET_SHARE) / PARSE_HEAP_FACTOR);

  let maxBytes = fromHeap;
  let limitedBy: ImportCapacity['limitedBy'] = 'heap';
  if (maxBytes > MAX_STRING_BYTES) {
    maxBytes = MAX_STRING_BYTES;
    limitedBy = 'string-length';
  }
  if (maxBytes < FLOOR_BYTES) {
    maxBytes = FLOOR_BYTES;
    limitedBy = 'floor';
  }
  return { maxBytes, limitedBy, heapLimitBytes, heapAvailableBytes };
}

const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * One sentence a user can act on. Says what the limit is *and* why, because
 * "file too large" without a number is the least useful error there is.
 */
export function capacityMessage(cap: ImportCapacity = importCapacity()): string {
  const head = `This server can import files up to about ${mb(cap.maxBytes)}`;
  switch (cap.limitedBy) {
    case 'string-length':
      return `${head} — the ceiling is Node's ~512 MB limit on a single string, not this machine's memory.`;
    case 'floor':
      return `${head}, the minimum this build accepts. Memory is tight (heap limit ${mb(
        cap.heapLimitBytes
      )}), so an import near this size may still fail — give the server more memory to raise it.`;
    default:
      return `${head}, from ${mb(cap.heapAvailableBytes)} of free heap and the ~${PARSE_HEAP_FACTOR}x expansion parsing costs. Restarting the server, or giving it more memory, raises this.`;
  }
}
