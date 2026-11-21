import fs from 'node:fs';
import path from 'node:path';
import { driverRequire as nodeRequire } from '@foxschema/db';

// ibm_db resolves from @foxschema/db's require site, not this package's: the
// app and CLI install drivers into @foxschema/db, and a sibling package's
// node_modules is not searched from here.

let configured = false;

/**
 * Point the process at ibm_db's bundled clidriver before loading native bindings.
 * Helps avoid SQL1042C caused by missing/wrong CLI library paths.
 *
 * On Windows, IBM GSKit (`…\IBM\gsk8\…`) on PATH is a known conflict with
 * ibm_db's bundled CLI — strip those entries when we install our clidriver PATH.
 */
export function setupDb2ClientEnv(): void {
  if (configured) return;

  try {
    const pkgPath = nodeRequire.resolve('ibm_db/package.json');
    const clidriverDir = path.join(path.dirname(pkgPath), 'installer', 'clidriver');
    const libDir = path.join(clidriverDir, 'lib');
    const binDir = path.join(clidriverDir, 'bin');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from require.resolve('ibm_db/package.json') — a resolved node_modules location, never caller input
    if (!fs.existsSync(clidriverDir)) {
      // Leave configured=false so a later successful `npm install ibm_db
      // --foreground-scripts` can retry setup on the next connect.
      return;
    }

    process.env.IBM_DB_HOME = clidriverDir;

    if (process.platform === 'darwin') {
      process.env.DYLD_LIBRARY_PATH = prependPath(process.env.DYLD_LIBRARY_PATH, libDir);
      process.env.PATH = prependPath(process.env.PATH, binDir);
    } else if (process.platform === 'linux') {
      process.env.LD_LIBRARY_PATH = prependPath(process.env.LD_LIBRARY_PATH, libDir);
      process.env.PATH = prependPath(process.env.PATH, binDir);
    } else if (process.platform === 'win32') {
      process.env.PATH = prependPath(stripIbmGskPath(process.env.PATH), binDir, libDir);
      process.env.LIB = prependPath(process.env.LIB, libDir, binDir);
    }

    configured = true;
  } catch {
    // ibm_db not installed yet
  }
}

/** True when ibm_db's installer/clidriver directory is present on disk. */
export function hasDb2Clidriver(): boolean {
  try {
    const pkgPath = nodeRequire.resolve('ibm_db/package.json');
    const clidriverDir = path.join(path.dirname(pkgPath), 'installer', 'clidriver');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from require.resolve('ibm_db/package.json') — a resolved node_modules location, never caller input
    return fs.existsSync(clidriverDir);
  } catch {
    return false;
  }
}

/** Exported for tests — remove IBM GSKit dirs that conflict with bundled CLI. */
export function stripIbmGskPath(current: string | undefined): string | undefined {
  if (!current) return current;
  const kept = current
    .split(path.delimiter)
    .filter((p) => p && !/IBM[/\\]gsk8/i.test(p));
  return kept.join(path.delimiter);
}

function prependPath(current: string | undefined, ...dirs: string[]): string {
  const existing = current?.split(path.delimiter).filter(Boolean) ?? [];
  const merged = [...dirs, ...existing.filter((d) => !dirs.includes(d))];
  return merged.join(path.delimiter);
}
