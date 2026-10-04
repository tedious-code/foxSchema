import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import {
  createAppSecret,
  deleteAppSecret,
  listAppSecrets,
  listCloudProviders,
  resolveAppSecrets,
  type AppSecretCloudRef,
  type AppSecretSummary,
  type CloudProviderCredentialSummary,
} from '@/shared/api/appSecretsApi';
import { getCloudSecretProvider } from '@/shared/lib/cloud-provider-settings';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export interface SqlSecretsPanelHandle {
  refresh: () => Promise<void>;
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

  const selectedCred = credentials.find((c) => c.id === credentialId);

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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const resetForm = () => {
    setName('');
    setMode('cloud');
    setLocalValue('');
    setSecretId('');
    setRegion('');
    setVaultUrl('');
    setVersion('');
    setAdding(false);
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

  const cloudRef = (): AppSecretCloudRef => ({
    secretId: secretId.trim(),
    ...(credentialId ? { credentialId } : {}),
    ...(region.trim() ? { region: region.trim() } : {}),
    ...(vaultUrl.trim() ? { vaultUrl: vaultUrl.trim() } : {}),
    ...(version.trim() ? { version: version.trim() } : {}),
  });

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
    try {
      await deleteAppSecret(s.id);
      const linked = variables.find((v) => v.name === s.name && v.secret);
      if (linked) deleteVariable(linked.id);
      await refreshList();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-1.5 min-h-0 flex-1" data-testid="sql-secrets">
      <p className="text-[11px] font-medium text-slate-500 leading-snug shrink-0">
        Pick a named cloud credential and Fetch a key, or enter a secret manually. Values become
        Variables and stay masked (••••).
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
              <button data-testid={`sql-secret-delete-secret-${s.id}`}
                type="button"
                title="Delete secret"
                aria-label={`Delete ${s.name}`}
                onClick={() => void onDelete(s)}
                className="ml-auto p-0.5 text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition"
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
                <p className="text-[10px] text-amber-400/90 leading-snug">
                  No named credentials yet — add one under Credentials → Cloud providers.
                </p>
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
              <input
                data-testid="sql-secret-cloud-id"
                placeholder={
                  selectedCred?.provider === 'gcp'
                    ? 'projects/…/secrets/…/versions/latest'
                    : 'Secret id / name in cloud'
                }
                value={secretId}
                onChange={(e) => setSecretId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none"
              />
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
              <input data-testid="sql-secret-version"
                placeholder="version (optional)"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none"
              />
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
