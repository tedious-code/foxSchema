import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { friendlyError } from '../format/friendlyError';
import { IBM_DB_VERSION } from '@foxschema/sql';

const require = createRequire(import.meta.url);

const DRIVER_PACKAGES: Record<string, { pkg: string; pin?: string; notes: string }> = {
  db2: {
    pkg: 'ibm_db',
    pin: IBM_DB_VERSION,
    notes:
      'Large CLI driver + native build. Needs --foreground-scripts (clidriver download). Not available on linux/arm64. Docker image 5nickels/foxschema:latest includes Db2 (linux/amd64).',
  },
  oracle: {
    pkg: 'oracledb',
    notes: 'Thin mode works without Instant Client; thick mode needs Oracle Instant Client installed.',
  },
};

function webWorkspaceRoot(): string {
  try {
    return dirname(require.resolve('@foxschema/web/package.json'));
  } catch {
    throw new Error('Could not locate @foxschema/web — are you in a Fox Schema install?');
  }
}

function monorepoRootFromWeb(webRoot: string): string | null {
  const candidate = join(webRoot, '..', '..');
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    if (pkg.workspaces && existsSync(join(candidate, 'apps/web/package.json'))) return candidate;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Can Node load this driver right now?
 *
 * ibm_db's native bindings need the bundled clidriver on PATH/LD_LIBRARY_PATH
 * before load — the same setup DriverDetector and the DB2 adapter run. Without
 * it a fully successful `drivers install db2` still printed "Node cannot
 * resolve ibm_db" on Windows and macOS.
 */
async function driverLoads(pkg: string): Promise<boolean> {
  try {
    if (pkg === 'ibm_db') {
      const { setupDb2ClientEnv } = await import('@foxschema/db');
      setupDb2ClientEnv();
    }
    require(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report which optional/native drivers actually load.
 *
 * Goes through DriverDetector rather than a local `require`, so this agrees
 * with what the app itself sees — and so ibm_db gets its client env set before
 * load. Without that a good Db2 install reports "missing" on Windows/macOS.
 * Resolving alone is not enough: the failure this whole command exists to
 * surface is a package that resolves but cannot load (clidriver never
 * downloaded), so it is loaded on purpose.
 */
export async function runDriversList(): Promise<void> {
  console.log(chalk.bold('Fox Schema — database drivers'));
  const { DriverDetector } = await import('@foxschema/db');
  const defaults = [
    ['postgres', 'postgres'],
    ['mysql/mariadb', 'mysql'],
    ['sqlserver', 'sqlserver'],
    ['sqlite (user DBs)', 'sqlite'],
    ['clickhouse', 'clickhouse'],
    ['duckdb', 'duckdb'],
    ['mongodb', 'mongodb'],
    ['redis', 'redis'],
    ['oracle', 'oracle'],
    ['db2', 'db2'],
  ] as const;

  for (const [label, dialect] of defaults) {
    const info = DriverDetector.checkDialect(dialect);
    const mark = info.installed ? chalk.green('installed') : chalk.yellow('missing');
    console.log(`  ${label.padEnd(22)} ${mark}  ${chalk.dim(info.packageName)}`);
  }
  console.log();
  console.log(chalk.dim('Install opt-in drivers:  foxschema drivers install db2|oracle'));
  console.log(chalk.dim('Docker (includes Db2):   docker pull 5nickels/foxschema:latest'));
}

/**
 * Install an opt-in driver into the web workspace (or global package tree).
 * DB2 is intentionally not a default dependency.
 */
export async function runDriversInstall(name: string): Promise<void> {
  const key = name.trim().toLowerCase();
  const entry = DRIVER_PACKAGES[key];
  if (!entry) {
    throw new Error(
      `Unknown driver "${name}". Supported opt-in installs: ${Object.keys(DRIVER_PACKAGES).join(', ')}`
    );
  }

  if (await driverLoads(entry.pkg)) {
    console.log(chalk.green(`${entry.pkg} is already installed.`));
    console.log(chalk.dim(entry.notes));
    return;
  }

  console.log(chalk.bold(`Installing ${entry.pkg}…`));
  console.log(chalk.dim(entry.notes));

  const webRoot = webWorkspaceRoot();
  const mono = monorepoRootFromWeb(webRoot);
  const spec = entry.pin ? `${entry.pkg}@${entry.pin}` : entry.pkg;

  // Drivers are required from @foxschema/db; installing into @foxschema/web
  // leaves packages/db unable to resolve the module.
  const workspacePkg = '@foxschema/db';
  const prefixRoot = (() => {
    try {
      return dirname(require.resolve('@foxschema/db/package.json'));
    } catch {
      return webRoot;
    }
  })();

  const cwd = mono ?? prefixRoot;
  const version = entry.pin ?? 'latest';

  // Prefer workspace install in a checkout; otherwise --prefix into the package tree.
  // ibm_db must run install scripts or clidriver never downloads.
  // Writing onto dependencies first: `npm install <peer> -w @foxschema/db` is a
  // no-op when the package is already an optional peer.
  if (mono) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['pkg', 'set', `dependencies.${entry.pkg}=${version}`, '-w', workspacePkg], {
        cwd: mono,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm pkg set exited ${code}`))));
    });
  }
  const npmArgs = mono
    ? ['install', '--foreground-scripts', '-w', workspacePkg]
    : ['install', spec, '--save', '--foreground-scripts', '--prefix', prefixRoot];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', npmArgs, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        // Must be the string 'false', not '': npm treats an empty env value as
        // unset, so '' leaves an ignore-scripts=true from a user or CI .npmrc
        // in force and ibm_db's clidriver never downloads. Verified on npm
        // 11.6.2 — '' skips the postinstall, 'false' runs it.
        npm_config_ignore_scripts: 'false',
        npm_config_foreground_scripts: 'true',
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install ${entry.pkg} failed (exit ${code})`));
    });
  });

  if (!(await driverLoads(entry.pkg))) {
    console.log(
      chalk.yellow(
        `Install finished but Node cannot resolve ${entry.pkg} from this process yet. ` +
          'Restart your shell / reopen Fox Schema (`foxschema stop && foxschema`), then run `foxschema doctor`.\n' +
          'If it still fails: ensure install scripts ran (unset npm ignore-scripts), Xcode CLT on macOS, ' +
          'and use Docker linux/amd64 when on linux/arm64.'
      )
    );
  } else {
    console.log(chalk.green.bold(`✔ ${entry.pkg} installed.`));
    if (entry.pkg === 'ibm_db') {
      console.log(chalk.dim('Restart Fox Schema if the UI still shows the driver as missing.'));
    }
  }
}

export async function runDrivers(subcommand: string, name?: string): Promise<void> {
  try {
    if (subcommand === 'list' || subcommand === 'ls') {
      await runDriversList();
      return;
    }
    if (subcommand === 'install' || subcommand === 'add') {
      if (!name) throw new Error('Usage: foxschema drivers install <db2|oracle>');
      await runDriversInstall(name);
      return;
    }
    throw new Error(`Unknown drivers subcommand "${subcommand}". Use list|install.`);
  } catch (e) {
    throw new Error(friendlyError(e));
  }
}
