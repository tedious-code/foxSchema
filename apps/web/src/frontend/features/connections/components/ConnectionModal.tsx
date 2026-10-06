import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle, AlertTriangle, FolderOpen, Loader2, ListTree, Download } from "lucide-react";
import {
  type ConnectionOptions,
  type Dialect,
  buildConnectionString,
  DEFAULT_PORTS,
  getProviderSettings,
  isFileDialect as isFileDialectOf,
  PROVIDER_SETTINGS,
  authMethodsForDialect,
  resolveAuthMethod,
  parseWindowsAccount,
  passwordFieldLabel,
  type ConnectionAuthMethod,
} from '@/shared/lib/provider-settings';
import type { DriverInfo } from '@/shared/lib/types';
import { IBM_DB_VERSION } from '@foxschema/ui-shared';
import { fetchSchemaList, checkDriver as apiCheckDriver, installDriver as apiInstallDriver } from "@/shared/api/schemaApi";
import { PasswordInput } from '@/shared/components/PasswordInput';
import { Autocomplete } from '@/shared/components/Autocomplete';
import { DatabaseFilePicker } from './DatabaseFilePicker';


interface CredentialInput {
  name: string;
  dialect: string;
  schema?: string;
  option: ConnectionOptions;
  savePassword: boolean;
}

interface Props {
  open: boolean;
  dialect: Dialect;
  initialOptions?: ConnectionOptions;
  /** 'side' binds to source/target; 'credential' defines a reusable saved credential. */
  mode?: 'side' | 'credential';
  initialName?: string;
  /** Edit mode: whether the saved credential currently has a stored password. */
  initialHasPassword?: boolean;
  onClose: () => void;
  onSave?: (options: ConnectionOptions, dialect: Dialect) => void;
  onSaveCredential?: (input: CredentialInput) => Promise<void>;
}

const defaultPorts = DEFAULT_PORTS;
const dialectOptions = Object.values(PROVIDER_SETTINGS).sort((a, b) =>
  a.label.localeCompare(b.label)
);

const MAX_NAME_LEN = 50;
// Credential names allow letters, numbers, spaces, hyphen and underscore only —
// no other special characters (keeps them safe as labels / dropdown entries).
const sanitizeName = (raw: string) => raw.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, MAX_NAME_LEN);

export const ConnectionModal: React.FC<Props> = ({
  open,
  dialect,
  initialOptions,
  mode = 'side',
  initialName,
  initialHasPassword,
  onClose,
  onSave,
  onSaveCredential,
}) => {
  const isCredential = mode === 'credential';
  const [selDialect, setSelDialect] = useState<Dialect>(dialect);
  const [name, setName] = useState('');
  // New credentials default to saving the password (encrypted). Edit reflects storage.
  const [savePassword, setSavePassword] = useState(true);
  const [form, setForm] = useState<ConnectionOptions>({
    host: 'localhost',
    port: 5432,
    database: '',
    schema: '',
    username: '',
    password: '',
    ssl: { enabled: false },
    pool: { min: 1, max: 10 },
  });

  const [schemaList, setSchemaList] = useState<string[]>([]);
  const schemaRequired = getProviderSettings(selDialect).schemaRequired;
  /**
   * SQLite and DuckDB are a file on disk, not a server. Host, port, user,
   * password and SSL have no meaning for them, and showing the boxes anyway
   * has people filling in `localhost` and wondering why it changes nothing.
   */
  const isFileDialect = isFileDialectOf(selDialect);

  const [browsing, setBrowsing] = useState(false);
  const [driverInfo, setDriverInfo] = useState<DriverInfo | null>(null);
  const [installing, setInstalling] = useState(false);

  const [testingState, setTestingState] = useState<{
    status: 'idle' | 'testing' | 'success' | 'failed';
    error?: string;
  }>({ status: 'idle' });

  // Stable snapshot — callers often pass a fresh `initialOptions` object each
  // render; depending on that reference would wipe a typed password mid-edit.
  const initialOptionsKey = [
    initialOptions?.host ?? '',
    initialOptions?.port ?? '',
    initialOptions?.database ?? '',
    initialOptions?.schema ?? '',
    initialOptions?.username ?? '',
    initialOptions?.password ?? '',
    initialOptions?.authMethod ?? '',
    initialOptions?.domain ?? '',
    initialOptions?.ssl?.enabled ? '1' : '0',
    initialOptions?.ssl?.ca ?? '',
    initialOptions?.pool?.min ?? '',
    initialOptions?.pool?.max ?? '',
  ].join('\0');

  useEffect(() => {
    if (!open) return;
    setSelDialect(dialect);
    setName(sanitizeName(initialName ?? ''));
    setForm({
      host: initialOptions?.host || 'localhost',
      port: initialOptions?.port || defaultPorts[dialect],
      database: initialOptions?.database || '',
      schema: initialOptions?.schema || getProviderSettings(dialect).defaultSchema || '',
      username: initialOptions?.username || '',
      password: initialOptions?.password || '',
      authMethod: resolveAuthMethod(dialect, initialOptions?.authMethod),
      domain: initialOptions?.domain || '',
      ssl: {
        enabled: initialOptions?.ssl?.enabled || false,
        ca: initialOptions?.ssl?.ca || '',
      },
      pool: { min: initialOptions?.pool?.min || 1, max: initialOptions?.pool?.max || 10 },
    });
    setSchemaList([]);
    setBrowsing(false);
    // New credential → save password on by default; edit → match what's stored.
    setSavePassword(initialHasPassword ?? true);
    setTestingState({ status: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialOptionsKey is the stable snapshot
  }, [open, dialect, initialName, initialHasPassword, initialOptionsKey]);

  // Check whether the selected provider's driver is installed, whenever the
  // modal opens or the provider changes. (Must stay above the early return —
  // hooks run unconditionally every render.)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDriverInfo(null);
    apiCheckDriver(selDialect)
      .then((info) => { if (!cancelled) setDriverInfo(info); })
      .catch(() => { if (!cancelled) setDriverInfo(null); });
    return () => { cancelled = true; };
  }, [open, selDialect]);

  if (!open) return null;

  const updateField = (key: keyof ConnectionOptions, value: any) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestingState((s) => (s.status === 'failed' ? { status: 'idle' } : s));
  };

  const changeDialect = (d: Dialect) => {
    setSelDialect(d);
    setSchemaList([]); // schemas are provider-specific — clear stale list
    setTestingState({ status: 'idle' });
    // refresh dialect-specific defaults
    setForm((prev) => ({
      ...prev,
      port: defaultPorts[d],
      schema: getProviderSettings(d).defaultSchema || '',
      authMethod: resolveAuthMethod(d, prev.authMethod),
      domain: resolveAuthMethod(d, prev.authMethod) === 'windows' ? prev.domain : '',
      // Redshift and Azure SQL expect TLS. Azure SQL must verify the server
      // certificate by default; local stand-ins configure their exception in
      // e2e helpers rather than weakening saved production credentials.
      ssl: {
        ...prev.ssl,
        enabled: d === 'redshift' || d === 'azuresql' ? true : !!prev.ssl?.enabled,
        rejectUnauthorized: d === 'azuresql' ? true : prev.ssl?.rejectUnauthorized,
      },
    }));
  };

  const handleInstall = async () => {
    setInstalling(true);
    setTestingState({ status: 'idle' });
    try {
      await apiInstallDriver(selDialect);
      const info = await apiCheckDriver(selDialect);
      setDriverInfo(info);
      if (!info.installed) {
        setTestingState({
          status: 'failed',
          error: info.error
            ? `Driver still not loading: ${info.error}`
            : `Install finished but "${info.packageName}" still failed to load. Try: ${info.installCommand ?? `npm install ${info.packageName}`}`,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Driver install failed';
      setTestingState({ status: 'failed', error: message });
    } finally {
      setInstalling(false);
    }
  };

  // Connect with the entered params and pull the list of selectable schemas.
  // This doubles as the connection check (there is no separate Test button).
  const loadSchemas = async () => {
    const authMethod = resolveAuthMethod(selDialect, form.authMethod);
    if (authMethod === 'windows') {
      const account = parseWindowsAccount(form.username, form.domain);
      if (!account.domain || !account.userName) {
        setTestingState({
          status: 'failed',
          error: 'Windows login needs a domain and a user (CONTOSO\\alice, or Domain + User).',
        });
        return;
      }
    }
    setTestingState({ status: 'testing' });
    try {
      const option: ConnectionOptions = {
        ...form,
        authMethod: authMethod === 'password' ? undefined : authMethod,
        domain: authMethod === 'windows' ? (form.domain?.trim() || undefined) : undefined,
        connectionString: buildConnectionString(selDialect, form),
      };
      const list = await fetchSchemaList({ dialect: selDialect, option });
      setSchemaList(list);
      if (list.length && !list.includes(form.schema || '')) {
        // For single-schema-per-database dialects (MySQL/MariaDB), "schema" and
        // "database" are the same concept — prefer the already-entered database
        // name over the first alphabetical entry in the list.
        const preferred = form.database && list.includes(form.database) ? form.database : list[0];
        updateField('schema', preferred);
      }
      setTestingState({ status: 'success' });
    } catch (error: any) {
      setTestingState({ status: 'failed', error: error.message || 'Failed to load schemas' });
    }
  };

  const handleSave = async () => {
    if (schemaRequired && !form.schema?.trim()) {
      setTestingState({ status: 'failed', error: 'Load schemas and pick one before saving.' });
      return;
    }

    if (isCredential && !isFileDialect && savePassword && !form.password?.trim() && !initialHasPassword) {
      setTestingState({
        status: 'failed',
        error: 'Enter a password, or untick “Save password” to store the credential without one.',
      });
      return;
    }

    const authMethod = resolveAuthMethod(selDialect, form.authMethod);
    if (authMethod === 'windows') {
      const account = parseWindowsAccount(form.username, form.domain);
      if (!account.domain || !account.userName) {
        setTestingState({
          status: 'failed',
          error: 'Windows login needs a domain and a user (CONTOSO\\alice, or Domain + User).',
        });
        return;
      }
    }

    const option: ConnectionOptions = {
      ...form,
      authMethod: authMethod === 'password' ? undefined : authMethod,
      domain: authMethod === 'windows' ? (form.domain?.trim() || undefined) : undefined,
      // Empty password on edit means “keep stored”; never send "" which looks unset.
      password: form.password?.trim() ? form.password : undefined,
      schemaRequired,
      connectionString: buildConnectionString(selDialect, {
        ...form,
        password: form.password?.trim() ? form.password : undefined,
      }),
    };

    try {
      if (isCredential) {
        // Server persists option.password when savePassword !== false.
        await onSaveCredential?.({
          name:
            name.trim() ||
            (isFileDialect ? form.database || selDialect : `${form.host}/${form.database}`),
          dialect: selDialect,
          schema: form.schema,
          option,
          savePassword,
        });
      } else {
        onSave?.(option, selDialect);
      }
      onClose();
    } catch (error: any) {
      setTestingState({ status: 'failed', error: error.message || 'Could not save credential' });
    }
  };

  const inputCls = 'mt-1 w-full bg-slate-950 border border-slate-850 accent-focus text-sm text-slate-200 rounded px-3 py-2 outline-none font-mono';
  const labelCls = 'text-[10px] uppercase font-bold text-slate-400 tracking-wider';
  const loginMethod = resolveAuthMethod(selDialect, form.authMethod);
  const authChoices = authMethodsForDialect(selDialect);

  return createPortal(
    <>
    {browsing && (
      <DatabaseFilePicker
        initialPath={form.database || undefined}
        onCancel={() => setBrowsing(false)}
        onSelect={(path) => {
          updateField('database', path);
          setBrowsing(false);
        }}
      />
    )}
    <div data-testid="conn-modal" className="modal-overlay">
      <div className="w-full max-w-[500px] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div>
            <h2 className="text-slate-100 font-bold text-base">{isCredential ? (initialName ? 'Edit Credential' : 'Add Credential') : 'Connection Parameters'}</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isCredential ? 'Saved encrypted and reusable from the connection dropdowns' : `Configure options for ${selDialect.toUpperCase()}`}
            </p>
          </div>
          <button data-testid="conn-close" aria-label="Close" onClick={onClose} className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {isCredential && (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>Credential Name</label>
                <input
                  data-testid="conn-name-input"
                  placeholder="e.g. Prod DB2"
                  value={name}
                  onChange={(e) => setName(sanitizeName(e.target.value))}
                  maxLength={MAX_NAME_LEN}
                  className={inputCls.replace('font-mono', '')}
                />
                <p className="text-[10px] text-slate-500 mt-1">Letters, numbers, spaces, - and _ · max {MAX_NAME_LEN}</p>
              </div>
              <div>
                <label className={labelCls}>Dialect</label>
                <select data-testid="conn-dialect-select" value={selDialect} onChange={(e) => changeDialect(e.target.value as Dialect)} className={inputCls}>
                  {dialectOptions.map((d) => (
                    <option key={d.dialect} value={d.dialect}>{d.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {!isCredential && (
            <div>
              <label className={labelCls}>Provider</label>
              <select data-testid="conn-dialect-select" value={selDialect} onChange={(e) => changeDialect(e.target.value as Dialect)} className={inputCls}>
                {dialectOptions.map((d) => (
                  <option key={d.dialect} value={d.dialect}>{d.label}</option>
                ))}
              </select>
            </div>
          )}

          {driverInfo && (
            driverInfo.installed ? (
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/90 px-0.5">
                <CheckCircle className="w-3.5 h-3.5" />
                Driver ready · {driverInfo.packageName}{driverInfo.version ? ` ${driverInfo.version}` : ''}
              </div>
            ) : (
              <div className="flex flex-col gap-2 p-2.5 rounded-lg bg-amber-950/20 border border-amber-500/30">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-300 min-w-0">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    Driver "{driverInfo.packageName}" is not installed
                  </span>
                  <button data-testid="conn-install-driver-package"
                    onClick={handleInstall}
                    disabled={installing}
                    title="Install the driver package on the server"
                    className="shrink-0 text-xs font-bold on-accent-fg bg-amber-400 hover:bg-amber-300 disabled:bg-slate-700 disabled:text-slate-400 px-3 py-1 rounded flex items-center gap-1.5 cursor-pointer disabled:cursor-wait"
                  >
                    {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    {installing ? 'Installing…' : 'Install'}
                  </button>
                </div>
                {installing && (
                  <div className="w-full h-1 rounded-full bg-amber-950/40 overflow-hidden">
                    <div className="w-1/3 h-full rounded-full bg-amber-400 animate-indeterminate-progress" />
                  </div>
                )}
                {!installing && driverInfo.error && (
                  <p className="text-[11px] text-amber-200/80 break-words font-mono leading-snug">
                    {driverInfo.error.slice(0, 280)}
                    {driverInfo.installCommand ? (
                      <>
                        {' '}
                        — run <span className="text-amber-100">{driverInfo.installCommand}</span>
                      </>
                    ) : null}
                  </p>
                )}
                {!installing && !driverInfo.installed && driverInfo.packageName === 'ibm_db' && (
                  <p className="text-[11px] text-amber-200/70 leading-snug">
                    Db2 needs a native build + IBM clidriver download. Prefer{' '}
                    <span className="text-amber-100 font-mono">foxschema drivers install db2</span>
                    , then <span className="text-amber-100 font-mono">foxschema stop && foxschema</span>.
                    In a monorepo:{' '}
                    <span className="text-amber-100 font-mono">
                      npm install ibm_db@{IBM_DB_VERSION} --foreground-scripts -w @foxschema/db
                    </span>
                    . On linux/arm64 use Docker (
                    <span className="text-amber-100 font-mono">5nickels/foxschema:latest</span>).
                  </p>
                )}
              </div>
            )
          )}

          {!isFileDialect && (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>Host</label>
                <input data-testid="conn-host-input" placeholder="localhost" value={form.host} onChange={(e) => updateField('host', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Port</label>
                <input data-testid="conn-port-input" type="number" placeholder={String(defaultPorts[selDialect])} value={form.port} onChange={(e) => updateField('port', Number(e.target.value))} className={inputCls} />
              </div>
            </div>
          )}

          {isFileDialect ? (
            <div>
              <label className={labelCls}>Database File</label>
              <div className="mt-1 flex gap-2">
                <input
                  data-testid="conn-database-input"
                  placeholder={selDialect === 'duckdb' ? '/path/to/analytics.duckdb' : '/path/to/app.db'}
                  value={form.database}
                  onChange={(e) => updateField('database', e.target.value)}
                  className={`${inputCls} mt-0 flex-1`}
                />
                <button
                  type="button"
                  data-testid="conn-database-browse"
                  onClick={() => setBrowsing(true)}
                  title="Pick a database file on the server"
                  className="shrink-0 flex items-center gap-1.5 rounded border border-slate-700 bg-slate-950 px-3 text-xs font-semibold text-slate-200 hover:border-cyan-600 hover:text-cyan-200"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse…
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                Path on the machine running Fox Schema. A file that does not exist yet is
                created on first connect
                {selDialect === 'sqlite' ? '; `:memory:` opens a scratch database' : ''}.
              </p>
            </div>
          ) : (
            <div>
              <label className={labelCls}>Database Name</label>
              <input data-testid="conn-database-input" placeholder="my_database" value={form.database} onChange={(e) => updateField('database', e.target.value)} className={inputCls} />
            </div>
          )}

          {!isFileDialect && (
            <>
              {authChoices.length > 1 && (
                <div>
                  <label className={labelCls}>Login method</label>
                  <select
                    data-testid="conn-auth-method"
                    value={loginMethod}
                    onChange={(e) =>
                      updateField('authMethod', e.target.value as ConnectionAuthMethod)
                    }
                    className={inputCls}
                  >
                    {authChoices.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {loginMethod === 'windows' && (
                <div>
                  <label className={labelCls}>Domain</label>
                  <input
                    data-testid="conn-domain-input"
                    placeholder="CONTOSO"
                    value={form.domain || ''}
                    onChange={(e) => updateField('domain', e.target.value)}
                    className={inputCls}
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    Optional if Username is CONTOSO\alice. This is NTLM (Windows password), not
                    SSO.
                  </p>
                </div>
              )}

              {loginMethod === 'ldap' && selDialect === 'db2' && (
                <p
                  data-testid="conn-ldap-hint"
                  className="text-[11px] text-slate-400 leading-snug rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2"
                >
                  Db2 has no CREATE USER. Directory / LDAP is checked on the server — Fox Schema
                  still sends UID and the directory password (Authentication=SERVER_ENCRYPT).
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Username</label>
                  <input
                    data-testid="conn-username-input"
                    placeholder={loginMethod === 'windows' ? 'CONTOSO\\alice' : 'user'}
                    value={form.username}
                    onChange={(e) => updateField('username', e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>{passwordFieldLabel(loginMethod)}</label>
                  <PasswordInput
                    data-testid="conn-password-input"
                    placeholder={
                      isCredential && initialHasPassword && !form.password
                        ? '•••••••• (saved)'
                        : '••••••••'
                    }
                    value={form.password}
                    onChange={(e) => updateField('password', e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
            </>
          )}

          {isCredential && !isFileDialect && (
            <label className="flex items-center gap-2.5 text-xs text-slate-350 cursor-pointer select-none pt-1">
              <input
                data-testid="conn-save-password"
                type="checkbox"
                checked={savePassword}
                onChange={(e) => setSavePassword(e.target.checked)}
                className="w-4 h-4 rounded border-slate-800 bg-slate-950 text-cyan-600 focus:ring-0 focus:ring-offset-0"
              />
              Save password (encrypted)
              <span className="text-slate-500">— recommended; off = enter each session</span>
            </label>
          )}

          {!isFileDialect && (
          <div className="flex flex-col gap-2 pt-2">
            <label className="flex items-center gap-2.5 text-xs text-slate-350 cursor-pointer select-none">
              <input
                data-testid="conn-ssl-enabled"
                type="checkbox"
                checked={form.ssl?.enabled}
                onChange={(e) => setForm((prev) => ({ ...prev, ssl: { ...prev.ssl, enabled: e.target.checked } }))}
                className="w-4 h-4 rounded border-slate-800 bg-slate-950 text-cyan-600 focus:ring-0 focus:ring-offset-0"
              />
              Enable SSL Connection
            </label>
            {selDialect === 'db2' && form.ssl?.enabled && (
              <div>
                <label className={labelCls}>SSL server certificate</label>
                <textarea
                  data-testid="conn-ssl-ca-input"
                  rows={3}
                  placeholder="Absolute path to .arm / .pem / .crt, or paste the PEM. Not a Java .jks."
                  value={form.ssl?.ca ?? ''}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, ssl: { ...prev.ssl, enabled: true, ca: e.target.value } }))
                  }
                  className={`${inputCls} font-mono text-[11px] leading-snug`}
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  ibm_db needs the server certificate as a file. Use the TLS listener port (often 50001, not 50000).
                  Security=SSL alone is not enough for a self-signed or private CA.
                </p>
              </div>
            )}
          </div>
          )}

          <div>
            <label className={labelCls}>
              Schema{schemaRequired ? <span className="text-rose-400 ml-1">*</span> : <span className="text-slate-600 ml-1">(optional)</span>}
            </label>
            <div className="flex gap-2 mt-1">
              <div className="flex-1 min-w-0">
                <Autocomplete
                  data-testid="conn-schema-input"
                  value={form.schema ?? ''}
                  onChange={(v) => updateField('schema', v)}
                  options={[...new Set(schemaList)].map((s) => ({ value: s }))}
                  placeholder={
                    schemaList.length > 0
                      ? schemaRequired
                        ? 'Required — pick or type a schema'
                        : 'Leave blank for all schemas, or pick one'
                      : schemaRequired
                        ? 'Required — load or type schema name'
                        : 'Optional — leave blank or type a schema name'
                  }
                  className={`${inputCls} !mt-0`}
                />
              </div>
              <button
                data-testid="conn-load-schema-btn"
                onClick={loadSchemas}
                disabled={testingState.status === 'testing'}
                title="Connect and list available schemas"
                className="shrink-0 px-3 rounded text-xs font-bold bg-slate-800 border border-slate-700 hover:border-cyan-500/40 text-cyan-400 transition flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait cursor-pointer"
              >
                {testingState.status === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListTree className="w-3.5 h-3.5" />}
                Load Schema
              </button>
            </div>
          </div>

          {testingState.status !== 'idle' && (
            <div data-testid={`conn-test-${testingState.status}`} className={`mt-3 p-3 rounded-lg border flex items-start gap-2.5 text-xs ${
              testingState.status === 'testing' ? 'bg-slate-950/40 border-slate-800 text-slate-400'
                : testingState.status === 'success' ? 'bg-emerald-950/20 border-emerald-500/20 text-emerald-400'
                : 'bg-rose-950/20 border-rose-500/20 text-rose-400'
            }`}>
              {testingState.status === 'testing' && <Loader2 className="w-4 h-4 animate-spin text-slate-400 shrink-0 mt-0.5" />}
              {testingState.status === 'success' && <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />}
              {testingState.status === 'failed' && <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />}
              <div>
                <p className="font-semibold">
                  {testingState.status === 'testing' && 'Loading schemas…'}
                  {testingState.status === 'success' && 'Schemas loaded'}
                  {testingState.status === 'failed' && 'Connection Failed'}
                </p>
                {testingState.error && <p className="mt-1 text-slate-400 font-mono text-[10px] leading-relaxed break-all">{testingState.error}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end items-center gap-2 px-6 py-4 bg-slate-950/60 border-t border-slate-800">
          <button data-testid="conn-cancel" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-850/50 rounded transition">
            Cancel
          </button>
          <button
            data-testid="conn-save-btn"
            onClick={handleSave}
            disabled={testingState.status === 'testing'}
            className="px-4 py-2 text-xs font-bold accent-grad on-accent-fg rounded transition shadow-md cursor-pointer disabled:opacity-60 disabled:cursor-wait flex items-center gap-1.5"
          >
            {isCredential ? 'Save Credential' : 'Apply & Connect'}
          </button>
        </div>
      </div>
    </div>
    </>,
    document.body
  );
};
