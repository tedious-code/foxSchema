/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/HttpRequestEditor.tsx).
 */
import Ajv from 'ajv';
import { useMemo, useState } from 'react';
import type { CredentialMeta } from '../api/engineClient';
import { compileZodSchema } from '../lib/zodSchema';

/** Mirrors `@foxagent/common` HttpRequestDef — kept local so the designer stays UI-only. */
export const HTTP_KV_OPS = [
  'eq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'or',
  'range',
] as const;
export type HttpKvOp = (typeof HTTP_KV_OPS)[number];

/** UI labels + value hints per operator; serialized as `key[op]=value` (eq = plain). */
const OP_META: Record<HttpKvOp, { label: string; placeholder: string }> = {
  eq: { label: '=', placeholder: 'value or {{vars.x}}' },
  gt: { label: '>', placeholder: 'value' },
  gte: { label: '>=', placeholder: 'value' },
  lt: { label: '<', placeholder: 'value' },
  lte: { label: '<=', placeholder: 'value' },
  in: { label: 'in', placeholder: 'a,b,c' },
  or: { label: 'or', placeholder: 'a,b' },
  range: { label: 'range', placeholder: 'min,max' },
};

export type HttpKv = {
  key: string;
  value: string;
  enabled: boolean;
  op?: HttpKvOp;
  /** Legacy path mapping — no longer editable in the UI, preserved on load. */
  valueFrom?: string;
  keyFrom?: string;
};

export type HttpAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; key: string; value: string; in: 'header' | 'query' }
  | { type: 'credential'; credentialId: string };

export const HTTP_BODY_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'json',
] as const;
export type HttpBodyFieldType = (typeof HTTP_BODY_FIELD_TYPES)[number];

export type HttpBodyField = {
  key: string;
  type: HttpBodyFieldType;
  value: string;
  enabled: boolean;
};

/** Optional JSON Schema — the runtime validates the body against it before sending. */
type BodySchema = Record<string, unknown> | undefined;

/**
 * `schema` is what the runtime enforces; `schemaSource` is the Zod code it was
 * compiled from, kept so the editor can round-trip. Compilation happens only
 * here in the browser — the server never evaluates Zod code.
 */
type BodyValidation = { schema?: BodySchema; schemaSource?: string };

export type HttpBody =
  | { mode: 'none' }
  | ({ mode: 'json'; json: unknown } & BodyValidation)
  | ({ mode: 'raw'; raw: string; contentType: string } & BodyValidation)
  | ({ mode: 'form'; form: HttpKv[] } & BodyValidation)
  | ({ mode: 'fields'; fields: HttpBodyField[] } & BodyValidation);

export type HttpSession = {
  enabled: boolean;
  persistToCredential: boolean;
};

export type HttpTokenRefresh = {
  enabled: boolean;
  url: string;
  method: 'POST' | 'PUT';
  accessTokenPath: string;
  refreshTokenPath?: string;
  expiresInPath: string;
  onStatus: number[];
  skewSeconds: number;
};

export type HttpRequestValue = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  query: HttpKv[];
  headers: HttpKv[];
  auth: HttpAuth;
  body: HttpBody;
  timeoutMs: number;
  variables: Record<string, unknown>;
  session: HttpSession;
  tokenRefresh?: HttpTokenRefresh;
};

export const EMPTY_HTTP_REQUEST: HttpRequestValue = {
  url: 'https://',
  method: 'GET',
  query: [],
  headers: [],
  auth: { type: 'none' },
  body: { mode: 'none' },
  timeoutMs: 30_000,
  variables: {},
  session: { enabled: false, persistToCredential: true },
};

/** Token refresh before the author touches it: off, with the usual OAuth field names. */
const DEFAULT_TOKEN_REFRESH: HttpTokenRefresh = {
  enabled: false,
  url: 'https://',
  method: 'POST',
  accessTokenPath: 'access_token',
  expiresInPath: 'expires_in',
  onStatus: [401],
  skewSeconds: 60,
};

type Tab =
  | 'params'
  | 'headers'
  | 'auth'
  | 'body'
  | 'schema'
  | 'vars'
  | 'session';

interface Props {
  value: HttpRequestValue;
  credentials: CredentialMeta[];
  onChange: (next: HttpRequestValue) => void;
  /** Hide timeout for compact trigger panels. */
  compact?: boolean;
}

const METHODS: HttpRequestValue['method'][] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
];

export function HttpRequestEditor({
  value,
  credentials,
  onChange,
  compact,
}: Props) {
  const [tab, setTab] = useState<Tab>('params');
  const patch = (partial: Partial<HttpRequestValue>) =>
    onChange({ ...value, ...partial });

  const httpCredentials = credentials.filter(
    (c) => c.kind === 'http' || c.kind === 'oauth',
  );

  /** Params → URL query string (auto map). */
  const setQuery = (query: HttpKv[]) => {
    onChange({
      ...value,
      query,
      url: applyQueryToUrl(value.url, query),
    });
  };

  /** URL → Params table (auto map). */
  const setUrl = (url: string) => {
    onChange({
      ...value,
      url,
      query: queryFromUrl(url, value.query),
    });
  };

  return (
    <div className={`http-request-editor${compact ? ' compact' : ''}`}>
      <div className="http-request-line">
        <select data-testid="workflow-http-method"
          value={value.method}
          onChange={(event) =>
            patch({ method: event.target.value as HttpRequestValue['method'] })
          }
        >
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
        <input data-testid="workflow-http-url"
          type="text"
          placeholder="https://api.example.com/users/{{vars.userId}}"
          value={value.url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="hint">
        Templates: <code>{'{{vars.name}}'}</code>,{' '}
        <code>{'{{trigger.field}}'}</code>,{' '}
        <code>{'{{secrets.accessToken}}'}</code>
        {' · '}
        Params auto-map into the URL query string.
      </div>

      <div className="http-request-tabs">
        {(
          [
            ['params', 'Params'],
            ['headers', 'Headers'],
            ['auth', 'Auth'],
            ['body', 'Body'],
            ['schema', 'Schema'],
            ['vars', 'Variables'],
            ['session', 'Session'],
          ] as const
        ).map(([id, label]) => (
          <button data-testid={`workflow-http-tab-${id}`}
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'params' && (
        <KvEditor
          withOp
          rows={value.query}
          onChange={setQuery}
          keyPlaceholder="param"
        />
      )}
      {tab === 'headers' && (
        <KvEditor
          rows={value.headers}
          onChange={(headers) => patch({ headers })}
          keyPlaceholder="Header"
        />
      )}
      {tab === 'auth' && (
        <AuthEditor
          value={value.auth}
          credentials={httpCredentials}
          tokenRefresh={value.tokenRefresh}
          onChange={(auth) => patch({ auth })}
          onTokenRefreshChange={(tokenRefresh) => patch({ tokenRefresh })}
        />
      )}
      {tab === 'body' && (
        <BodyEditor
          value={value.body}
          method={value.method}
          onChange={(body) => patch({ body })}
        />
      )}
      {tab === 'schema' && (
        <BodySchemaEditor
          value={value.body}
          method={value.method}
          onChange={(body) => patch({ body })}
        />
      )}
      {tab === 'vars' && (
        <VariablesEditor
          value={value.variables}
          onChange={(variables) => patch({ variables })}
        />
      )}
      {tab === 'session' && (
        <SessionEditor
          value={value.session}
          onChange={(session) => patch({ session })}
        />
      )}

      {!compact && (
        <>
          <label>Timeout (ms)</label>
          <input data-testid="workflow-http-timeout-ms"
            type="number"
            min={1}
            max={600_000}
            value={value.timeoutMs}
            onChange={(event) =>
              patch({
                timeoutMs: Math.max(1, Number(event.target.value) || 30_000),
              })
            }
          />
        </>
      )}
    </div>
  );
}

function KvEditor({
  rows,
  onChange,
  keyPlaceholder,
  withOp,
}: {
  rows: HttpKv[];
  onChange: (rows: HttpKv[]) => void;
  keyPlaceholder: string;
  /** Show the condition-operator column (query params only). */
  withOp?: boolean;
}) {
  const update = (index: number, next: Partial<HttpKv>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  };
  return (
    <div className="http-kv-editor">
      {withOp && (
        <div className="hint">
          Value supports templates (<code>{'{{vars.x}}'}</code>). Operators
          serialize as <code>key[op]=value</code> — e.g.{' '}
          <code>price[gte]=100</code>, <code>status[in]=a,b</code>;{' '}
          <code>=</code> stays plain <code>key=value</code>.
        </div>
      )}
      {withOp && rows.length > 0 && (
        <div className="http-kv-row with-op http-kv-head">
          <span />
          <span>Key</span>
          <span>Op</span>
          <span>Value</span>
          <span />
        </div>
      )}
      {rows.map((row, index) => {
        const op = row.op ?? 'eq';
        return (
          <div
            key={index}
            className={`http-kv-row${withOp ? ' with-op' : ''}`}
          >
            <input data-testid={`workflow-http-kv-enabled-${index}`}
              type="checkbox"
              checked={row.enabled}
              onChange={(event) =>
                update(index, { enabled: event.target.checked })
              }
              title="Enabled"
            />
            <input data-testid={`workflow-http-kv-key-${index}`}
              type="text"
              placeholder={keyPlaceholder}
              value={row.key}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            {withOp && (
              <select data-testid={`workflow-http-kv-operator-${index}`}
                value={op}
                title="Condition operator"
                onChange={(event) =>
                  update(index, {
                    op:
                      event.target.value === 'eq'
                        ? undefined
                        : (event.target.value as HttpKvOp),
                  })
                }
              >
                {HTTP_KV_OPS.map((option) => (
                  <option key={option} value={option}>
                    {OP_META[option].label}
                  </option>
                ))}
              </select>
            )}
            <input data-testid={`workflow-http-kv-value-${index}`}
              type="text"
              placeholder={
                withOp ? OP_META[op].placeholder : 'value or {{vars.x}}'
              }
              value={row.value}
              onChange={(event) =>
                update(index, {
                  value: event.target.value,
                  // Editing the value takes over from a legacy path mapping.
                  ...(row.valueFrom ? { valueFrom: undefined } : {}),
                })
              }
            />
            <button data-testid={`workflow-http-kv-remove-${index}`}
              type="button"
              className="linkish"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        );
      })}
      <button data-testid="workflow-http-kv-add"
        type="button"
        className="linkish"
        onClick={() =>
          onChange([...rows, { key: '', value: '', enabled: true }])
        }
      >
        + Add
      </button>
    </div>
  );
}

function AuthEditor({
  value,
  credentials,
  tokenRefresh,
  onChange,
  onTokenRefreshChange,
}: {
  value: HttpAuth;
  credentials: CredentialMeta[];
  tokenRefresh?: HttpTokenRefresh;
  onChange: (auth: HttpAuth) => void;
  onTokenRefreshChange: (refresh: HttpTokenRefresh | undefined) => void;
}) {
  const refresh = tokenRefresh ?? DEFAULT_TOKEN_REFRESH;

  return (
    <div className="http-auth-editor">
      <label>Type</label>
      <select data-testid="workflow-http-auth-type"
        value={value.type}
        onChange={(event) => {
          const type = event.target.value as HttpAuth['type'];
          switch (type) {
            case 'none':
              onChange({ type });
              break;
            case 'bearer':
              onChange({ type, token: '{{secrets.accessToken}}' });
              break;
            case 'basic':
              onChange({ type, username: '', password: '' });
              break;
            case 'apiKey':
              onChange({ type, key: '', value: '', in: 'header' });
              break;
            case 'credential':
              onChange({ type, credentialId: credentials[0]?.id ?? '' });
              break;
          }
        }}
      >
        <option value="none">No auth</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Basic</option>
        <option value="apiKey">API key</option>
        <option value="credential">Stored credential</option>
      </select>

      {value.type === 'bearer' && (
        <>
          <label>Token</label>
          <input data-testid="workflow-http-auth-token"
            type="text"
            placeholder="token or {{secrets.accessToken}}"
            value={value.token}
            onChange={(event) =>
              onChange({ ...value, token: event.target.value })
            }
          />
        </>
      )}
      {value.type === 'basic' && (
        <>
          <label>Username</label>
          <input data-testid="workflow-http-auth-username"
            type="text"
            value={value.username}
            onChange={(event) =>
              onChange({ ...value, username: event.target.value })
            }
          />
          <label>Password</label>
          <input data-testid="workflow-http-auth-password"
            type="password"
            value={value.password}
            onChange={(event) =>
              onChange({ ...value, password: event.target.value })
            }
          />
        </>
      )}
      {value.type === 'apiKey' && (
        <>
          <label>Key</label>
          <input data-testid="workflow-http-auth-key"
            type="text"
            value={value.key}
            onChange={(event) => onChange({ ...value, key: event.target.value })}
          />
          <label>Value</label>
          <input data-testid="workflow-http-auth-value"
            type="text"
            value={value.value}
            onChange={(event) =>
              onChange({ ...value, value: event.target.value })
            }
          />
          <label>Add to</label>
          <select data-testid="workflow-http-auth-placement"
            value={value.in}
            onChange={(event) =>
              onChange({
                ...value,
                in: event.target.value as 'header' | 'query',
              })
            }
          >
            <option value="header">Header</option>
            <option value="query">Query</option>
          </select>
        </>
      )}
      {value.type === 'credential' && (
        <>
          <label>Credential</label>
          <select data-testid="workflow-http-auth-credential"
            value={value.credentialId}
            onChange={(event) =>
              onChange({ ...value, credentialId: event.target.value })
            }
          >
            <option value="">Select…</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </select>
          <div className="hint">
            Store <code>accessToken</code>, <code>refreshToken</code>,{' '}
            <code>expiresAt</code>, and session <code>cookies</code> on the
            credential secret.
          </div>
        </>
      )}

      <label className="checkbox-row">
        <input data-testid="workflow-http-token-refresh"
          type="checkbox"
          checked={refresh.enabled}
          onChange={(event) =>
            onTokenRefreshChange({
              ...refresh,
              enabled: event.target.checked,
            })
          }
        />
        Auto-refresh access token
      </label>
      {refresh.enabled && (
        <>
          <label>Refresh URL</label>
          <input data-testid="workflow-http-token-refresh-url"
            type="text"
            value={refresh.url}
            onChange={(event) =>
              onTokenRefreshChange({ ...refresh, url: event.target.value })
            }
          />
          <label>Access token path</label>
          <input data-testid="workflow-http-token-refresh-access-path"
            type="text"
            value={refresh.accessTokenPath}
            onChange={(event) =>
              onTokenRefreshChange({
                ...refresh,
                accessTokenPath: event.target.value,
              })
            }
          />
          <label>Refresh token path (optional)</label>
          <input data-testid="workflow-http-token-refresh-refresh-path"
            type="text"
            value={refresh.refreshTokenPath ?? ''}
            onChange={(event) =>
              onTokenRefreshChange({
                ...refresh,
                refreshTokenPath: event.target.value || undefined,
              })
            }
          />
          <label>Skew seconds (proactive refresh)</label>
          <input data-testid="workflow-http-token-refresh-skew"
            type="number"
            min={0}
            value={refresh.skewSeconds}
            onChange={(event) =>
              onTokenRefreshChange({
                ...refresh,
                skewSeconds: Math.max(0, Number(event.target.value) || 0),
              })
            }
          />
          <div className="hint">
            Refreshes when <code>expiresAt</code> is near, or on HTTP 401, then
            retries. Uses <code>{'{{secrets.refreshToken}}'}</code> in the
            default body.
          </div>
        </>
      )}
    </div>
  );
}

function SessionEditor({
  value,
  onChange,
}: {
  value: HttpSession;
  onChange: (session: HttpSession) => void;
}) {
  return (
    <div className="http-session-editor">
      <label className="checkbox-row">
        <input data-testid="workflow-http-session"
          type="checkbox"
          checked={value.enabled}
          onChange={(event) =>
            onChange({ ...value, enabled: event.target.checked })
          }
        />
        Reuse cookie session
      </label>
      <div className="hint">
        Captures <code>Set-Cookie</code> and sends <code>Cookie</code> on later
        requests so the app does not need to re-login.
      </div>
      <label className="checkbox-row">
        <input data-testid="workflow-http-session-persist"
          type="checkbox"
          checked={value.persistToCredential}
          disabled={!value.enabled}
          onChange={(event) =>
            onChange({ ...value, persistToCredential: event.target.checked })
          }
        />
        Persist cookies on credential
      </label>
      <div className="hint">
        Requires Auth → Stored credential. Cookies survive process restarts.
      </div>
    </div>
  );
}

function VariablesEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (variables: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value ?? {}, null, 2));
  return (
    <div className="http-vars-editor">
      <div className="hint">
        Static variables available as <code>{'{{vars.key}}'}</code> or{' '}
        <code>{'{{key}}'}</code>. Trigger payload is{' '}
        <code>{'{{trigger.*}}'}</code>.
      </div>
      <textarea data-testid="workflow-http-variables"
        rows={8}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          try {
            const parsed = JSON.parse(event.target.value || '{}') as Record<
              string,
              unknown
            >;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              onChange(parsed);
            }
          } catch {
            // keep editing until valid JSON
          }
        }}
      />
    </div>
  );
}

// One lenient validator for live feedback — mirrors the runtime's ajv config.
const bodyAjv = new Ajv({ allErrors: true, strict: false });

/** Check `data` against `schema`, phrased for the editor's verdict line. */
function schemaVerdict(
  schema: Record<string, unknown>,
  data: unknown,
  okMessage: string,
): { ok: boolean; message: string } {
  try {
    const validate = bodyAjv.compile(schema);
    return validate(data)
      ? { ok: true, message: okMessage }
      : {
          ok: false,
          message: bodyAjv.errorsText(validate.errors, { separator: '; ' }),
        };
  } catch (error) {
    return { ok: false, message: `schema: ${(error as Error).message}` };
  }
}

/** Decompose a JSON object into typed builder rows (nested values → json). */
function fieldsFromJson(json: unknown): HttpBodyField[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  return Object.entries(json as Record<string, unknown>).map(([key, v]) => {
    if (typeof v === 'string') {
      return { key, type: 'string' as const, value: v, enabled: true };
    }
    if (typeof v === 'number') {
      return { key, type: 'number' as const, value: String(v), enabled: true };
    }
    if (typeof v === 'boolean') {
      return { key, type: 'boolean' as const, value: String(v), enabled: true };
    }
    return {
      key,
      type: 'json' as const,
      value: JSON.stringify(v, null, 2),
      enabled: true,
    };
  });
}

/** Compose builder rows into the JSON object (mirrors runtime composeBodyFields). */
function composeFields(
  fields: HttpBodyField[],
): { value: Record<string, unknown> } | { error: string } {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.enabled || !field.key) continue;
    switch (field.type) {
      case 'string':
        out[field.key] = field.value;
        break;
      case 'number': {
        const parsed = Number(field.value);
        if (field.value.trim() === '' || Number.isNaN(parsed)) {
          return { error: `"${field.key}": "${field.value}" is not a number` };
        }
        out[field.key] = parsed;
        break;
      }
      case 'boolean':
        if (field.value !== 'true' && field.value !== 'false') {
          return { error: `"${field.key}": expected true or false` };
        }
        out[field.key] = field.value === 'true';
        break;
      case 'json':
        try {
          out[field.key] = JSON.parse(field.value || 'null') as unknown;
        } catch {
          return { error: `"${field.key}": value is not valid JSON` };
        }
        break;
    }
  }
  return { value: out };
}

/** Current body as the JSON payload the schema would check (or why it can't be). */
function bodyPayload(value: HttpBody): { data: unknown } | { error: string } | null {
  switch (value.mode) {
    case 'fields': {
      const composed = composeFields(value.fields);
      return 'error' in composed ? composed : { data: composed.value };
    }
    case 'json':
      return { data: value.json ?? null };
    case 'raw':
      try {
        return { data: JSON.parse(value.raw || 'null') as unknown };
      } catch {
        return { error: 'raw body is not valid JSON' };
      }
    case 'form':
      // Mirrors the runtime: the schema sees `{key: value}` of enabled rows.
      return {
        data: Object.fromEntries(
          value.form
            .filter((row) => row.enabled && row.key)
            .map((row) => [row.key, row.value]),
        ),
      };
    default:
      return null;
  }
}

function bodySchemaOf(value: HttpBody): BodySchema {
  return value.mode === 'none' ? undefined : value.schema;
}

function bodySchemaSourceOf(value: HttpBody): string {
  return value.mode === 'none' ? '' : (value.schemaSource ?? '');
}

function BodyEditor({
  value,
  method,
  onChange,
}: {
  value: HttpBody;
  method: HttpRequestValue['method'];
  onChange: (body: HttpBody) => void;
}) {
  const [jsonText, setJsonText] = useState(() =>
    value.mode === 'json' ? JSON.stringify(value.json ?? null, null, 2) : '',
  );

  // Carried across mode switches; authored in the Schema tab.
  const schema = bodySchemaOf(value);

  if (method === 'GET' || method === 'HEAD') {
    return <div className="hint">GET/HEAD requests do not send a body.</div>;
  }

  /** Switch mode, converting the current content so nothing is lost. */
  const switchMode = (mode: HttpBody['mode']) => {
    if (mode === value.mode) return;
    const current = bodyPayload(value);
    const carried = 'data' in (current ?? {}) ? (current as { data: unknown }).data : undefined;
    // Schema + its Zod source travel across every body shape.
    const source = bodySchemaSourceOf(value);
    const validation = {
      ...(schema ? { schema } : {}),
      ...(source ? { schemaSource: source } : {}),
    };
    switch (mode) {
      case 'none':
        onChange({ mode });
        break;
      case 'form':
        onChange({ mode, form: [], ...validation });
        break;
      case 'fields':
        onChange({ mode, fields: fieldsFromJson(carried), ...validation });
        break;
      case 'json': {
        const json = carried ?? {};
        setJsonText(JSON.stringify(json, null, 2));
        onChange({ mode, json, ...validation });
        break;
      }
      case 'raw':
        onChange({
          mode,
          raw: JSON.stringify(carried ?? {}, null, 2),
          contentType: 'application/json',
          ...validation,
        });
        break;
    }
  };

  const patchField = (index: number, patch: Partial<HttpBodyField>) => {
    if (value.mode !== 'fields') return;
    onChange({
      ...value,
      fields: value.fields.map((field, i) =>
        i === index ? { ...field, ...patch } : field,
      ),
    });
  };

  return (
    <div className="http-body-editor">
      <label>Mode</label>
      <select data-testid="workflow-http-body-mode"
        value={value.mode}
        onChange={(event) => switchMode(event.target.value as HttpBody['mode'])}
      >
        <option value="none">None</option>
        <option value="fields">JSON builder (typed attributes)</option>
        <option value="json">JSON</option>
        <option value="raw">Raw</option>
        <option value="form">x-www-form-urlencoded</option>
      </select>
      {(value.mode === 'fields' || value.mode === 'json' || value.mode === 'raw') && (
        <div className="hint">
          Switching between builder, JSON, and Raw converts the content — the
          schema travels with it.
        </div>
      )}

      {value.mode === 'fields' && (
        <div className="http-kv-editor">
          {value.fields.length > 0 && (
            <div className="http-kv-row with-op http-kv-head">
              <span />
              <span>Attribute</span>
              <span>Type</span>
              <span>Value</span>
              <span />
            </div>
          )}
          {value.fields.map((field, index) => (
            <div key={index} className="http-kv-row with-op">
              <input data-testid={`workflow-http-body-field-enabled-${index}`}
                type="checkbox"
                checked={field.enabled}
                onChange={(event) =>
                  patchField(index, { enabled: event.target.checked })
                }
                title="Enabled"
              />
              <input data-testid={`workflow-http-body-field-key-${index}`}
                type="text"
                placeholder="attribute"
                value={field.key}
                onChange={(event) => patchField(index, { key: event.target.value })}
              />
              <select data-testid={`workflow-http-body-field-type-${index}`}
                value={field.type}
                title="Value type"
                onChange={(event) =>
                  patchField(index, {
                    type: event.target.value as HttpBodyFieldType,
                  })
                }
              >
                {HTTP_BODY_FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input data-testid={`workflow-http-body-field-value-${index}`}
                type="text"
                placeholder={
                  field.type === 'boolean'
                    ? 'true / false'
                    : field.type === 'json'
                      ? '{"nested": 1} or [1,2]'
                      : 'value or {{vars.x}}'
                }
                value={field.value}
                onChange={(event) =>
                  patchField(index, { value: event.target.value })
                }
              />
              <button data-testid={`workflow-http-body-field-remove-${index}`}
                type="button"
                className="linkish"
                onClick={() =>
                  onChange({
                    ...value,
                    fields: value.fields.filter((_, i) => i !== index),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button data-testid="workflow-http-body-field-add"
            type="button"
            className="linkish"
            onClick={() =>
              onChange({
                ...value,
                fields: [
                  ...value.fields,
                  { key: '', type: 'string', value: '', enabled: true },
                ],
              })
            }
          >
            + Add attribute
          </button>
        </div>
      )}

      {value.mode === 'json' && (
        <textarea data-testid="workflow-http-body-json"
          rows={6}
          value={jsonText}
          onChange={(event) => {
            setJsonText(event.target.value);
            try {
              onChange({
                ...value,
                json: JSON.parse(event.target.value || 'null'),
              });
            } catch {
              // keep typing until valid JSON
            }
          }}
        />
      )}
      {value.mode === 'raw' && (
        <>
          <label>Content-Type</label>
          <input data-testid="workflow-http-body-content-type"
            type="text"
            value={value.contentType}
            onChange={(event) =>
              onChange({ ...value, contentType: event.target.value })
            }
          />
          <textarea data-testid="workflow-http-body-raw"
            rows={6}
            value={value.raw}
            onChange={(event) =>
              onChange({ ...value, raw: event.target.value })
            }
          />
        </>
      )}
      {value.mode === 'form' && (
        <KvEditor
          rows={value.form}
          onChange={(form) => onChange({ mode: 'form', form })}
          keyPlaceholder="field"
        />
      )}

    </div>
  );
}

/**
 * Body validation, split out of the Body tab: author the contract in Zod, see
 * the JSON Schema it compiles to, and try it against sample data. Lives in its
 * own tab so the Body tab stays about *composing* the request.
 */
function BodySchemaEditor({
  value,
  method,
  onChange,
}: {
  value: HttpBody;
  method: HttpRequestValue['method'];
  onChange: (body: HttpBody) => void;
}) {
  const [zodText, setZodText] = useState(() => bodySchemaSourceOf(value));
  const [zodError, setZodError] = useState<string | null>(null);
  const [testText, setTestText] = useState('');

  const schema = bodySchemaOf(value);

  // Live verdict on the body currently composed in the Body tab. The payload is
  // derived inside the memo: built outside, it was a new object every render,
  // so the memo never hit and ajv recompiled the schema on each keystroke.
  const validation = useMemo(() => {
    const payload = bodyPayload(value);
    if (!schema || !payload) return null;
    if ('error' in payload) return { ok: false, message: payload.error };
    return schemaVerdict(schema, payload.data, 'Body matches the schema.');
  }, [schema, value]);

  // Second section: paste sample data, see the same verdict the runtime gives.
  const testResult = useMemo(() => {
    if (!schema || !testText.trim()) return null;
    let data: unknown;
    try {
      data = JSON.parse(testText);
    } catch {
      return { ok: false, message: 'Test data is not valid JSON.' };
    }
    return schemaVerdict(schema, data, 'Test data passes the schema.');
  }, [schema, testText]);

  if (method === 'GET' || method === 'HEAD') {
    return (
      <div className="hint">
        GET/HEAD requests send no body, so no body schema is enforced.
      </div>
    );
  }
  if (value.mode === 'none') {
    return (
      <div className="hint">
        Pick a body mode in the <strong>Body</strong> tab to validate it.
      </div>
    );
  }

  const patchZod = (code: string) => {
    setZodText(code);
    const compiled = compileZodSchema(code);
    if (compiled === null) {
      setZodError(null);
      onChange({ ...value, schema: undefined, schemaSource: undefined });
      return;
    }
    if ('error' in compiled) {
      // Keep the last good schema until the code compiles again.
      setZodError(compiled.error);
      return;
    }
    setZodError(null);
    onChange({ ...value, schema: compiled.schema, schemaSource: code });
  };

  return (
    <div className="body-validation">
      <label>
        Validation schema (
        <a href="https://zod.dev" target="_blank" rel="noreferrer">
          Zod
        </a>
        , optional)
      </label>
      <textarea data-testid="workflow-http-body-schema"
        rows={5}
        className="code"
        spellCheck={false}
        placeholder="z.object({ orderId: z.number(), note: z.string().optional() })"
        value={zodText}
        onChange={(event) => patchZod(event.target.value)}
      />
      {zodError ? (
        <div className="field-error">Zod: {zodError}</div>
      ) : validation ? (
        <div className={validation.ok ? 'hint body-schema-ok' : 'field-error'}>
          {validation.ok ? '✓ ' : ''}
          {validation.message}
        </div>
      ) : (
        <small className="form-help">
          Compiled to JSON Schema and enforced in the app before the request is
          sent — a body that fails never calls the API.
        </small>
      )}
      {!zodText.trim() && schema && (
        <small className="form-help">
          This body has a stored JSON Schema (authored earlier) — writing Zod
          here replaces it.
        </small>
      )}
      {schema && (
        <details className="body-schema-preview">
          <summary>Generated JSON Schema</summary>
          <pre>{JSON.stringify(schema, null, 2)}</pre>
        </details>
      )}

      {schema && (
        <>
          <label>Test with sample data (JSON)</label>
          <textarea data-testid="workflow-http-body-schema-sample"
            rows={4}
            className="code"
            spellCheck={false}
            placeholder='{"orderId": 42}'
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
          />
          {testResult ? (
            <div className={testResult.ok ? 'hint body-schema-ok' : 'field-error'}>
              {testResult.ok ? '✓ ' : ''}
              {testResult.message}
            </div>
          ) : (
            <small className="form-help">
              Paste a sample payload to try the schema without sending anything.
            </small>
          )}
        </>
      )}
    </div>
  );
}

/** Normalize pipe/trigger JSON into the editor value (legacy Record headers ok). */
export function toHttpRequestValue(input: unknown): HttpRequestValue {
  if (!input || typeof input !== 'object') return { ...EMPTY_HTTP_REQUEST };
  const raw = input as Record<string, unknown>;
  const source =
    raw.request && typeof raw.request === 'object'
      ? (raw.request as Record<string, unknown>)
      : raw;

  return {
    url: typeof source.url === 'string' ? source.url : EMPTY_HTTP_REQUEST.url,
    method: isMethod(source.method) ? source.method : 'GET',
    query: coerceKv(source.query),
    headers: coerceKv(source.headers),
    auth: coerceAuth(source.auth),
    body: coerceBody(source.body),
    timeoutMs:
      typeof source.timeoutMs === 'number'
        ? source.timeoutMs
        : EMPTY_HTTP_REQUEST.timeoutMs,
    variables:
      source.variables && typeof source.variables === 'object'
        ? (source.variables as Record<string, unknown>)
        : {},
    session: coerceSession(source.session),
    tokenRefresh: coerceTokenRefresh(source.tokenRefresh),
  };
}

function coerceKv(value: unknown): HttpKv[] {
  if (Array.isArray(value)) {
    return value
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        key: String(row.key ?? ''),
        value: String(row.value ?? ''),
        enabled: row.enabled !== false,
        ...(HTTP_KV_OPS.includes(row.op as HttpKvOp) && row.op !== 'eq'
          ? { op: row.op as HttpKvOp }
          : {}),
        ...(typeof row.valueFrom === 'string' ? { valueFrom: row.valueFrom } : {}),
        ...(typeof row.keyFrom === 'string' ? { keyFrom: row.keyFrom } : {}),
      }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => ({
        key,
        value: String(entry ?? ''),
        enabled: true,
      }),
    );
  }
  return [];
}

function coerceAuth(value: unknown): HttpAuth {
  if (!value || typeof value !== 'object') return { type: 'none' };
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case 'bearer':
      return { type: 'bearer', token: String(raw.token ?? '') };
    case 'basic':
      return {
        type: 'basic',
        username: String(raw.username ?? ''),
        password: String(raw.password ?? ''),
      };
    case 'apiKey':
      return {
        type: 'apiKey',
        key: String(raw.key ?? ''),
        value: String(raw.value ?? ''),
        in: raw.in === 'query' ? 'query' : 'header',
      };
    case 'credential':
      return {
        type: 'credential',
        credentialId: String(raw.credentialId ?? ''),
      };
    default:
      return { type: 'none' };
  }
}

function coerceBody(value: unknown): HttpBody {
  if (value == null) return { mode: 'none' };
  if (typeof value === 'object' && 'mode' in value) {
    // Hand-authored configs (raw JSON editor) may declare a mode without its
    // payload — normalize so BodyEditor never dereferences a missing array.
    const raw = value as Record<string, unknown> & { mode: string };
    const validation: BodyValidation = {
      ...(raw.schema && typeof raw.schema === 'object' && !Array.isArray(raw.schema)
        ? { schema: raw.schema as Record<string, unknown> }
        : {}),
      ...(typeof raw.schemaSource === 'string'
        ? { schemaSource: raw.schemaSource }
        : {}),
    };
    switch (raw.mode) {
      case 'fields':
        return {
          mode: 'fields',
          fields: Array.isArray(raw.fields) ? (raw.fields as HttpBodyField[]) : [],
          ...validation,
        };
      case 'form':
        return {
          mode: 'form',
          form: Array.isArray(raw.form) ? (raw.form as HttpKv[]) : [],
          ...validation,
        };
      case 'raw':
        return {
          mode: 'raw',
          raw: typeof raw.raw === 'string' ? raw.raw : '',
          contentType:
            typeof raw.contentType === 'string' ? raw.contentType : 'text/plain',
          ...validation,
        };
      case 'json':
        return { mode: 'json', json: raw.json, ...validation };
      default:
        return { mode: 'none' };
    }
  }
  if (typeof value === 'string') {
    return { mode: 'raw', raw: value, contentType: 'text/plain' };
  }
  return { mode: 'json', json: value };
}

function coerceSession(value: unknown): HttpSession {
  if (!value || typeof value !== 'object') {
    return { ...EMPTY_HTTP_REQUEST.session };
  }
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    persistToCredential: raw.persistToCredential !== false,
  };
}

function coerceTokenRefresh(value: unknown): HttpTokenRefresh | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    url: typeof raw.url === 'string' ? raw.url : DEFAULT_TOKEN_REFRESH.url,
    method: raw.method === 'PUT' ? 'PUT' : 'POST',
    accessTokenPath:
      typeof raw.accessTokenPath === 'string'
        ? raw.accessTokenPath
        : DEFAULT_TOKEN_REFRESH.accessTokenPath,
    refreshTokenPath:
      typeof raw.refreshTokenPath === 'string'
        ? raw.refreshTokenPath
        : undefined,
    expiresInPath:
      typeof raw.expiresInPath === 'string'
        ? raw.expiresInPath
        : DEFAULT_TOKEN_REFRESH.expiresInPath,
    onStatus: Array.isArray(raw.onStatus)
      ? raw.onStatus.map(Number).filter(Number.isFinite)
      : [...DEFAULT_TOKEN_REFRESH.onStatus],
    skewSeconds:
      typeof raw.skewSeconds === 'number'
        ? raw.skewSeconds
        : DEFAULT_TOKEN_REFRESH.skewSeconds,
  };
}

function isMethod(value: unknown): value is HttpRequestValue['method'] {
  return (
    typeof value === 'string' &&
    METHODS.includes(value as HttpRequestValue['method'])
  );
}

/** Split base URL from `?query` without requiring a parseable absolute URL. */
export function splitUrlAndQuery(url: string): { base: string; search: string } {
  const hash = url.indexOf('#');
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const hashPart = hash === -1 ? '' : url.slice(hash);
  const q = withoutHash.indexOf('?');
  if (q === -1) return { base: url, search: '' };
  return {
    base: withoutHash.slice(0, q) + hashPart,
    search: withoutHash.slice(q + 1),
  };
}

/** Encode a query part but keep `{{templates}}` and `[op]` brackets readable. */
function encodeQueryPart(value: string): string {
  return encodeURIComponent(value)
    .replace(/%7B%7B/gi, '{{')
    .replace(/%7D%7D/gi, '}}')
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']');
}

/** Split a URL query key of the form `name[op]` back into key + operator. */
function splitOpKey(key: string): { key: string; op?: HttpKvOp } {
  const match = /^(.*)\[([a-z]+)\]$/.exec(key);
  if (match && HTTP_KV_OPS.includes(match[2] as HttpKvOp) && match[2] !== 'eq') {
    return { key: match[1]!, op: match[2] as HttpKvOp };
  }
  return { key };
}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Write enabled query rows into the URL (Params → URL). */
export function applyQueryToUrl(url: string, query: HttpKv[]): string {
  const { base } = splitUrlAndQuery(url);
  const baseNoHash = base.includes('#') ? base.slice(0, base.indexOf('#')) : base;
  const hash = base.includes('#') ? base.slice(base.indexOf('#')) : '';
  const parts = query
    .filter((row) => row.enabled && row.key.trim().length > 0)
    .map((row) => {
      const op = row.op && row.op !== 'eq' ? `[${row.op}]` : '';
      const key = `${encodeQueryPart(row.key.trim())}${op}`;
      // Mapped rows keep an empty value in the URL; runtime fills from path.
      const value = row.valueFrom ? '' : encodeQueryPart(row.value);
      return `${key}=${value}`;
    });
  return parts.length > 0
    ? `${baseNoHash}?${parts.join('&')}${hash}`
    : `${baseNoHash}${hash}`;
}

/** Parse URL query into rows (URL → Params), preserving valueFrom mappings. */
export function queryFromUrl(url: string, existing: HttpKv[]): HttpKv[] {
  const { search } = splitUrlAndQuery(url);
  const byKey = new Map(existing.map((row) => [row.key, row]));
  const next: HttpKv[] = [];
  const seen = new Set<string>();

  if (search) {
    for (const part of search.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const rawKey = decodeQueryPart(eq === -1 ? part : part.slice(0, eq));
      const rawValue = decodeQueryPart(eq === -1 ? '' : part.slice(eq + 1));
      if (!rawKey) continue;
      const { key, op } = splitOpKey(rawKey);
      if (!key) continue;
      const prev = byKey.get(key);
      seen.add(key);
      next.push({
        key,
        value: prev?.valueFrom ? '' : rawValue,
        enabled: prev?.enabled ?? true,
        ...(op ? { op } : {}),
        ...(prev?.valueFrom ? { valueFrom: prev.valueFrom } : {}),
        ...(prev?.keyFrom ? { keyFrom: prev.keyFrom } : {}),
      });
    }
  }

  // Keep mapped-only rows that aren't represented in the URL yet.
  for (const row of existing) {
    if (row.valueFrom && row.key && !seen.has(row.key)) {
      next.push(row);
    }
  }
  return next;
}
