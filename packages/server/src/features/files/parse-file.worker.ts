/**
 * worker_threads entry for parsing an uploaded table.
 *
 * Runs off the event loop because the parse is genuinely blocking: a 22MB CSV
 * measured 784ms with zero loop ticks on the main thread, and imports are
 * routinely larger than that. Everything here is pure CPU — no database, no
 * network — which is exactly the shape worth moving.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parseFileToTable, type FileQueryImportInput } from './file-query.service';
import { errorMessage } from '@foxschema/sql';

interface ParseJob {
  input: FileQueryImportInput;
  maxChars: number;
}

try {
  const { input, maxChars } = workerData as ParseJob;
  parentPort?.postMessage({ type: 'progress', percent: 10, note: 'parsing' });
  const table = parseFileToTable(input, { maxChars });
  parentPort?.postMessage({ type: 'done', result: table });
} catch (error) {
  parentPort?.postMessage({
    type: 'error',
    error: errorMessage(error),
  });
}
