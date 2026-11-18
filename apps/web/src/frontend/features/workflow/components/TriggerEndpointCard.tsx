/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

interface Props {
  /** Absent until the workflow is saved; the URL then shows a placeholder. */
  workflowId?: string;
  triggerId: string;
  /** The webhook's vanity path, when it has one. */
  path?: string;
}

/** Where a webhook trigger listens, with a cURL call to try it. */
export function TriggerEndpointCard({
  workflowId = '<workflow-id>',
  triggerId,
  path,
}: Props): React.JSX.Element {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const origin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : 'http://localhost:3210';

  const endpointPath = path ? `/api/hooks/${path}` : `/api/triggers/${workflowId}/${triggerId}`;
  const fullUrl = `${origin}${endpointPath}`;

  const headerLines: string[] = ['Content-Type: application/json', 'x-idempotency-key: <uuid>'];
  const sampleBody = JSON.stringify([{ city: 'Tokyo' }], null, 2);

  const curlCommand = `curl -X POST "${fullUrl}" \\
  -H "Content-Type: application/json" \\
  -d '${sampleBody.replace(/\n\s*/g, ' ')}'`;

  const copyUrl = () => {
    void navigator.clipboard.writeText(fullUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const copyCurl = () => {
    void navigator.clipboard.writeText(curlCommand);
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 2000);
  };

  return (
    <div className="trigger-endpoint-card" data-testid="trigger-endpoint-card">
      <div className="trigger-endpoint-header">
        <span className="trigger-endpoint-badge">POST</span>
        <span className="trigger-endpoint-title">Webhook endpoint</span>
      </div>

      <div className="trigger-endpoint-url-row">
        <code className="trigger-endpoint-url" title={fullUrl}>
          {endpointPath}
        </code>
        <button
          data-testid="workflow-trigger-endpoint-copy-url"
          type="button"
          className="trigger-endpoint-btn"
          onClick={copyUrl}
          title="Copy full URL"
        >
          {copiedUrl ? <Check size={11} /> : <Copy size={11} />}
          <span>{copiedUrl ? 'Copied' : 'Copy URL'}</span>
        </button>
      </div>

      <div className="trigger-endpoint-details">
        <div className="trigger-endpoint-section-label">Headers</div>
        <pre className="trigger-endpoint-code">{headerLines.join('\n')}</pre>

        <div className="trigger-endpoint-section-label">Sample JSON Body</div>
        <pre className="trigger-endpoint-code">{sampleBody}</pre>

        <div className="trigger-endpoint-curl-section">
          <div className="trigger-endpoint-section-label-row">
            <span className="trigger-endpoint-curl-title">
              <Terminal size={11} /> cURL Command
            </span>
            <button
              data-testid="workflow-trigger-endpoint-copy-curl"
              type="button"
              className="trigger-endpoint-btn"
              onClick={copyCurl}
              title="Copy cURL command"
            >
              {copiedCurl ? <Check size={11} /> : <Copy size={11} />}
              <span>{copiedCurl ? 'Copied' : 'Copy cURL'}</span>
            </button>
          </div>
          <pre className="trigger-endpoint-code trigger-endpoint-curl">{curlCommand}</pre>
        </div>
      </div>
    </div>
  );
}
