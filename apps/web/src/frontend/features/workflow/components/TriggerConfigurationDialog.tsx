/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/TriggerConfigurationDialog.tsx).
 */
import Editor from '@monaco-editor/react';
import {
  CalendarClock,
  ChevronRight,
  Clock3,
  Code2,
  GitBranch,
  Globe2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CredentialMeta, WorkflowSummary } from '../api/engineClient';
import {
  CRON_EXECUTION_TYPES,
  LOCAL_TIMEZONE,
  computeNextRuns,
  formatInZone,
} from '../lib/cron';
import {
  EMPTY_HTTP_REQUEST,
  HttpRequestEditor,
  toHttpRequestValue,
} from './HttpRequestEditor';
import { JSON_EDITOR_OPTIONS, useJsonEditorTheme } from '../lib/jsonEditorOptions';
import {
  TRIGGER_KINDS,
  createCronRetryConfig,
  createTrigger,
  credentialsForTrigger,
  nextTriggerId,
  triggerCredentialId,
  withTriggerCredentialId,
  type WorkflowTrigger,
} from '../lib/triggers';
import { Button, Input, Label, Select, Textarea, TimezoneSelect } from './controls';

/**
 * Pre-start parameters for a manual trigger. Holds its own text buffer so
 * half-typed JSON doesn't get clobbered; only valid JSON is lifted up. Mount
 * with `key={trigger.id}` so switching triggers reloads the buffer.
 */
function InputDataEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2),
  );
  const jsonEditorTheme = useJsonEditorTheme();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="span-2">
      <Label>Input data (JSON)</Label>
      <div className="monaco-frame">
        <Editor
          height="200px"
          language="json"
          theme={jsonEditorTheme}
          value={text}
          onChange={(next) => {
            const raw = next ?? '';
            setText(raw);
            if (!raw.trim()) {
              onChange(undefined);
              setError(null);
              return;
            }
            try {
              onChange(JSON.parse(raw));
              setError(null);
            } catch {
              setError('Not valid JSON — fix before saving.');
            }
          }}
          options={JSON_EDITOR_OPTIONS}
        />
      </div>
      {error ? (
        <div className="field-error">{error}</div>
      ) : (
        <small className="form-help">
          Sent as the run payload when you start this workflow — an array of
          objects becomes one record per item. Leave empty for none.
        </small>
      )}
    </div>
  );
}

/**
 * Live "next 5 runs" preview. Each fire time is shown in the schedule's own
 * timezone and, when it differs, in the viewer's local timezone as well.
 */
function SchedulePreview({
  runs,
  timezone,
}: {
  runs: Date[] | null;
  timezone: string;
}): React.JSX.Element {
  const showLocal = timezone !== LOCAL_TIMEZONE;
  return (
    <div className="schedule-preview span-2">
      <strong>Next 5 Runs · {timezone}</strong>
      {runs === null ? (
        <div className="schedule-preview-empty">
          Enter a valid cron expression to preview run times.
        </div>
      ) : (
        runs.map((run) => (
          <div key={run.toISOString()}>
            <CalendarClock size={14} />
            <span>
              {formatInZone(run, timezone)}
              {showLocal && (
                <small className="schedule-preview-local">
                  {formatInZone(run, LOCAL_TIMEZONE)} · your time
                </small>
              )}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  triggers: WorkflowTrigger[];
  credentials: CredentialMeta[];
  /** Saved workflows for parent-trigger allowlists. */
  workflows?: WorkflowSummary[];
  /** Exclude this id from allow-from pickers (current workflow). */
  currentWorkflowId?: string;
  /** Select this trigger when opening (e.g. jumped to from a trigger node). */
  focusTriggerId?: string;
  onChange: (triggers: WorkflowTrigger[]) => void;
  onClose: () => void;
}

const TRIGGER_META = {
  manual: {
    label: 'Manual Trigger',
    description: 'Run and debug this workflow with custom input data.',
    icon: Play,
  },
  cron: {
    label: 'Schedule Trigger',
    description: 'Run this workflow on a cron schedule or timer.',
    icon: CalendarClock,
  },
  webhook: {
    label: 'Webhook Trigger',
    description: 'Receive signed payloads from external systems via HTTP.',
    icon: Webhook,
  },
  http: {
    label: 'API Endpoint Trigger',
    description: 'Publish an authenticated HTTP endpoint to start this workflow.',
    icon: Globe2,
  },
  poll: {
    label: 'API Polling Trigger',
    description:
      'Call an endpoint on an interval and run only when new items appear.',
    icon: RefreshCw,
  },
  parent: {
    label: 'Parent Workflow Trigger',
    description: 'Allow other workflows to call this one via workflow.sub.',
    icon: GitBranch,
  },
} as const;

function getSections(kind: WorkflowTrigger['kind']): string[] {
  switch (kind) {
    case 'cron':
      return [
        'general',
        'schedule',
        'execution',
        'time zone',
        'retry config',
        'input data',
        'output',
        'error handling',
      ];
    case 'webhook':
      return [
        'general',
        'request',
        'request validation',
        'response',
        'output',
        'error handling',
      ];
    case 'http':
      return [
        'general',
        'api request',
        'authentication',
        'headers',
        'query parameters',
        'response',
        'output',
      ];
    case 'manual':
      return ['general', 'input parameters', 'output', 'error handling'];
    case 'poll':
      return [
        'general',
        'api request',
        'authentication',
        'polling',
        'output',
        'error handling',
      ];
    case 'parent':
      return ['general', 'allow from', 'output', 'error handling'];
  }
}

function getSectionIcon(section: string): ReactNode {
  if (section === 'schedule' || section === 'time zone') {
    return <Clock3 size={14} />;
  }
  if (section === 'execution') {
    return <Zap size={14} />;
  }
  if (section === 'retry config') {
    return <RotateCcw size={14} />;
  }
  if (section.includes('error') || section === 'authentication') {
    return <ShieldCheck size={14} />;
  }
  return <Code2 size={14} />;
}

export function TriggerConfigurationDialog({
  open,
  triggers,
  credentials,
  workflows = [],
  currentWorkflowId,
  focusTriggerId,
  onChange,
  onClose,
}: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [section, setSection] = useState('general');
  const [addKind, setAddKind] = useState<WorkflowTrigger['kind']>('cron');
  const trigger = triggers[selectedIndex];
  const meta = trigger ? TRIGGER_META[trigger.kind] : undefined;
  const Icon = meta?.icon ?? Play;
  const sections = trigger ? getSections(trigger.kind) : [];

  const cronTrigger = trigger?.kind === 'cron' ? trigger : null;
  const nextRuns = useMemo(
    () =>
      cronTrigger
        ? computeNextRuns(cronTrigger.cron, cronTrigger.timezone)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed to the two fields the preview reads; depending on `cronTrigger` would recompute on every unrelated keystroke in the dialog
    [cronTrigger?.cron, cronTrigger?.timezone],
  );

  // Honour the focus request once, when the dialog opens. `triggers` is
  // deliberately not a dependency: it changes on every edit, and re-running
  // this reset the section to General after each keystroke — and snapped the
  // selection back to the focused trigger whenever another one was edited.
  useEffect(() => {
    if (!open || !focusTriggerId) return;
    const index = triggers.findIndex((item) => item.id === focusTriggerId);
    if (index >= 0) {
      setSelectedIndex(index);
      setSection('general');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusTriggerId]);

  if (!open) return null;

  const patch = (next: WorkflowTrigger) => {
    onChange(triggers.map((item, index) => (index === selectedIndex ? next : item)));
  };

  const addTrigger = () => {
    onChange([
      ...triggers,
      createTrigger(addKind, nextTriggerId(triggers, addKind)),
    ]);
    setSelectedIndex(triggers.length);
    setSection('general');
  };

  return (
    <div className="trigger-dialog-backdrop" role="presentation">
      <section className="trigger-dialog" role="dialog" aria-modal="true" aria-label="Trigger configuration">
        <header className="trigger-dialog-titlebar">
          <div className="trigger-title">
            <span className="trigger-title-icon"><Icon size={19} /></span>
            <div>
              <h2>{meta?.label ?? 'Trigger configuration'}</h2>
              <p>{meta?.description}</p>
            </div>
          </div>
          <div className="trigger-dialog-actions">
            <Button><Play /> Test trigger</Button>
            <Button variant="primary"><Save /> Save</Button>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
        </header>

        <div className="trigger-dialog-body">
          <aside className="trigger-list">
            <span className="trigger-list-label">WORKFLOW TRIGGERS</span>
            {triggers.map((item, index) => {
              const itemMeta = TRIGGER_META[item.kind];
              const ItemIcon = itemMeta.icon;
              return (
                <button data-testid={`workflow-trigger-config-item-${item.id}`}
                  key={item.id}
                  className={index === selectedIndex ? 'active' : ''}
                  onClick={() => {
                    setSelectedIndex(index);
                    setSection('general');
                  }}
                >
                  <ItemIcon size={15} />
                  <span>{itemMeta.label}</span>
                  <ChevronRight size={13} />
                </button>
              );
            })}
            <div className="trigger-list-add">
              <Select
                aria-label="New trigger kind"
                value={addKind}
                onChange={(event) =>
                  setAddKind(event.target.value as WorkflowTrigger['kind'])
                }
              >
                {TRIGGER_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {TRIGGER_META[kind].label}
                  </option>
                ))}
              </Select>
              <Button onClick={addTrigger} aria-label="Add trigger">
                <Plus /> Add
              </Button>
            </div>
          </aside>

          <aside className="trigger-sections">
            <div className="trigger-config-id">
              <strong>Pipe Configuration</strong>
              <small>ID: {trigger?.id}</small>
            </div>
            {sections.map((item) => (
              <button data-testid={`workflow-trigger-config-section-${item}`}
                key={item}
                className={section === item ? 'active' : ''}
                onClick={() => setSection(item)}
              >
                {getSectionIcon(item)}
                <span>{item}</span>
              </button>
            ))}
          </aside>

          <main className="trigger-config-content">
            {!trigger ? (
              <div className="trigger-empty">No trigger selected.</div>
            ) : (
              <>
                <div className="trigger-config-heading">
                  <h3>{section.replace(/\b\w/g, (letter) => letter.toUpperCase())}</h3>
                  <span className={trigger.enabled ? 'enabled' : ''}>
                    {trigger.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>

                {section === 'general' && (
                  <div className="trigger-form-grid">
                    <div>
                      <Label>Name</Label>
                      <Input value={trigger.id} onChange={(event) => patch({ ...trigger, id: event.target.value })} />
                    </div>
                    <div>
                      <Label>Status</Label>
                      <Select
                        value={trigger.enabled ? 'enabled' : 'disabled'}
                        onChange={(event) => patch({ ...trigger, enabled: event.target.value === 'enabled' })}
                      >
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                      </Select>
                    </div>
                    <div className="span-2">
                      <Label>Description (optional)</Label>
                      <Textarea value={meta?.description ?? ''} readOnly />
                    </div>
                  </div>
                )}

                {trigger.kind === 'manual' && section === 'input parameters' && (
                  <div className="trigger-form-grid">
                    <InputDataEditor
                      key={trigger.id}
                      value={trigger.inputData}
                      onChange={(inputData) => patch({ ...trigger, inputData })}
                    />
                  </div>
                )}

                {trigger.kind === 'cron' && section === 'schedule' && (
                  <div className="trigger-form-grid">
                    <div>
                      <Label>Cron Expression</Label>
                      <Input value={trigger.cron} onChange={(event) => patch({ ...trigger, cron: event.target.value })} />
                      <small className="form-help">Example: 0 0 * * * runs every day at midnight.</small>
                    </div>
                    <div>
                      <Label>Catch-up behavior</Label>
                      <Select
                        value={trigger.catchUp}
                        onChange={(event) => patch({ ...trigger, catchUp: event.target.value as typeof trigger.catchUp })}
                      >
                        <option value="none">No catch-up</option>
                        <option value="one">One missed run</option>
                        <option value="all">All missed runs</option>
                      </Select>
                    </div>
                    <SchedulePreview runs={nextRuns} timezone={trigger.timezone} />
                  </div>
                )}

                {trigger.kind === 'cron' && section === 'execution' && (
                  <div className="trigger-form-grid">
                    <div className="span-2">
                      <Label>Execution Type</Label>
                      <Select
                        value={trigger.executionType}
                        onChange={(event) => {
                          const executionType = event.target
                            .value as typeof trigger.executionType;
                          patch({
                            ...trigger,
                            executionType,
                            http:
                              executionType === 'http'
                                ? (trigger.http ?? EMPTY_HTTP_REQUEST)
                                : trigger.http,
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
                      </Select>
                      <small className="form-help">
                        {CRON_EXECUTION_TYPES[trigger.executionType].description}
                      </small>
                    </div>
                    {trigger.executionType === 'http' && (
                      <div className="span-2">
                        <Label>HTTP request</Label>
                        <small className="form-help">
                          Shared with the HTTP API pipe — params, headers, auth,
                          body (no duplicated fields).
                        </small>
                        <HttpRequestEditor
                          // Remount per trigger: the editor keeps local
                          // buffers (body JSON, Zod schema, test data) that
                          // must not bleed between triggers.
                          key={trigger.id}
                          value={toHttpRequestValue(
                            trigger.http ?? EMPTY_HTTP_REQUEST,
                          )}
                          credentials={credentials}
                          onChange={(http) => patch({ ...trigger, http })}
                        />
                      </div>
                    )}
                  </div>
                )}

                {trigger.kind === 'cron' && section === 'time zone' && (
                  <div className="trigger-form-grid">
                    <div className="span-2">
                      <Label>Time Zone</Label>
                      <TimezoneSelect
                        value={trigger.timezone}
                        onChange={(timezone) => patch({ ...trigger, timezone })}
                      />
                      <small className="form-help">
                        Your local timezone is {LOCAL_TIMEZONE}. Runs below are
                        shown in both.
                      </small>
                    </div>
                    <SchedulePreview runs={nextRuns} timezone={trigger.timezone} />
                  </div>
                )}

                {trigger.kind === 'cron' && section === 'retry config' && (
                  <div className="trigger-form-grid">
                    <p className="span-2 retry-intro">
                      If a job does not complete successfully, it is retried with
                      exponential backoff according to these settings.
                    </p>
                    <label className="span-2 retry-enable">
                      <input data-testid="workflow-trigger-config-retry"
                        type="checkbox"
                        checked={trigger.retryConfig != null}
                        onChange={(event) =>
                          patch({
                            ...trigger,
                            retryConfig: event.target.checked
                              ? createCronRetryConfig()
                              : undefined,
                          })
                        }
                      />
                      Retry failed jobs
                    </label>
                    {trigger.retryConfig && (
                      <>
                        <div className="span-2">
                          <Label>Max retry attempts</Label>
                          <Input
                            type="number"
                            min={0}
                            value={trigger.retryConfig.maxRetryAttempts}
                            onChange={(event) =>
                              patch({
                                ...trigger,
                                retryConfig: {
                                  ...trigger.retryConfig!,
                                  maxRetryAttempts: Math.max(
                                    0,
                                    Number(event.target.value) || 0,
                                  ),
                                },
                              })
                            }
                          />
                          <small className="form-help">
                            Maximum number of retry attempts for a failed job
                          </small>
                        </div>
                        <div className="span-2">
                          <Label>Max retry duration</Label>
                          <Input
                            value={trigger.retryConfig.maxRetryDuration}
                            onChange={(event) =>
                              patch({
                                ...trigger,
                                retryConfig: {
                                  ...trigger.retryConfig!,
                                  maxRetryDuration: event.target.value,
                                },
                              })
                            }
                          />
                          <small className="form-help">
                            Time limit for retrying a failed job, 0s means unlimited
                          </small>
                        </div>
                        <div>
                          <Label>Min backoff duration</Label>
                          <Input
                            value={trigger.retryConfig.minBackoffDuration}
                            onChange={(event) =>
                              patch({
                                ...trigger,
                                retryConfig: {
                                  ...trigger.retryConfig!,
                                  minBackoffDuration: event.target.value,
                                },
                              })
                            }
                          />
                          <small className="form-help">
                            Minimum time to wait before retrying a job after it fails
                          </small>
                        </div>
                        <div>
                          <Label>Max backoff duration</Label>
                          <Input
                            value={trigger.retryConfig.maxBackoffDuration}
                            onChange={(event) =>
                              patch({
                                ...trigger,
                                retryConfig: {
                                  ...trigger.retryConfig!,
                                  maxBackoffDuration: event.target.value,
                                },
                              })
                            }
                          />
                          <small className="form-help">
                            Maximum time to wait before retrying a job after it fails
                          </small>
                        </div>
                        <div className="span-2">
                          <Label>Max doublings</Label>
                          <Input
                            type="number"
                            min={0}
                            value={trigger.retryConfig.maxDoublings}
                            onChange={(event) =>
                              patch({
                                ...trigger,
                                retryConfig: {
                                  ...trigger.retryConfig!,
                                  maxDoublings: Math.max(
                                    0,
                                    Number(event.target.value) || 0,
                                  ),
                                },
                              })
                            }
                          />
                          <small className="form-help">
                            The time between retries will double max doublings times
                          </small>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {(trigger.kind === 'http' || trigger.kind === 'webhook') &&
                  (section === 'authentication' ||
                    section === 'request validation' ||
                    section === 'general') && (
                    <div className="trigger-form-grid">
                      <div>
                        <Label>Authentication</Label>
                        <Select
                          value={triggerCredentialId(trigger)}
                          onChange={(event) =>
                            patch(withTriggerCredentialId(trigger, event.target.value))
                          }
                        >
                          <option value="">None</option>
                          {credentialsForTrigger(trigger.kind, credentials).map((credential) => (
                            <option value={credential.id} key={credential.id}>
                              {credential.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label>Maximum body size</Label>
                        <Input
                          type="number"
                          value={trigger.maxBodyBytes}
                          onChange={(event) =>
                            patch({
                              ...trigger,
                              maxBodyBytes: Number(event.target.value) || 0,
                            })
                          }
                        />
                      </div>
                      <div className="span-2 request-preview">
                        <strong>Request Preview</strong>
                        <pre>{`POST /api/triggers/{workflowId}/${trigger.id}\nContent-Type: application/json`}</pre>
                      </div>
                    </div>
                  )}

                {trigger.kind === 'parent' && section === 'allow from' && (
                  <div className="trigger-form-grid">
                    <div className="span-2">
                      <Label>Allowed parent workflows</Label>
                      <small className="form-help">
                        Leave all unchecked to allow any workflow to call this
                        one via workflow.sub.
                      </small>
                      <div className="trigger-allow-from">
                        {workflows
                          .filter((workflow) => workflow.id !== currentWorkflowId)
                          .map((workflow) => {
                            const checked = trigger.allowFrom.includes(
                              workflow.id,
                            );
                            return (
                              <label key={workflow.id} className="checkbox-row">
                                <input data-testid={`workflow-trigger-config-workflow-${workflow.id}`}
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(event) => {
                                    const allowFrom = event.target.checked
                                      ? [...trigger.allowFrom, workflow.id]
                                      : trigger.allowFrom.filter(
                                          (id) => id !== workflow.id,
                                        );
                                    patch({ ...trigger, allowFrom });
                                  }}
                                />
                                {workflow.name}{' '}
                                <small className="form-help">
                                  ({workflow.id})
                                </small>
                              </label>
                            );
                          })}
                        {workflows.filter(
                          (workflow) => workflow.id !== currentWorkflowId,
                        ).length === 0 && (
                          <p className="form-help">
                            No other saved workflows yet — any parent may call
                            until you add an allowlist.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {section !== 'general' &&
                  !(
                    trigger.kind === 'manual' && section === 'input parameters'
                  ) &&
                  !(
                    trigger.kind === 'cron' &&
                    [
                      'schedule',
                      'execution',
                      'time zone',
                      'retry config',
                    ].includes(section)
                  ) &&
                  !(
                    (trigger.kind === 'http' || trigger.kind === 'webhook') &&
                    ['authentication', 'request validation'].includes(section)
                  ) &&
                  !(trigger.kind === 'parent' && section === 'allow from') && (
                    <div className="trigger-section-placeholder">
                      <Code2 size={24} />
                      <h4>{section} settings</h4>
                      <p>
                        Configure this trigger&apos;s {section} behavior here.
                      </p>
                    </div>
                  )}

                <details className="advanced-settings">
                  <summary>Advanced Settings</summary>
                  <p>Retry, timeout, and concurrency controls inherit workflow defaults.</p>
                </details>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
