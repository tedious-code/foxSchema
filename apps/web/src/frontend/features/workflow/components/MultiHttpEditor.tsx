/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/MultiHttpEditor.tsx).
 */
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CredentialMeta } from '../api/engineClient';
import {
  EMPTY_HTTP_REQUEST,
  HttpRequestEditor,
  toHttpRequestValue,
  type HttpRequestValue,
} from './HttpRequestEditor';
import { Button, Input, Label, Select } from './controls';

export type MultiHttpEndpoint = HttpRequestValue & {
  id: string;
  recordsPath?: string;
};

type MultiHttpConfig = {
  endpoints: MultiHttpEndpoint[];
  executionMode?: 'parallel' | 'linear';
  outputMode?: 'records' | 'merge';
  concurrency?: number;
  tagField?: string;
  onError?: 'fail' | 'skip';
  batchSize?: number;
};

interface Props {
  config: Record<string, unknown>;
  credentials: CredentialMeta[];
  onChange: (config: Record<string, unknown>) => void;
}

function asEndpoints(value: unknown): MultiHttpEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value.map((row, index) => {
    const item =
      row && typeof row === 'object' && !Array.isArray(row)
        ? (row as Record<string, unknown>)
        : {};
    const request = toHttpRequestValue(item);
    return {
      ...request,
      id:
        typeof item.id === 'string' && item.id
          ? item.id
          : `endpoint-${index + 1}`,
      recordsPath:
        typeof item.recordsPath === 'string' ? item.recordsPath : '',
    };
  });
}

function emptyEndpoint(index: number): MultiHttpEndpoint {
  return {
    ...EMPTY_HTTP_REQUEST,
    id: `endpoint-${index}`,
    recordsPath: '',
  };
}

export function MultiHttpEditor({ config, credentials, onChange }: Props) {
  const endpoints = asEndpoints(config.endpoints);
  const executionMode = config.executionMode === 'linear' ? 'linear' : 'parallel';
  const outputMode = config.outputMode === 'merge' ? 'merge' : 'records';
  const concurrency =
    typeof config.concurrency === 'number' ? config.concurrency : 0;
  const tagField =
    typeof config.tagField === 'string' ? config.tagField : '_endpoint';
  const onError = config.onError === 'skip' ? 'skip' : 'fail';
  const batchSize =
    typeof config.batchSize === 'number' ? config.batchSize : 1000;
  const [expanded, setExpanded] = useState<Record<number, boolean>>({ 0: true });

  const patch = (next: Partial<MultiHttpConfig>) => {
    onChange({
      ...config,
      endpoints,
      executionMode,
      outputMode,
      concurrency,
      tagField,
      onError,
      batchSize,
      ...next,
    });
  };

  useEffect(() => {
    if (Array.isArray(config.endpoints)) return;
    onChange({
      ...config,
      endpoints: [emptyEndpoint(1)],
      executionMode: 'parallel',
      outputMode: 'records',
      concurrency: 0,
      tagField: '_endpoint',
      onError: 'fail',
      batchSize: 1000,
    });
  }, [config, onChange]);

  const updateEndpoint = (index: number, next: MultiHttpEndpoint) => {
    patch({
      endpoints: endpoints.map((row, i) => (i === index ? next : row)),
    });
  };

  const patchEndpointMeta = (
    index: number,
    meta: Partial<Pick<MultiHttpEndpoint, 'id' | 'recordsPath'>>,
  ) => {
    const current = endpoints[index];
    if (!current) return;
    updateEndpoint(index, { ...current, ...meta });
  };

  return (
    <div className="multi-http-editor">
      <p className="hint">
        {outputMode === 'merge'
          ? 'Calls multiple endpoints with different URLs and merges all response payloads into a single record keyed by endpoint ID, ready for downstream Script transformation.'
          : 'Runs multiple endpoints and emits individual records (tagged with the endpoint id). Each endpoint supports the full HTTP request (params, headers, auth, body, session).'}
      </p>

      {endpoints.length === 0 && (
        <p className="empty">No endpoints yet — add at least one URL.</p>
      )}

      {endpoints.map((endpoint, index) => {
        const open = expanded[index] !== false;
        const { id, recordsPath, ...request } = endpoint;
        return (
          // Keyed by position, not by `endpoint.id`: the Id field below edits
          // that id, so keying on it remounted the row — and dropped focus —
          // after every keystroke.
          <div key={index} className="multi-http-row">
            <div className="multi-http-row-head">
              <button data-testid={`workflow-multi-http-toggle-${index}`}
                type="button"
                className="multi-http-toggle"
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [index]: !open,
                  }))
                }
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <strong>
                  {endpoint.id || `Endpoint ${index + 1}`}
                </strong>
                <span className="multi-http-method">
                  {endpoint.method ?? 'GET'}
                </span>
              </button>
              <Button
                data-testid={`workflow-multi-http-remove-${index}`}
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove endpoint"
                onClick={() =>
                  patch({
                    endpoints: endpoints.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 />
              </Button>
            </div>

            {open && (
              <>
                <div className="multi-http-row-grid">
                  <div>
                    <Label>Id</Label>
                    <Input
                      data-testid={`workflow-multi-http-id-${index}`}
                      value={id}
                      onChange={(event) =>
                        patchEndpointMeta(index, { id: event.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label>Records path</Label>
                    <Input
                      data-testid={`workflow-multi-http-records-path-${index}`}
                      value={recordsPath ?? ''}
                      placeholder={outputMode === 'merge' ? 'Optional (default: entire response body)' : 'data.items'}
                      onChange={(event) =>
                        patchEndpointMeta(index, {
                          recordsPath: event.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                <HttpRequestEditor
                  compact
                  value={request}
                  credentials={credentials}
                  onChange={(nextRequest) =>
                    updateEndpoint(index, {
                      ...nextRequest,
                      id,
                      recordsPath,
                    })
                  }
                />
              </>
            )}
          </div>
        );
      })}

      <Button
        data-testid="workflow-multi-http-add-endpoint"
        type="button"
        onClick={() => {
          const nextIndex = endpoints.length;
          setExpanded((current) => ({ ...current, [nextIndex]: true }));
          patch({
            endpoints: [...endpoints, emptyEndpoint(endpoints.length + 1)],
          });
        }}
      >
        <Plus /> Add endpoint
      </Button>

      <Label>Output mode</Label>
      <Select
        data-testid="workflow-multi-http-output-mode"
        value={outputMode}
        onChange={(event) =>
          patch({ outputMode: event.target.value as 'records' | 'merge' })
        }
      >
        <option value="records">Individual records (Flattened per endpoint)</option>
        <option value="merge">Merged payload (Single record for Script transform)</option>
      </Select>

      <Label>Execution mode</Label>
      <Select
        data-testid="workflow-multi-http-execution-mode"
        value={executionMode}
        onChange={(event) =>
          patch({ executionMode: event.target.value as 'parallel' | 'linear' })
        }
      >
        <option value="parallel">Parallel (Concurrent)</option>
        <option value="linear">Linear (Sequential, one by one)</option>
      </Select>

      {executionMode === 'parallel' && (
        <>
          <Label>Concurrency limit (0 = all at once)</Label>
          <Input
            data-testid="workflow-multi-http-concurrency"
            type="number"
            min={0}
            max={64}
            value={concurrency}
            onChange={(event) =>
              patch({ concurrency: Math.max(0, Number(event.target.value) || 0) })
            }
          />
        </>
      )}

      <Label>On error</Label>
      <Select
        data-testid="workflow-multi-http-on-error"
        value={onError}
        onChange={(event) =>
          patch({ onError: event.target.value as 'fail' | 'skip' })
        }
      >
        <option value="fail">Stop to failure (Fail pipe)</option>
        <option value="skip">Except failure (Continue with other endpoints)</option>
      </Select>

      {outputMode === 'records' && (
        <>
          <Label>Tag field</Label>
          <Input
            data-testid="workflow-multi-http-tag-field"
            value={tagField}
            onChange={(event) =>
              patch({ tagField: event.target.value || '_endpoint' })
            }
          />

          <Label>Batch size</Label>
          <Input
            data-testid="workflow-multi-http-batch-size"
            type="number"
            min={1}
            max={100000}
            value={batchSize}
            onChange={(event) =>
              patch({
                batchSize: Math.max(1, Number(event.target.value) || 1000),
              })
            }
          />
        </>
      )}
    </div>
  );
}
