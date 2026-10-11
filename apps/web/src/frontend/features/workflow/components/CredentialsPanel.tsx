/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine credentials: list, create and delete. Secret values go to the engine
 * and never come back to the browser.
 */
import { KeyRound, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuthStore } from '@/platform/authStore';
import { api, type CredentialMeta } from '../api/engineClient';
import { toast } from '../lib/notify';
import { Badge, Button, Input, Label, Select } from './controls';

const KINDS = ['database', 'http', 'oauth', 'webhook', 'llm', 'email', 'sms'] as const;
const SOURCES = ['local', 'env', 'gcp', 'aws', 'azure'] as const;

type Kind = (typeof KINDS)[number];
type Source = (typeof SOURCES)[number];

const KIND_FIELDS: Record<Kind, Array<{ key: string; label: string; secret?: boolean }>> = {
  database: [
    { key: 'host', label: 'Host' },
    { key: 'port', label: 'Port' },
    { key: 'database', label: 'Database' },
    { key: 'user', label: 'User' },
    { key: 'password', label: 'Password', secret: true },
  ],
  http: [
    { key: 'bearerToken', label: 'Bearer token', secret: true },
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'headerName', label: 'API key header' },
    { key: 'username', label: 'Username (basic / login)' },
    { key: 'password', label: 'Password (basic / login)', secret: true },
  ],
  oauth: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'refreshToken', label: 'Refresh token', secret: true },
    { key: 'accessToken', label: 'Access token (optional)', secret: true },
  ],
  webhook: [{ key: 'secret', label: 'Shared secret', secret: true }],
  llm: [
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'token', label: 'Token (alias)', secret: true },
  ],
  email: [
    { key: 'host', label: 'SMTP host' },
    { key: 'port', label: 'SMTP port (465 = TLS, 587 = STARTTLS)' },
    { key: 'security', label: 'Security (tls | starttls | none)' },
    { key: 'username', label: 'SMTP username' },
    { key: 'password', label: 'SMTP password', secret: true },
    { key: 'apiKey', label: 'API key (SendGrid / Resend)', secret: true },
  ],
  sms: [
    { key: 'accountSid', label: 'Twilio account SID' },
    { key: 'authToken', label: 'Twilio auth token', secret: true },
    { key: 'apiKey', label: 'Vonage API key' },
    { key: 'apiSecret', label: 'Vonage API secret', secret: true },
  ],
};

const CLOUD_FIELDS: Array<{ key: string; label: string; placeholder?: string }> = [
  { key: 'format', label: 'Format (json | text)', placeholder: 'json' },
  { key: 'valueKey', label: 'Text value key', placeholder: 'value' },
];

const SOURCE_FIELDS: Record<
  Exclude<Source, 'local' | 'env'>,
  Array<{ key: string; label: string; placeholder?: string }>
> = {
  gcp: [
    { key: 'projectId', label: 'GCP project id' },
    { key: 'secretId', label: 'Secret id' },
    { key: 'version', label: 'Version', placeholder: 'latest' },
    ...CLOUD_FIELDS,
  ],
  aws: [
    { key: 'secretId', label: 'Secret id / ARN' },
    { key: 'region', label: 'Region', placeholder: 'us-east-1' },
    { key: 'versionId', label: 'Version id (optional)' },
    ...CLOUD_FIELDS,
  ],
  azure: [
    { key: 'vaultUrl', label: 'Key Vault URL', placeholder: 'https://my-vault.vault.azure.net' },
    { key: 'secretName', label: 'Secret name' },
    { key: 'version', label: 'Version (optional)' },
    ...CLOUD_FIELDS,
  ],
};

const SOURCE_HELP: Record<Source, string> = {
  local: 'Values are encrypted in the engine’s store.',
  env: 'Map each field to a process environment variable name (resolved at run time).',
  gcp: 'Fetches from GCP Secret Manager. Auth: GOOGLE_ACCESS_TOKEN or GCP metadata identity.',
  aws: 'Fetches from AWS Secrets Manager. Auth: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.',
  azure:
    'Fetches from Azure Key Vault. Auth: AZURE_ACCESS_TOKEN or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET.',
};

const KIND_VARIANT: Record<string, 'sink' | 'source' | 'accent' | 'default'> = {
  database: 'sink',
  http: 'source',
  oauth: 'source',
  webhook: 'accent',
};

interface CredentialForm {
  name: string;
  kind: Kind;
  source: Source;
  fields: Record<string, string>;
}

const EMPTY_FORM: CredentialForm = { name: '', kind: 'http', source: 'local', fields: {} };

function validate(form: CredentialForm): { name?: string; fields?: string } {
  return {
    ...(form.name.trim() ? {} : { name: 'Name is required' }),
    ...(Object.values(form.fields).some((value) => value.trim()) ? {} : { fields: 'Fill at least one field' }),
  };
}

function fieldsFor(form: CredentialForm) {
  return form.source === 'local' || form.source === 'env' ? KIND_FIELDS[form.kind] : SOURCE_FIELDS[form.source];
}

export function CredentialsPanel({
  credentials,
  onChange,
}: {
  credentials: CredentialMeta[];
  onChange: () => void;
}) {
  // Storing a secret takes workflow.admin; the proxy enforces it, this only says so up front.
  const canManage = useAuthStore((s) => s.can('workflow.admin'));
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<{ name?: string; fields?: string }>({});

  // Errors appear on submit, then follow the input until they are fixed.
  const patch = (next: CredentialForm) => {
    setForm(next);
    if (errors.name || errors.fields) setErrors(validate(next));
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (found.name || found.fields) return;
    setBusy(true);
    try {
      const data: Record<string, unknown> = {};
      for (const field of fieldsFor(form)) {
        const raw = form.fields[field.key]?.trim();
        if (raw) data[field.key] = form.source === 'local' && field.key === 'port' ? Number(raw) : raw;
      }
      const name = form.name.trim();
      await api.createCredential({ name, kind: form.kind, source: form.source, data });
      setForm(EMPTY_FORM);
      setShowForm(false);
      toast.success(`Credential "${name}" created`);
      onChange();
    } catch (err) {
      toast.error('Create failed', { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (credential: CredentialMeta) => {
    if (!confirm('Delete this credential? Workflows using it will fail at run time.')) return;
    setBusy(true);
    try {
      await api.deleteCredential(credential.id);
      toast.success(`Credential "${credential.name}" deleted`);
      onChange();
    } catch (err) {
      toast.error('Delete failed', { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="credentials-panel">
      <div className="panel-header">
        <div>
          <h2>Credentials</h2>
          <p className="panel-sub">
            Secrets stay encrypted at rest or resolve from env / GCP / AWS / Azure at run time — never
            returned to the browser.
          </p>
        </div>
        <Button
          variant={showForm ? 'default' : 'primary'}
          disabled={!canManage}
          title={canManage ? undefined : 'Managing credentials needs the workflow admin permission'}
          onClick={() => setShowForm((open) => !open)}
        >
          {showForm ? <X /> : <Plus />}
          {showForm ? 'Cancel' : 'New credential'}
        </Button>
      </div>

      {showForm && (
        <form className="cred-form" onSubmit={(event) => void create(event)}>
          <Label htmlFor="cred-name">Name</Label>
          <Input
            id="cred-name"
            placeholder="Postgres prod"
            value={form.name}
            onChange={(event) => patch({ ...form, name: event.target.value })}
          />
          {errors.name && <div className="field-error">{errors.name}</div>}

          <Label htmlFor="cred-kind">Kind</Label>
          <Select
            id="cred-kind"
            value={form.kind}
            onChange={(event) => patch({ ...form, kind: event.target.value as Kind, fields: {} })}
          >
            {KINDS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>

          <Label htmlFor="cred-source">Secret source</Label>
          <Select
            id="cred-source"
            value={form.source}
            onChange={(event) => patch({ ...form, source: event.target.value as Source, fields: {} })}
          >
            {SOURCES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <p className="hint">{SOURCE_HELP[form.source]}</p>

          {fieldsFor(form).map((field) => (
            <div key={field.key}>
              <Label htmlFor={`cred-${field.key}`}>
                {field.label}
                {form.source === 'env' ? ' (env var name)' : ''}
              </Label>
              <Input
                id={`cred-${field.key}`}
                type={form.source === 'local' && 'secret' in field && field.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={
                  'placeholder' in field
                    ? field.placeholder
                    : form.source === 'env'
                      ? `e.g. FOXFLOW_${field.key.toUpperCase()}`
                      : undefined
                }
                value={form.fields[field.key] ?? ''}
                onChange={(event) =>
                  patch({ ...form, fields: { ...form.fields, [field.key]: event.target.value } })
                }
              />
            </div>
          ))}
          {errors.fields && <div className="field-error">{errors.fields}</div>}

          <Button variant="primary" type="submit" disabled={busy} className="mt-3 justify-self-start">
            <KeyRound />
            Save credential
          </Button>
        </form>
      )}

      {credentials.length === 0 ? (
        <div className="empty-state">
          No credentials yet. Create one to attach to HTTP, webhook, or database pipes.
        </div>
      ) : (
        <table className="cred-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Source</th>
              <th>Id</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {credentials.map((credential) => (
              <tr key={credential.id}>
                <td>
                  <strong>{credential.name}</strong>
                </td>
                <td>
                  <Badge variant={KIND_VARIANT[credential.kind] ?? 'default'}>{credential.kind}</Badge>
                </td>
                <td>
                  <Badge variant="default">{credential.source ?? 'local'}</Badge>
                </td>
                <td>
                  <code>{credential.id.slice(0, 8)}</code>
                </td>
                <td>{credential.updatedAt ? new Date(credential.updatedAt).toLocaleString() : '—'}</td>
                <td>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${credential.name}`}
                    disabled={busy || !canManage}
                    onClick={() => void remove(credential)}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
