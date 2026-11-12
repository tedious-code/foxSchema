import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import {
  createAppSecret,
  createCloudProviderCredential,
  gcpOAuthStartUrl,
  listAppSecrets,
  listCloudProviders,
  listGcpProjects,
  listGcpSecrets,
  listGcpSecretVersions,
  resolveAppSecrets,
  type AppSecretCloudRef,
  type AppSecretSummary,
  type CloudProviderCredentialSummary,
  type CloudProviderCredentials,
  type GcpProjectSummary,
  type GcpSecretSummary,
  type GcpSecretVersionSummary,
} from '@/shared/api/appSecretsApi';
import {
  CLOUD_SECRET_PROVIDER_LIST,
  CLOUD_SECRET_PROVIDERS,
  getCloudSecretProvider,
  isCloudSecretProviderId,
  type CloudProviderField,
  type CloudSecretProviderId,
} from '@/shared/lib/cloud-provider-settings';
import { isSecretUnset, variableRefText } from '@/shared/lib/sql-variables';
import {
  APP_SECRETS_CHANGED_EVENT,
  deleteVaultSecretAndVariables,
} from '@/features/sql-editor/lib/deleteEditorSecret';
import { insertVariableRef } from '@/features/sql-editor/lib/sqlEditorBridge';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export interface SqlSecretsPanelHandle {
  refresh: () => Promise<void>;
}

const FIELD_INPUT_CLASS =
  'w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 font-mono text-slate-100 outline-none accent-focus';

type CloudProviderFieldInputsProps = {
  fields: CloudProviderField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
};

function CloudProviderFieldInputs({
  fields,
  values,
  onChange,
}: CloudProviderFieldInputsProps) {
  return (
    <>
      {fields.map((field) =>
        field.kind === 'textarea' ? (
          <textarea
            key={field.key}
            data-testid={`sql-secret-cloud-cred-field-${field.key}`}
            placeholder={field.placeholder ?? field.label}
            value={values[field.key] ?? ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            rows={field.rows ?? 3}
            className={`${FIELD_INPUT_CLASS} text-[11px] resize-y`}
          />
        ) : (
          <input
            key={field.key}
            data-testid={`sql-secret-cloud-cred-field-${field.key}`}
            type={field.kind === 'password' ? 'password' : 'text'}
            placeholder={field.placeholder ?? field.label}
            value={values[field.key] ?? ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            className={`${FIELD_INPUT_CLASS} text-[12px]`}
          />
        )
      )}
    </>
  );
}

/**
 * Secrets: pick a named cloud credential → Fetch into a masked Variable,
 * or add a secret key manually (local).
 */
export const SqlSecretsPanel = forwardRef<SqlSecretsPanelHandle>(function SqlSecretsPanel(_props, ref) {
  const upsertVariable = useSqlEditorStore((s) => s.upsertVariable);
  const deleteVariable = useSqlEditorStore((s) => s.deleteVariable);
  const variables = useSqlEditorStore((s) => s.variables);

  const [secrets, setSecrets] = useState<AppSecretSummary[]>([]);
  const [credentials, setCredentials] = useState<CloudProviderCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'cloud' | 'manual'>('cloud');
  const [credentialId, setCredentialId] = useState('');
  const [localValue, setLocalValue] = useState('');
  const [secretId, setSecretId] = useState('');
  const [region, setRegion] = useState('');
  const [vaultUrl, setVaultUrl] = useState('');
  const [version, setVersion] = useState('');
  const [fetching, setFetching] = useState(false);
  const [credName, setCredName] = useState('');
  const [credProvider, setCredProvider] = useState<CloudSecretProviderId>('gcp');
  const [credFields, setCredFields] = useState<Record<string, string>>({});
  const [savingCred, setSavingCred] = useState(false);
  const [gcpProjects, setGcpProjects] = useState<GcpProjectSummary[]>([]);
  const [gcpSecrets, setGcpSecrets] = useState<GcpSecretSummary[]>([]);
  const [gcpVersions, setGcpVersions] = useState<GcpSecretVersionSummary[]>([]);
  const [gcpProject, setGcpProject] = useState('');
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  const selectedCred = credentials.find((c) => c.id === credentialId);
  const gcpBrowse = selectedCred?.provider === 'gcp';

  const refreshList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [secs, creds] = await Promise.all([listAppSecrets(), listCloudProviders()]);
      setSecrets(secs);
      setCredentials(creds);
      setCredentialId((prev) => {
        if (prev && creds.some((c) => c.id === prev)) return prev;
        return creds[0]?.id ?? '';
      });
      const vaultNames = new Set(secs.map((s) => s.name));
      const { variables: sessionVars, deleteVariable: dropVar } = useSqlEditorStore.getState();
      for (const v of sessionVars) {
        if (v.secret && isSecretUnset(v) && !vaultNames.has(v.name)) dropVar(v.id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    const onChanged = () => void refreshList();
    window.addEventListener(APP_SECRETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(APP_SECRETS_CHANGED_EVENT, onChanged);
  }, [refreshList]);

  useEffect(() => {
    if (!gcpBrowse || !credentialId) {
      setGcpProjects([]);
      setGcpSecrets([]);
      setGcpVersions([]);
      setGcpProject('');
      setBrowseError(null);
      return;
    }
    let cancelled = false;
    setBrowseLoading(true);
    setBrowseError(null);
    void listGcpProjects(credentialId)
      .then((projects) => {
        if (cancelled) return;
        setGcpProjects(projects);
        const preferred =
          (selectedCred?.projectId && projects.some((p) => p.id === selectedCred.projectId)
            ? selectedCred.projectId
            : '') ||
          projects[0]?.id ||
          selectedCred?.projectId ||
          '';
        setGcpProject(preferred);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setGcpProjects([]);
        setBrowseError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBrowseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gcpBrowse, credentialId, selectedCred?.projectId]);

  useEffect(() => {
    if (!gcpBrowse || !credentialId || !gcpProject) {
      setGcpSecrets([]);
      return;
    }
    let cancelled = false;
    void listGcpSecrets(credentialId, gcpProject)
      .then((secrets) => {
        if (!cancelled) setGcpSecrets(secrets);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBrowseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [gcpBrowse, credentialId, gcpProject]);

  useEffect(() => {
    if (!gcpBrowse || !credentialId || !gcpProject || !secretId.trim()) {
      setGcpVersions([]);
      return;
    }
    let cancelled = false;
    void listGcpSecretVersions(credentialId, secretId.trim(), gcpProject)
      .then((versions) => {
        if (!cancelled) setGcpVersions(versions);
      })
      .catch(() => {
        if (!cancelled) setGcpVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gcpBrowse, credentialId, gcpProject, secretId]);

  const resetForm = () => {
    setName('');
    setMode('cloud');
    setLocalValue('');
    setSecretId('');
    setRegion('');
    setVaultUrl('');
    setVersion('');
    setAdding(false);
    setCredName('');
    setCredProvider('gcp');
    setCredFields({});
    setGcpProjects([]);
    setGcpSecrets([]);
    setGcpVersions([]);
    setGcpProject('');
    setBrowseError(null);
  };

  const credSettings = CLOUD_SECRET_PROVIDERS[credProvider];

  const onSaveCloudCredential = async () => {
    setError(null);
    setNote(null);
    setSavingCred(true);
    try {
      const credentials: Record<string, string> = {};
      for (const field of credSettings.fields) {
        const value = credFields[field.key]?.trim();
        if (value) credentials[field.key] = value;
      }
      if (Object.keys(credentials).length === 0) {
        throw new Error('Enter API credentials for this provider');
      }
      const saved = await createCloudProviderCredential({
        name: credName.trim(),
        provider: credProvider,
        credentials: credentials as CloudProviderCredentials,
      });
      setCredName('');
      setCredFields({});
      setNote(`Saved “${saved.name}” — enter the secret name and Fetch`);
      await refreshList();
      setCredentialId(saved.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCred(false);
    }
  };

  const linkSecretVariable = (secretName: string, sessionValue?: string) => {
    const err = upsertVariable({
      name: secretName,
      kind: 'scalar',
      secret: true,
      ...(sessionValue !== undefined ? { value: sessionValue } : {}),
    });
    if (err) throw new Error(err);
  };

  const cloudRef = (): AppSecretCloudRef => {
    const raw = secretId.trim();
    const gcpSecretId =
      gcpBrowse && gcpProject && raw && !raw.startsWith('projects/')
        ? `projects/${gcpProject}/secrets/${raw}`
        : raw;
    return {
      secretId: gcpSecretId,
      ...(credentialId ? { credentialId } : {}),
      ...(region.trim() ? { region: region.trim() } : {}),
      ...(vaultUrl.trim() ? { vaultUrl: vaultUrl.trim() } : {}),
      ...(version.trim() ? { version: version.trim() } : {}),
    };
  };

  const onAddManual = async () => {
    setError(null);
    setNote(null);
    try {
      const n = name.trim();
      await createAppSecret({ name: n, source: 'local', value: localValue });
      linkSecretVariable(n, localValue);
      setNote(`Added secret variable "${n}" (value hidden)`);
      resetForm();
      await refreshList();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onFetchFromCloud = async () => {
    if (!selectedCred) {
      setError('Add a named cloud credential under Credentials → Cloud providers first');
      return;
    }
    setFetching(true);
    setError(null);
    setNote(null);
    try {
      const n = name.trim();
      await createAppSecret({
        name: n,
        source: selectedCred.provider,
        cloudRef: cloudRef(),
      });
      const out = await resolveAppSecrets([n]);
      if (out.errors[n]) {
        throw new Error(out.errors[n]);
      }
      const value = out.secrets[n];
      if (value === undefined) {
        throw new Error(`Cloud secret "${n}" resolved empty`);
      }
      linkSecretVariable(n, value);
      const label = getCloudSecretProvider(selectedCred.provider)?.shortLabel ?? selectedCred.provider;
      setNote(`Fetched via ${selectedCred.name} (${label}) → "${n}" (hidden)`);
      resetForm();
      await refreshList();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  const onRefreshFromCloud = useCallback(async () => {
    setError(null);
    setNote(null);
    try {
      const out = await resolveAppSecrets();
      const cloudNames = secrets.filter((s) => s.source !== 'local').map((s) => s.name);
      let updated = 0;
      for (const n of cloudNames) {
        const value = out.secrets[n];
        if (value === undefined) continue;
        const err = upsertVariable({
          name: n,
          kind: 'scalar',
          secret: true,
          value,
        });
        if (err) throw new Error(err);
        updated++;
      }
      const bad = Object.keys(out.errors).length;
      setNote(
        bad === 0
          ? `Refreshed ${updated} cloud secret${updated === 1 ? '' : 's'} into Variables (masked)`
          : `Updated ${updated}; ${bad} error${bad === 1 ? '' : 's'}`
      );
      if (bad > 0) {
        const first = Object.entries(out.errors)[0];
        if (first) setError(`${first[0]}: ${first[1]}`);
      }
      await refreshList();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [secrets, refreshList, upsertVariable]);

  useImperativeHandle(ref, () => ({ refresh: onRefreshFromCloud }), [onRefreshFromCloud]);

  const onDelete = async (s: AppSecretSummary) => {
    setError(null);
    setSecrets((prev) => prev.filter((x) => x.id !== s.id));
    try {
      await deleteVaultSecretAndVariables(s, variables, deleteVariable);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await refreshList();
  };

  return (
    <div className="flex flex-col gap-1.5 min-h-0 flex-1" data-testid="sql-secrets">
      <p className="text-[11px] font-medium text-slate-500 leading-snug shrink-0">
        Connect Google Cloud, pick a secret, and Fetch — or enter a key manually. Insert puts{' '}
        <code className="text-slate-400">{variableRefText('name')}</code> at the cursor. Values stay
        masked (••••).
      </p>

      {note && (
        <p className="text-[10px] font-medium text-slate-400 truncate shrink-0" title={note}>
          {note}
        </p>
      )}

      {error && (
        <p className="text-[11px] text-rose-400 font-medium break-words" data-testid="sql-secrets-error">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-[12px] text-slate-500">Loading…</p>
      ) : secrets.length === 0 && !adding ? (
        <p className="text-[12px] text-slate-500">No secrets yet — Fetch from cloud or add manually.</p>
      ) : (
        <ul className="flex flex-col gap-1 overflow-y-auto min-h-0 flex-1 pr-0.5">
          {secrets.map((s) => (
            <li
              key={s.id}
              className="group flex items-center gap-1 rounded border border-slate-800 bg-slate-950/50 px-1.5 py-1"
              data-testid={`sql-secret-${s.name}`}
            >
              <KeyRound
                className="w-3.5 h-3.5 shrink-0 text-amber-400"
                strokeWidth={SQL_ICON_STROKE}
              />
              <span className="font-mono text-[12px] font-bold text-slate-200 truncate">
                {s.name}
              </span>
              <span className="text-[10px] font-bold uppercase text-slate-500 shrink-0">
                {s.source}
              </span>
              <span className="text-[11px] font-mono text-slate-500 shrink-0" title="Value hidden">
                ••••
              </span>
              <button
                type="button"
                data-testid={`sql-secret-insert-${s.name}`}
                title={`Insert ${variableRefText(s.name)} at cursor`}
                onClick={() => insertVariableRef(s.name)}
                className="ml-auto shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold text-cyan-200 bg-cyan-950/60 border border-cyan-600/50 hover:bg-cyan-900/70 transition"
              >
                Insert
              </button>
              <button
                data-testid={`sql-secret-delete-secret-${s.id}`}
                type="button"
                title="Delete secret"
                aria-label={`Delete ${s.name}`}
                onClick={() => void onDelete(s)}
                className="p-0.5 text-slate-500 hover:text-rose-400 transition"
              >
                <Trash2 className="w-3 h-3 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-950/60 p-1.5 shrink-0">
          <select
            data-testid="sql-secret-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'cloud' | 'manual')}
            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
          >
            <option value="cloud">Fetch from cloud</option>
            <option value="manual">Manual (enter secret key)</option>
          </select>
          <input
            data-testid="sql-secret-name"
            placeholder="variable name (e.g. apiToken)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-100 outline-none accent-focus"
          />

          {mode === 'manual' ? (
            <input
              data-testid="sql-secret-value"
              type="password"
              placeholder="secret value (won’t be shown again)"
              value={localValue}
              onChange={(e) => setLocalValue(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] font-mono text-slate-100 outline-none accent-focus"
            />
          ) : (
            <>
              <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wide">
                Cloud credential
              </label>
              {credentials.length === 0 ? (
                <div
                  className="flex flex-col gap-1 rounded border border-amber-900/50 bg-amber-950/20 p-1.5"
                  data-testid="sql-secret-add-cloud-cred"
                >
                  <p className="text-[10px] text-amber-300/90 leading-snug">
                    Connect Google Cloud in the browser (recommended). Do not download a service
                    account key — machines can paste a Workload Identity Federation client config
                    instead. Then pick a secret and Fetch it into a masked variable.
                  </p>
                  <button
                    type="button"
                    data-testid="sql-secret-gcp-connect"
                    onClick={() => window.location.assign(gcpOAuthStartUrl(credName.trim() || 'Google Cloud'))}
                    className="self-start text-[12px] font-bold text-amber-400 hover:text-amber-300 px-1 py-0.5"
                  >
                    Connect Google Cloud
                  </button>
                  <input
                    data-testid="sql-secret-cloud-cred-name"
                    placeholder="Credential name (e.g. Google Cloud)"
                    value={credName}
                    onChange={(e) => setCredName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-100 outline-none accent-focus"
                  />
                  <select
                    data-testid="sql-secret-cloud-cred-provider"
                    value={credProvider}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (isCloudSecretProviderId(v)) {
                        setCredProvider(v);
                        setCredFields({});
                      }
                    }}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
                  >
                    {CLOUD_SECRET_PROVIDER_LIST.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <CloudProviderFieldInputs
                    fields={credSettings.fields}
                    values={credFields}
                    onChange={(key, value) =>
                      setCredFields((prev) => ({ ...prev, [key]: value }))
                    }
                  />
                  <button
                    type="button"
                    data-testid="sql-secret-cloud-cred-save"
                    disabled={savingCred || !credName.trim()}
                    onClick={() => void onSaveCloudCredential()}
                    className="self-start text-[12px] font-bold text-amber-400 hover:text-amber-300 px-1 py-0.5 disabled:opacity-40"
                  >
                    {savingCred ? 'Saving…' : 'Save credential'}
                  </button>
                </div>
              ) : (
                <select
                  data-testid="sql-secret-provider"
                  value={credentialId}
                  onChange={(e) => setCredentialId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
                >
                  {credentials.map((c) => {
                    const label = getCloudSecretProvider(c.provider)?.shortLabel ?? c.provider;
                    return (
                      <option key={c.id} value={c.id}>
                        {c.name} · {label}
                      </option>
                    );
                  })}
                </select>
              )}
              {gcpBrowse && gcpProjects.length > 0 ? (
                <>
                  <select
                    data-testid="sql-secret-gcp-project"
                    value={gcpProject}
                    onChange={(e) => {
                      setGcpProject(e.target.value);
                      setSecretId('');
                      setVersion('');
                    }}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
                  >
                    {gcpProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name === p.id ? p.id : `${p.name} (${p.id})`}
                      </option>
                    ))}
                  </select>
                  <select
                    data-testid="sql-secret-gcp-secret"
                    value={secretId}
                    onChange={(e) => {
                      setSecretId(e.target.value);
                      setVersion('');
                    }}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
                  >
                    <option value="">{browseLoading ? 'Loading secrets…' : 'Select a secret'}</option>
                    {gcpSecrets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <select
                    data-testid="sql-secret-gcp-version"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
                  >
                    {gcpVersions.length === 0 ? (
                      <option value="">latest</option>
                    ) : (
                      gcpVersions.map((v) => (
                        <option key={v.id} value={v.id === 'latest' ? '' : v.id}>
                          {v.id}
                          {v.state && v.state !== 'ENABLED' ? ` (${v.state})` : ''}
                        </option>
                      ))
                    )}
                  </select>
                </>
              ) : (
                <>
                  {gcpBrowse && browseError && (
                    <p className="text-[10px] text-amber-400/90 leading-snug">{browseError}</p>
                  )}
                  <input
                    data-testid="sql-secret-cloud-id"
                    placeholder={
                      (selectedCred?.provider ?? credProvider) === 'gcp'
                        ? 'Secret name (e.g. api-token)'
                        : 'Secret id / name in cloud'
                    }
                    value={secretId}
                    onChange={(e) => setSecretId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none"
                  />
                  <input data-testid="sql-secret-version"
                    placeholder="version (optional)"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none"
                  />
                </>
              )}
              {selectedCred?.provider === 'aws' && (
                <input data-testid="sql-secret-region"
                  placeholder="region (optional)"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none"
                />
              )}
              {selectedCred?.provider === 'azure' && (
                <input data-testid="sql-secret-vault-url"
                  placeholder="https://….vault.azure.net"
                  value={vaultUrl}
                  onChange={(e) => setVaultUrl(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none"
                />
              )}
            </>
          )}

          <div className="flex items-center gap-1">
            {mode === 'cloud' ? (
              <button
                type="button"
                data-testid="sql-secret-fetch"
                disabled={
                  fetching || !name.trim() || !secretId.trim() || !credentialId || credentials.length === 0
                }
                onClick={() => void onFetchFromCloud()}
                className="text-[12px] font-bold text-amber-400 hover:text-amber-300 px-1 py-0.5 disabled:opacity-40"
              >
                {fetching ? 'Fetching…' : 'Fetch'}
              </button>
            ) : (
              <button
                type="button"
                data-testid="sql-secret-save"
                disabled={!name.trim() || !localValue}
                onClick={() => void onAddManual()}
                className="text-[12px] font-bold text-amber-400 hover:text-amber-300 px-1 py-0.5 disabled:opacity-40"
              >
                Add
              </button>
            )}
            <button data-testid="sql-secret-cancel"
              type="button"
              onClick={resetForm}
              className="text-[12px] font-bold text-slate-500 hover:text-slate-300 px-1 py-0.5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="sql-secret-add"
          onClick={() => setAdding(true)}
          className="flex items-center gap-0.5 self-start text-[13px] font-bold text-slate-400 hover:text-amber-300 transition mt-0.5"
        >
          <Plus className="w-3.5 h-3.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} /> Add secret
        </button>
      )}
    </div>
  );
});
