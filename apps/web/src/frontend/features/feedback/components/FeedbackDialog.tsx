/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Send feedback: a bug, an idea or a question, as a GitHub issue.
 *
 * The reader writes it here and submits it on GitHub, where it opens
 * pre-filled under their own account (see `feedbackIssue.ts` for why Fox
 * Schema posts nothing itself). Issues are public, so the dialog shows every
 * app detail it would add, lets the reader leave them out, and warns about a
 * line that looks like it carries a password before anything leaves.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, MessageSquarePlus, X } from 'lucide-react';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useUiStore } from '@/app/store/uiStore';
import { sectionLabelCls } from '@/shared/components/surfaces';
import {
  buildFeedbackIssue,
  diagnosticsLines,
  feedbackSecretLines,
  FEEDBACK_KINDS,
  FEEDBACK_REPO,
  type FeedbackDiagnostics,
  type FeedbackKind,
} from '../lib/feedbackIssue';

const inputCls =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 accent-focus focus:outline-none';

export const FeedbackDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  /** The running version, when the server said; the details say "unknown" otherwise. */
  version: string | null;
}> = ({ open, onClose, version }) => {
  const connections = useSyncStore((s) => s.connections);
  const activeView = useUiStore((s) => s.activeView);
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [includeDetails, setIncludeDetails] = useState(true);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const diagnostics: FeedbackDiagnostics = useMemo(
    () => ({
      version,
      browser: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      workspace: String(activeView ?? ''),
      engines: [...new Set(connections.map((c) => c.dialect).filter(Boolean))].sort(),
    }),
    [version, activeView, connections]
  );
  const secretLines = useMemo(() => feedbackSecretLines(description), [description]);
  const issue = useMemo(
    () => buildFeedbackIssue({ kind, title, description, diagnostics: includeDetails ? diagnostics : null }),
    [kind, title, description, includeDetails, diagnostics]
  );

  if (!open) return null;

  const missing = !title.trim() ? 'Give it a title.' : !description.trim() ? 'Say what happened or what you would like.' : null;

  const openOnGitHub = () => {
    if (missing) return;
    window.open(issue.url, '_blank', 'noopener,noreferrer');
    setSent(true);
  };

  return createPortal(
    <div
      data-testid="feedback-dialog"
      className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 shrink-0">
          <MessageSquarePlus className="w-4 h-4 text-sky-300" />
          <h2 id="feedback-dialog-title" className="text-sm font-bold text-slate-100 flex-1">
            Send feedback
          </h2>
          <button data-testid="feedback-close" type="button" aria-label="Close" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">
          <p className="text-[11px] text-slate-400">
            This opens a new issue on GitHub ({FEEDBACK_REPO}), filled in with what you write here. You review it and submit
            it there with your GitHub account. Issues are public: leave out passwords, hostnames and data.
          </p>

          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of feedback" data-testid="feedback-kind">
            {(Object.keys(FEEDBACK_KINDS) as FeedbackKind[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                data-testid={`feedback-kind-${k}`}
                onClick={() => setKind(k)}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition ${
                  kind === k ? 'border-sky-500/50 bg-sky-500/15 text-sky-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                {FEEDBACK_KINDS[k].label}
              </button>
            ))}
          </div>

          <label className="flex flex-col gap-1">
            <span className={sectionLabelCls}>Title</span>
            <input
              data-testid="feedback-title"
              className={inputCls}
              value={title}
              maxLength={200}
              placeholder="One line"
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={sectionLabelCls}>Details</span>
            <textarea
              data-testid="feedback-description"
              className={`${inputCls} min-h-[8rem] font-mono text-[12px]`}
              value={description}
              placeholder={FEEDBACK_KINDS[kind].placeholder}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {secretLines.length > 0 && (
            <p className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200" data-testid="feedback-secret-warning">
              Line{secretLines.length === 1 ? '' : 's'} {secretLines.join(', ')} look{secretLines.length === 1 ? 's' : ''} like{' '}
              {secretLines.length === 1 ? 'it carries' : 'they carry'} a password. Remove it before sending: GitHub issues are public.
            </p>
          )}

          <div className="rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2">
            <label className="flex items-center gap-2 text-[12px] text-slate-300">
              <input
                type="checkbox"
                data-testid="feedback-include-details"
                checked={includeDetails}
                onChange={(e) => setIncludeDetails(e.target.checked)}
              />
              Include app details
            </label>
            <ul className="mt-1.5 ml-6 list-none text-[11px] font-mono text-slate-500" data-testid="feedback-details">
              {diagnosticsLines(diagnostics).map((line) => (
                <li key={line} className={includeDetails ? '' : 'line-through opacity-60'}>
                  {line.replace(/^- /, '')}
                </li>
              ))}
            </ul>
          </div>

          {issue.truncated && (
            <p className="text-[11px] text-amber-200" data-testid="feedback-truncated">
              The details are too long for a link, so the issue opens with the start of them. Paste the rest on GitHub.
            </p>
          )}
          {sent && (
            <p className="text-[11px] text-emerald-200" data-testid="feedback-sent">
              Opened on GitHub in a new tab. Submit it there; you can close this.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-3 shrink-0">
          {missing && <span className="mr-auto text-[11px] text-slate-500">{missing}</span>}
          <button type="button" data-testid="feedback-cancel" onClick={onClose} className="rounded-md border border-slate-600 px-3 py-1.5 text-[12px] text-slate-300">
            Cancel
          </button>
          <button
            type="button"
            data-testid="feedback-open-github"
            disabled={!!missing}
            onClick={openOnGitHub}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-[12px] font-bold text-sky-100 disabled:opacity-40"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open on GitHub
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default FeedbackDialog;
