/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

interface Props {
  workflowId?: string;
  triggerId: string;
  kind: 'http' | 'webhook';
  credentialId?: string;
  authHeader?: string;
  requiredFields?: string[];
  path?: string;
}

export function TriggerEndpointCard({
  workflowId = 'sample-cities-postgres',
  triggerId,
  kind,
  credentialId,
  authHeader,
  requiredFields,
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

  const headerLines: string[] = ['Content-Type: application/json'];
  if (kind === 'http' && credentialId) {
    headerLines.push(`${authHeader || 'Authorization'}: Bearer <YOUR_TOKEN>`);
  }
  headerLines.push('x-idempotency-key: <uuid>');

  const sampleBody =
    requiredFields && requiredFields.length > 0
      ? JSON.stringify(
          [
            requiredFields.reduce<Record<string, string>>((acc, field) => {
              acc[field] = field.toLowerCase().includes('city') ? 'Tokyo' : 'value';
              return acc;
            }, {}),
          ],
          null,
          2,
        )
      : JSON.stringify([{ city: 'Tokyo' }], null, 2);

  const curlCommand = `curl -X POST "${fullUrl}" \\
  -H "Content-Type: application/json"${
    kind === 'http' && credentialId
      ? ` \\\n  -H "${authHeader || 'Authorization'}: Bearer <YOUR_TOKEN>"`
      : ''
  } \\
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
        <span className="trigger-endpoint-title">API Endpoint Call</span>
      </div>

      <div className="trigger-endpoint-url-row">
        <code className="trigger-endpoint-url" title={fullUrl}>
          {endpointPath}
        </code>
        <button
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
