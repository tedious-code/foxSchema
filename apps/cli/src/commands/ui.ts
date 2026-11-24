/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Manage signed UI bundles served from Cloudflare CDN (`foxschema ui ...`).
 */
import chalk from 'chalk';
import {
  checkAndUpdateUiBundle,
  isUiUpdatesEnabled,
  readUiServiceStatus,
  resetUiBundles,
  resolveUiBundlesDir,
  resolveUiFeedUrl,
  resolveUiPublicKeys,
} from '@foxschema/server';
import { readCliPackageVersion } from '../runtime/packageVersion';
import { resolveStaticDir } from '../runtime/resolvePaths';

export type UiAction = 'status' | 'check' | 'apply' | 'reset';

function safeStaticDir(): string | undefined {
  try {
    return resolveStaticDir();
  } catch {
    return undefined;
  }
}

export async function runUiCommand(action: UiAction, opts: { json?: boolean } = {}): Promise<void> {
  const rootDir = resolveUiBundlesDir();
  const packagedVersion = readCliPackageVersion();
  const packagedDir = safeStaticDir();

  if (action === 'status') {
    const status = readUiServiceStatus({ packagedVersion, packagedDir, rootDir });
    const pinnedCount = resolveUiPublicKeys().length;
    if (opts.json) {
      console.log(JSON.stringify({ ...status, bundleDir: rootDir, pinnedKeys: pinnedCount }, null, 2));
      return;
    }
    console.log(chalk.bold('Fox Schema — Web UI bundle'));
    console.log(`  active source   ${status.source === 'cdn' ? chalk.cyan('Cloudflare CDN') : chalk.dim('Packaged')}`);
    console.log(`  version         ${status.version}`);
    console.log(`  api contract    v${status.apiContract}`);
    console.log(`  updates         ${status.updatesEnabled ? chalk.green('enabled') : chalk.yellow('off (FOX_UI_UPDATES=off)')}`);
    console.log(`  feed url        ${status.feedUrl ?? chalk.dim('(disabled)')}`);
    console.log(`  pinned keys     ${pinnedCount > 0 ? chalk.green(String(pinnedCount)) : chalk.yellow('0 (set FOX_UI_PUBLIC_KEYS or UI_BUNDLE_PUBLIC_KEYS)')}`);
    console.log(`  cache dir       ${rootDir}`);
    if (status.lastCheckedAt) console.log(`  last checked    ${status.lastCheckedAt}`);
    if (status.pendingVersion) console.log(`  staged update   ${chalk.cyan(status.pendingVersion)}`);
    if (status.lastError) console.log(`  last error      ${chalk.red(status.lastError)}`);
    return;
  }

  if (action === 'reset') {
    const res = resetUiBundles(rootDir);
    console.log(
      res.cleared
        ? chalk.green('Cleared downloaded CDN UI bundles. Next server start uses the packaged UI.')
        : chalk.dim('No downloaded CDN UI bundles were present.')
    );
    return;
  }

  if (!isUiUpdatesEnabled()) {
    console.log(chalk.yellow('UI updates are disabled (FOX_UI_UPDATES=off).'));
    return;
  }
  const pinnedKeys = resolveUiPublicKeys();
  if (pinnedKeys.length === 0) {
    console.log(
      chalk.yellow(
        `No UI signing public keys pinned yet (feed: ${resolveUiFeedUrl()}). Set UI_BUNDLE_PUBLIC_KEYS or FOX_UI_PUBLIC_KEYS.`
      )
    );
    return;
  }

  const apply = action === 'apply';
  const result = await checkAndUpdateUiBundle({
    rootDir,
    packagedDir,
    packagedVersion,
    apply,
  });

  if (result.status === 'disabled' || result.status === 'no_pinned_keys') {
    console.log(chalk.yellow(`Skipped (${result.status}).`));
  } else if (result.status === 'no_compatible_release') {
    console.log(chalk.dim('No compatible UI release published for this API contract yet.'));
  } else if (result.status === 'up_to_date') {
    console.log(chalk.green(`Web UI is up to date (${result.currentVersion}).`));
  } else if (result.status === 'update_available') {
    console.log(
      chalk.cyan(`Update available: ${result.latestVersion} (current: ${result.currentVersion}, seq ${result.sequence}).`)
    );
    console.log(chalk.dim('Run `foxschema ui apply` to download and stage it.'));
  } else if (result.status === 'applied') {
    console.log(chalk.green(`Staged signed UI bundle ${result.version} (seq ${result.sequence}) at ${result.releaseDir}.`));
    console.log(chalk.dim('Restart the UI server (`foxschema stop && foxschema open`) to serve the new bundle.'));
  }
}
