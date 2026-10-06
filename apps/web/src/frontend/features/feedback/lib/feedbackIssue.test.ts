/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { buildFeedbackIssue, feedbackSecretLines, FEEDBACK_REPO, MAX_ISSUE_URL, type FeedbackDraft } from './feedbackIssue';

const draft = (over: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  kind: 'bug',
  title: 'Compare hangs on Oracle',
  description: 'Clicked Compare, the spinner never stopped.',
  diagnostics: null,
  ...over,
});

const params = (url: string) => new URL(url).searchParams;

describe('buildFeedbackIssue', () => {
  it('opens a new issue on the public repo, titled by kind and labelled for those who may', () => {
    const issue = buildFeedbackIssue(draft());
    expect(issue.url.startsWith(`https://github.com/${FEEDBACK_REPO}/issues/new?`)).toBe(true);
    expect(params(issue.url).get('title')).toBe('[Bug] Compare hangs on Oracle');
    expect(params(issue.url).get('labels')).toBe('bug');
    expect(params(issue.url).get('body')).toBe(issue.body);
    expect(issue.body).toContain('Clicked Compare, the spinner never stopped.');
    expect(issue.truncated).toBe(false);

    expect(params(buildFeedbackIssue(draft({ kind: 'idea' })).url).get('labels')).toBe('enhancement');
    expect(buildFeedbackIssue(draft({ kind: 'question', title: '  How do I…  ' })).title).toBe('[Question] How do I…');
  });

  it('adds app details only when asked, and they name no server', () => {
    expect(buildFeedbackIssue(draft()).body).not.toContain('App details');
    const body = buildFeedbackIssue(
      draft({ diagnostics: { version: '0.2.295', browser: 'Chrome 140', workspace: 'sync', engines: ['oracle', 'postgres'] } })
    ).body;
    expect(body).toContain('<details><summary>App details</summary>');
    expect(body).toContain('- Fox Schema: 0.2.295');
    expect(body).toContain('- Engines in use: oracle, postgres');
    expect(buildFeedbackIssue(draft({ diagnostics: { version: null, browser: '', workspace: '', engines: [] } })).body).toContain(
      '- Fox Schema: unknown'
    );
  });

  it('keeps characters that mean something in a URL intact', () => {
    const description = 'a&b=c #1 100% ?x=1 + "quoted" <tag> 日本語 🦊\nsecond line';
    const issue = buildFeedbackIssue(draft({ title: 'a&b #1 ?', description }));
    expect(params(issue.url).get('title')).toBe('[Bug] a&b #1 ?');
    expect(params(issue.url).get('body')).toContain(description);
  });

  it('shortens a long description to fit in a link GitHub accepts, and says so', () => {
    for (const unit of ['x', 'é', '🦊']) {
      const issue = buildFeedbackIssue(
        draft({ description: unit.repeat(20_000), diagnostics: { version: '1', browser: 'b', workspace: 'w', engines: ['db2'] } })
      );
      expect(issue.truncated).toBe(true);
      expect(issue.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
      // As much as fits: one more character would not.
      expect(issue.url.length).toBeGreaterThan(MAX_ISSUE_URL - 200);
      expect(issue.body).toContain('Shortened to fit in a link');
      // The title and the app details survive whole.
      expect(issue.body).toContain('- Engines in use: db2');
      expect(params(issue.url).get('title')).toBe('[Bug] Compare hangs on Oracle');
    }
  });
});

describe('feedbackSecretLines', () => {
  it('points at lines that look like they carry a password', () => {
    expect(feedbackSecretLines('fine\npostgres://app:hunter2@db.local/shop\nalso fine')).toEqual([2]);
    expect(feedbackSecretLines("CREATE USER a IDENTIFIED BY 'x'; ALTER USER b PASSWORD 's3cret'")).toEqual([1]);
    expect(feedbackSecretLines('Compare hangs when the password field is empty')).toEqual([]);
  });
});
