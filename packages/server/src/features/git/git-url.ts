/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a repository URL, branch name and folder may be.
 */

/**
 * A remote URL Fox will talk to: `https://` (or `http://` where explicitly
 * allowed, for tests and local development), no credentials in the URL — the
 * token is stored separately and encrypted — and no query or fragment.
 */
export function normalizeRemoteUrl(raw: string, allowInsecureHttp = false): string {
  const trimmed = (raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter the repository’s HTTPS URL, such as https://github.com/acme/db-migrations.git.');
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error('Only https:// repository URLs are supported.');
  }
  if (url.username || url.password) {
    throw new Error('Leave the user name and token out of the URL; enter the token in its own field.');
  }
  if (url.search || url.hash) throw new Error('The repository URL must not have a query or fragment.');
  if (!url.hostname) throw new Error('The repository URL has no host.');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * A branch name Git accepts (`git check-ref-format --branch`), for the names
 * people type. Throws a message fit for the screen.
 */
export function normalizeBranchName(raw: string): string {
  const name = (raw ?? '').trim();
  const problems: Array<[boolean, string]> = [
    [!name, 'Enter a branch name.'],
    [name.length > 200, 'That branch name is too long.'],
    [name.startsWith('-') || name.startsWith('/') || name.endsWith('/'), 'A branch name cannot start with - or start or end with /.'],
    [name.endsWith('.') || name.endsWith('.lock'), 'A branch name cannot end with . or .lock.'],
    [name.includes('..') || name.includes('//') || name.includes('@{'), 'A branch name cannot contain .., // or @{.'],
    [/[\x00-\x20~^:?*[\\\x7f]/.test(name), 'A branch name cannot contain spaces or any of ~ ^ : ? * [ \\.'],
    [name === '@' || name === 'HEAD', 'That name is reserved by Git.'],
    [name.split('/').some((part) => part.startsWith('.')), 'No part of a branch name may start with a dot.'],
  ];
  const problem = problems.find(([bad]) => bad);
  if (problem) throw new Error(problem[1]);
  return name;
}

/**
 * The folder migrations are written to, relative to the repository root:
 * forward slashes, no `..`, no leading or trailing slash. Empty means the root.
 */
export function normalizeFolder(raw: string): string {
  const parts = (raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || p === '.git')) {
    throw new Error('The folder must be a path inside the repository.');
  }
  return parts.join('/');
}
