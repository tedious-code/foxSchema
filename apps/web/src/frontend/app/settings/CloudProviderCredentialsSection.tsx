import React, { useCallback, useEffect, useState } from 'react';
import { Cloud, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  createCloudProviderCredential,
  deleteCloudProviderCredential,
  listCloudProviders,
  updateCloudProviderCredential,
  type CloudProviderCredentialSummary,
  type CloudProviderCredentials,
} from '@/shared/api/appSecretsApi';
import {
  CLOUD_SECRET_PROVIDER_LIST,
  getCloudSecretProvider,
  isCloudSecretProviderId,
  type CloudSecretProviderId,
} from '@/shared/lib/cloud-provider-settings';

/**
 * Named cloud credentials (like DB connections) — each links to a secrets backend.
 * Secrets panel picks one from a dropdown to Fetch keys.
 */
export const CloudProviderCredentialsSection: React.FC = () => {
  const [items, setItems] = useState<CloudProviderCredentialSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<CloudSecretProviderId>('aws');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setItems(await listCloudProviders());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setName('');
    setProvider('aws');
    setFields({});
  };

  const openAdd = () => {
    closeForm();
    setFormOpen(true);
    setError(null);
    setNote(null);
  };

  const openEdit = (item: CloudProviderCredentialSummary) => {
    setEditingId(item.id);
    setName(item.name);
    setProvider(item.provider);
    setFields({});
    setFormOpen(true);
    setError(null);
    setNote(null);
  };

  const formSettings = getCloudSecretProvider(provider)!;

  const onSave = async () => {
    setError(null);
    try {
      const credentials = Object.fromEntries(
        formSettings.fields
          .map((f) => [f.key, fields[f.key]?.trim() ?? ''])
          .filter(([, v]) => v.length > 0)
      ) as CloudProviderCredentials;

      if (editingId) {
        await updateCloudProviderCredential(editingId, {
          name: name.trim(),
          ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
        });
        setNote(`Updated “${name.trim()}”`);
      } else {
        if (Object.keys(credentials).length === 0) {
          throw new Error('Enter API credentials for this provider');
        }
        await createCloudProviderCredential({
          name: name.trim(),
          provider,
          credentials,
        });
        setNote(`Saved “${name.trim()}” — available in Secrets`);
      }
      closeForm();
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onClear = async (item: CloudProviderCredentialSummary) => {
    setDeleting(item.id);
    setError(null);
    try {
      await deleteCloudProviderCredential(item.id);
      setNote(`Removed “${item.name}”`);
      if (editingId === item.id) closeForm();
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="cloud-provider-credentials">
      <p className="text-xs text-slate-400 leading-snug">
        Name each cloud credential like a database connection. Link it to AWS, GCP, or Azure
        Secrets Manager, then pick it in SQL Editor → Secrets and Fetch a key.
      </p>

      {error && <p className="text-xs text-rose-400 font-medium break-words">{error}</p>}
      {note && <p className="text-xs text-emerald-400/90 font-medium">{note}</p>}

      {items.length === 0 && !formOpen ? (
        <div className="text-center py-10 text-slate-500 text-sm">
          <div className="w-14 h-14 rounded-full bg-slate-800/60 flex items-center justify-center mx-auto mb-3">
            <Cloud className="w-6 h-6 text-slate-600" />
          </div>
          <p className="font-medium text-slate-400">No cloud credentials yet</p>
          <p className="text-xs text-slate-600 mt-1">
            Add a named credential to fetch secrets from the cloud
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => {
            const settings = getCloudSecretProvider(item.provider);
            if (!settings) return null;
            return (
              <div
                key={item.id}
                className="rounded-xl bg-slate-950/60 border border-slate-800 hover:border-slate-700 transition"
                data-testid={`cloud-cred-card-${item.id}`}
              >
                <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
                  <button data-testid={`cloud-cred-status-${item.id}`}
                    type="button"
                    onClick={() => openEdit(item)}
                    className="flex items-start gap-3 min-w-0 flex-1 text-left cursor-pointer"
                  >
                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded-md border shrink-0 ${settings.badge}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${settings.dot}`} />
                      {settings.shortLabel}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-100 truncate leading-tight">
                        {item.name}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">{settings.description}</p>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        Updated {new Date(item.updatedAt).toLocaleString()}
                      </p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button data-testid={`cloud-cred-edit-${item.id}`}
                      type="button"
                      title="Edit"
                      onClick={() => openEdit(item)}
                      className="p-2 text-slate-500 hover:text-cyan-300 hover:bg-cyan-950/30 rounded-lg transition"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button data-testid={`cloud-cred-remove-${item.id}`}
                      type="button"
                      title="Remove"
                      disabled={deleting === item.id}
                      onClick={() => void onClear(item)}
                      className="p-2 text-slate-500 hover:text-rose-300 hover:bg-rose-950/30 rounded-lg transition disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formOpen && (
        <div
          className="rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-2"
          data-testid="cloud-cred-form"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-slate-200">
              {editingId ? 'Update credential' : 'Add cloud credential'}
            </p>
            <button data-testid="cloud-cred-close-form" type="button" onClick={closeForm} className="p-1 text-slate-500 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>

          <input
            data-testid="cloud-cred-name"
            placeholder="Name (e.g. Prod AWS)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 outline-none accent-focus"
          />

          {!editingId && (
            <select
              data-testid="cloud-cred-provider-select"
              value={provider}
              onChange={(e) => {
                const v = e.target.value;
                if (isCloudSecretProviderId(v)) {
                  setProvider(v);
                  setFields({});
                }
              }}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none accent-focus"
            >
              {CLOUD_SECRET_PROVIDER_LIST.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}

          {editingId && (
            <p className="text-[11px] text-slate-500">
              Provider: {formSettings.label}. Leave key fields blank to keep existing secrets.
            </p>
          )}

          {formSettings.fields.map((f) =>
            f.kind === 'textarea' ? (
              <textarea
                key={f.key}
                data-testid={`cloud-cred-field-${f.key}`}
                placeholder={
                  editingId ? `${f.label} (leave blank to keep)` : (f.placeholder ?? f.label)
                }
                value={fields[f.key] ?? ''}
                onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                rows={f.rows ?? 3}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-[11px] font-mono text-slate-100 outline-none accent-focus resize-y"
              />
            ) : (
              <input
                key={f.key}
                data-testid={`cloud-cred-field-${f.key}`}
                type={f.kind === 'password' ? 'password' : 'text'}
                placeholder={
                  editingId ? `${f.label} (leave blank to keep)` : (f.placeholder ?? f.label)
                }
                value={fields[f.key] ?? ''}
                onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 outline-none accent-focus"
              />
            )
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              data-testid="cloud-cred-save"
              disabled={!name.trim()}
              onClick={() => void onSave()}
              className="px-3 py-1.5 text-xs font-bold accent-grad on-accent-fg rounded-lg disabled:opacity-40"
            >
              Save
            </button>
            <button data-testid="cloud-cred-cancel"
              type="button"
              onClick={closeForm}
              className="px-3 py-1.5 text-xs font-bold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!formOpen && (
        <button
          type="button"
          data-testid="cloud-cred-add"
          onClick={openAdd}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold accent-grad on-accent-fg rounded-lg transition cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Add cloud credential
        </button>
      )}
    </div>
  );
};
