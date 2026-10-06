/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Feedback as a GitHub issue, opened pre-filled for the reader to submit.
 *
 * The issue is filed by the reader's own GitHub account, on GitHub's page: Fox
 * Schema holds no token and posts nothing. A token shipped with every install
 * would be readable by anyone running one, and would let anyone file issues as
 * the project. The cost is that the reader needs a GitHub account and one more
 * click, on a page where they can still edit or abandon what they wrote.
 *
 * Issues are public, so the app details are listed in full before they go and
 * name no connection, host, database or query: the version, the browser, the
 * workspace, and which engines are in use.
 */
import { findLeftoverSecrets, scrubSecrets } from '@foxschema/sql';

/** Where feedback goes. Public, so anyone with a GitHub account can file one. */
export const FEEDBACK_REPO = 'tedious-code/foxSchema';

export type FeedbackKind = 'bug' | 'idea' | 'question';

export const FEEDBACK_KINDS: Record<FeedbackKind, { label: string; titlePrefix: string; githubLabel: string; placeholder: string }> = {
  bug: {
    label: 'Something is wrong',
    titlePrefix: 'Bug',
    githubLabel: 'bug',
    placeholder: 'What did you do, what happened, and what did you expect instead?',
  },
  idea: {
    label: 'An idea',
    titlePrefix: 'Idea',
    githubLabel: 'enhancement',
    placeholder: 'What would you like Fox Schema to do, and what would it save you?',
  },
  question: {
    label: 'A question',
    titlePrefix: 'Question',
    githubLabel: 'question',
    placeholder: 'What are you trying to do?',
  },
};

/** What "Include app details" adds. Nothing that names a server or its data. */
export interface FeedbackDiagnostics {
  version: string | null;
  browser: string;
  workspace: string;
  /** Engines of the saved connections, deduplicated: `postgres`, never a host. */
  engines: string[];
}

export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  description: string;
  diagnostics: FeedbackDiagnostics | null;
}

/**
 * GitHub answers a new-issue URL longer than about 8 KB with an error page, and
 * the reader loses what they typed. Kept under it with room to spare.
 */
export const MAX_ISSUE_URL = 7000;

const TRUNCATED_NOTE = '\n\n_(Shortened to fit in a link: paste the rest here.)_';

export function diagnosticsLines(d: FeedbackDiagnostics): string[] {
  return [
    `- Fox Schema: ${d.version ?? 'unknown'}`,
    `- Browser: ${d.browser || 'unknown'}`,
    `- Workspace: ${d.workspace || 'unknown'}`,
    `- Engines in use: ${d.engines.length > 0 ? d.engines.join(', ') : 'none saved'}`,
  ];
}

function issueTitle(draft: FeedbackDraft): string {
  return `[${FEEDBACK_KINDS[draft.kind].titlePrefix}] ${draft.title.trim()}`;
}

function issueBody(draft: FeedbackDraft, description: string): string {
  const parts = [description.trim()];
  if (draft.diagnostics) parts.push(['<details><summary>App details</summary>', '', ...diagnosticsLines(draft.diagnostics), '', '</details>'].join('\n'));
  parts.push('_Sent from Fox Schema → Send feedback._');
  return parts.join('\n\n');
}

function issueUrl(title: string, body: string, kind: FeedbackKind): string {
  const params = new URLSearchParams({ title, body, labels: FEEDBACK_KINDS[kind].githubLabel });
  return `https://github.com/${FEEDBACK_REPO}/issues/new?${params.toString()}`;
}

/**
 * The issue for a draft: its title and body as GitHub will show them, the
 * link that opens it, and whether the description had to be shortened to fit.
 *
 * GitHub applies `labels` only for people who may label issues; for everyone
 * else the bracketed kind in the title still sorts it.
 */
export function buildFeedbackIssue(draft: FeedbackDraft): { title: string; body: string; url: string; truncated: boolean } {
  const title = issueTitle(draft);
  let description = draft.description.trim();
  let body = issueBody(draft, description);
  let url = issueUrl(title, body, draft.kind);
  if (url.length <= MAX_ISSUE_URL) return { title, body, url, truncated: false };

  // Shorten the description only, never the details or the title, and find
  // the longest prefix that fits. Encoded length is not linear in characters
  // (an emoji is twelve bytes encoded), so search rather than estimate.
  let lo = 0;
  let hi = description.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const fits = issueUrl(title, issueBody(draft, description.slice(0, mid) + TRUNCATED_NOTE), draft.kind).length <= MAX_ISSUE_URL;
    if (fits) lo = mid;
    else hi = mid - 1;
  }
  description = description.slice(0, lo) + TRUNCATED_NOTE;
  body = issueBody(draft, description);
  url = issueUrl(title, body, draft.kind);
  return { title, body, url, truncated: true };
}

/**
 * Lines of the description that look like they carry a password or a
 * credentialed connection URL. The issue is public, so the dialog says so
 * before it opens; it does not rewrite what the reader wrote.
 */
export function feedbackSecretLines(description: string): number[] {
  // The migration file's two checks, line by line: a credentialed URL or a
  // `password=…` in a literal, and an account statement whose password the
  // scrubber would replace (or could not read). The dialect only decides
  // whether `#` starts a comment, so any one will do.
  const flagged = new Set(findLeftoverSecrets(description));
  description.split('\n').forEach((line, i) => {
    const scrubbed = scrubSecrets(line, 'postgres');
    if (scrubbed.replaced > 0 || scrubbed.unreadable.length > 0) flagged.add(i + 1);
  });
  return [...flagged].sort((a, b) => a - b);
}
