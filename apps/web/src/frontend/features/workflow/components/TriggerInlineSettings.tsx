/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/TriggerInlineSettings.tsx).
 */
import { useLoaded } from '@/shared/lib/useLoaded';
import { useMemo, useState } from 'react';
import type { CredentialMeta, WorkflowSummary } from '../api/engineClient';
import { TimezoneSelect } from './controls';
import {
  CRON_EXECUTION_TYPES,
  LOCAL_TIMEZONE,
  loadCronTools,
  formatInZone,
} from '../lib/cron';
import {
  EMPTY_HTTP_REQUEST,
  HttpRequestEditor,
  toHttpRequestValue,
} from './HttpRequestEditor';
import {
  createCronRetryConfig,
  credentialsForTrigger,
  triggerCredentialId,
  withTriggerCredentialId,
  type WorkflowTrigger,
} from '../lib/triggers';

interface Props {
  trigger: WorkflowTrigger;
  credentials: CredentialMeta[];
  workflows?: WorkflowSummary[];
  currentWorkflowId?: string;
  onChange: (next: WorkflowTrigger) => void;
}

/**
 * Edits the workflow trigger a canvas trigger node is bound to, inline in the
 * inspector. Same data the Triggers dialog edits — one source of truth. Mount
 * with `key={trigger.id}` so buffers reset when the binding changes.
 */
export function TriggerInlineSettings({
  trigger,
  credentials,
  workflows = [],
  currentWorkflowId,
  onChange,
}: Props): React.JSX.Element | null {
  const manual = trigger.kind === 'manual' ? trigger : null;
  const cron = trigger.kind === 'cron' ? trigger : null;
  const parent = trigger.kind === 'parent' ? trigger : null;
  const webhook = trigger.kind === 'webhook' ? trigger : null;
  const http = trigger.kind === 'http' ? trigger : null;

  // Input-data text buffer: half-typed JSON must not be clobbered by the
  // round-trip through the parsed value.
  const [inputText, setInputText] = useState(() =>
    manual?.inputData === undefined
      ? ''
      : JSON.stringify(manual.inputData, null, 2),
  );
  const [inputError, setInputError] = useState<string | null>(null);
  // undefined while the cron libraries load; null for an invalid expression.
  const cronTools = useLoaded(loadCronTools);
  const nextRuns = useMemo(
    () => (cron ? (cronTools ? cronTools.nextRuns(cron.cron, cron.timezone, 3) : undefined) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed to the two fields the preview reads; depending on `cron` would recompute on every unrelated keystroke in the inspector
    [cronTools, cron?.cron, cron?.timezone],
  );

  if (manual) {
    return (
      <>
        <label>Input data (JSON)</label>
        <textarea data-testid="workflow-trigger-settings-input"
          rows={6}
          placeholder='[{ "id": 1 }]'
          value={inputText}
          onChange={(event) => {
            const raw = event.target.value;
            setInputText(raw);
            if (!raw.trim()) {
              onChange({ ...manual, inputData: undefined });
              setInputError(null);
              return;
            }
            try {
              onChange({ ...manual, inputData: JSON.parse(raw) });
              setInputError(null);
            } catch {
              setInputError('Not valid JSON — fix before saving.');
            }
          }}
        />
        {inputError ? (
          <div className="field-error">{inputError}</div>
        ) : (
          <div className="hint">
            Pre-start parameters for debug or test runs — sent as the run
            payload; an array of objects becomes one record per item.
          </div>
        )}
      </>
    );
  }

  if (cron) {
    return (
      <>
        <label>Cron expression</label>
        <input data-testid="workflow-trigger-settings-cron"
          value={cron.cron}
          onChange={(event) => onChange({ ...cron, cron: event.target.value })}
        />
        <div className="hint">{cronTools?.describe(cron.cron) ?? ''}</div>

        <label>Time zone</label>
        <div className="inspector-timezone">
          <TimezoneSelect
            value={cron.timezone}
            onChange={(timezone) => onChange({ ...cron, timezone })}
          />
        </div>

        <label>Execution type</label>
        <select data-testid="workflow-trigger-settings-execution-type"
          value={cron.executionType}
          onChange={(event) => {
            const executionType = event.target
              .value as typeof cron.executionType;
            onChange({
              ...cron,
              executionType,
              http:
                executionType === 'http'
                  ? (cron.http ?? EMPTY_HTTP_REQUEST)
                  : cron.http,
            });
          }}
        >
          {(
            Object.keys(CRON_EXECUTION_TYPES) as Array<
              keyof typeof CRON_EXECUTION_TYPES
            >
          ).map((value) => (
            <option key={value} value={value}>
              {CRON_EXECUTION_TYPES[value].label}
            </option>
          ))}
        </select>
        <div className="hint">
          {CRON_EXECUTION_TYPES[cron.executionType].description}
        </div>
        {cron.executionType === 'http' && (
          <>
            <label>HTTP request</label>
            <div className="hint">
              Same request shape as the HTTP API pipe — params, headers, auth,
              body.
            </div>
            <HttpRequestEditor
              key={trigger.id}
              compact
              value={toHttpRequestValue(cron.http ?? EMPTY_HTTP_REQUEST)}
              credentials={credentials}
              onChange={(http) => onChange({ ...cron, http })}
            />
          </>
        )}

        <label>Catch-up behavior</label>
        <select data-testid="workflow-trigger-settings-catch-up"
          value={cron.catchUp}
          onChange={(event) =>
            onChange({
              ...cron,
              catchUp: event.target.value as typeof cron.catchUp,
            })
          }
        >
          <option value="none">No catch-up</option>
          <option value="one">One missed run</option>
          <option value="all">All missed runs</option>
        </select>

        <label className="checkbox-row">
          <input data-testid="workflow-trigger-settings-retry"
            type="checkbox"
            checked={cron.retryConfig != null}
            onChange={(event) =>
              onChange({
                ...cron,
                retryConfig: event.target.checked
                  ? createCronRetryConfig()
                  : undefined,
              })
            }
          />
          Retry failed jobs
        </label>
        {cron.retryConfig && (
          <>
            <label>Max retry attempts</label>
            <input data-testid="workflow-trigger-settings-max-retry-attempts"
              type="number"
              min={0}
              value={cron.retryConfig.maxRetryAttempts}
              onChange={(event) =>
                onChange({
                  ...cron,
                  retryConfig: {
                    ...cron.retryConfig!,
                    maxRetryAttempts: Math.max(
                      0,
                      Number(event.target.value) || 0,
                    ),
                  },
                })
              }
            />
            <label>Max retry duration (0s = unlimited)</label>
            <input data-testid="workflow-trigger-settings-max-retry-duration"
              value={cron.retryConfig.maxRetryDuration}
              onChange={(event) =>
                onChange({
                  ...cron,
                  retryConfig: {
                    ...cron.retryConfig!,
                    maxRetryDuration: event.target.value,
                  },
                })
              }
            />
            <label>Min backoff duration</label>
            <input data-testid="workflow-trigger-settings-min-backoff-duration"
              value={cron.retryConfig.minBackoffDuration}
              onChange={(event) =>
                onChange({
                  ...cron,
                  retryConfig: {
                    ...cron.retryConfig!,
                    minBackoffDuration: event.target.value,
                  },
                })
              }
            />
            <label>Max backoff duration</label>
            <input data-testid="workflow-trigger-settings-max-backoff-duration"
              value={cron.retryConfig.maxBackoffDuration}
              onChange={(event) =>
                onChange({
                  ...cron,
                  retryConfig: {
                    ...cron.retryConfig!,
                    maxBackoffDuration: event.target.value,
                  },
                })
              }
            />
            <label>Max doublings</label>
            <input data-testid="workflow-trigger-settings-max-doublings"
              type="number"
              min={0}
              value={cron.retryConfig.maxDoublings}
              onChange={(event) =>
                onChange({
                  ...cron,
                  retryConfig: {
                    ...cron.retryConfig!,
                    maxDoublings: Math.max(0, Number(event.target.value) || 0),
                  },
                })
              }
            />
          </>
        )}

        <label>Next runs · {cron.timezone}</label>
        {nextRuns === undefined ? (
          <div className="hint">Loading the schedule preview…</div>
        ) : nextRuns === null ? (
          <div className="hint">
            Enter a valid cron expression to preview run times.
          </div>
        ) : (
          <div className="inspector-next-runs">
            {nextRuns.map((run) => (
              <div key={run.toISOString()}>
                <span>{formatInZone(run, cron.timezone)}</span>
                {cron.timezone !== LOCAL_TIMEZONE && (
                  <small>{formatInZone(run, LOCAL_TIMEZONE)} · your time</small>
                )}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  if (parent) {
    const candidates = workflows.filter(
      (workflow) => workflow.id !== currentWorkflowId,
    );
    return (
      <>
        <label>Allowed parent workflows</label>
        <div className="hint">
          Empty allowlist = any parent may call via workflow.sub.
        </div>
        {candidates.map((workflow) => {
          const checked = parent.allowFrom.includes(workflow.id);
          return (
            <label key={workflow.id} className="checkbox-row">
              <input data-testid={`workflow-trigger-settings-workflow-${workflow.id}`}
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const allowFrom = event.target.checked
                    ? [...parent.allowFrom, workflow.id]
                    : parent.allowFrom.filter((id) => id !== workflow.id);
                  onChange({ ...parent, allowFrom });
                }}
              />
              {workflow.name}
            </label>
          );
        })}
        {candidates.length === 0 && (
          <div className="hint">No other saved workflows yet.</div>
        )}
      </>
    );
  }

  if (webhook) {
    return (
      <>
        <label>Credential</label>
        <select data-testid="workflow-trigger-settings-webhook-credential"
          value={triggerCredentialId(webhook)}
          onChange={(eventChange) =>
            onChange(withTriggerCredentialId(webhook, eventChange.target.value))
          }
        >
          <option value="">Select credential</option>
          {credentialsForTrigger('webhook', credentials).map((credential) => (
            <option key={credential.id} value={credential.id}>
              {credential.name}
            </option>
          ))}
        </select>
        <label>Max body bytes</label>
        <input data-testid="workflow-trigger-settings-max-body-bytes"
          type="number"
          value={webhook.maxBodyBytes}
          onChange={(eventChange) =>
            onChange({
              ...webhook,
              maxBodyBytes: Number(eventChange.target.value) || 0,
            })
          }
        />
        <div className="hint">
          Signed webhook ingress via POST /api/triggers/:workflowId/:triggerId
        </div>
      </>
    );
  }

  if (http) {
    return (
      <>
        <label>Credential</label>
        <select data-testid="workflow-trigger-settings-http-credential"
          value={http.credentialId}
          onChange={(eventChange) =>
            onChange({ ...http, credentialId: eventChange.target.value })
          }
        >
          <option value="">Select credential</option>
          {credentialsForTrigger('http', credentials).map((credential) => (
            <option key={credential.id} value={credential.id}>
              {credential.name}
            </option>
          ))}
        </select>
        <label>Required fields</label>
        <input data-testid="workflow-trigger-settings-required-fields"
          value={http.requiredFields.join(', ')}
          onChange={(eventChange) =>
            onChange({
              ...http,
              requiredFields: eventChange.target.value
                .split(',')
                .map((field) => field.trim())
                .filter(Boolean),
            })
          }
        />
        <div className="hint">
          Authenticated HTTP ingress via POST /api/triggers/:workflowId/:triggerId
        </div>
      </>
    );
  }

  return null;
}
