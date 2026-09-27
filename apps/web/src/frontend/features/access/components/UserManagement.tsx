/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * User Management — list accounts from the database, then generate Add / Edit /
 * Drop SQL to review and run yourself. Fox Schema never applies the SQL and
 * never asks for a real password (placeholders only).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandModeToggle } from '@/shared/components/CommandModeToggle';
import { PasswordInput } from '@/shared/components/PasswordInput';
import {
  Copy,
  Check,
  AlertTriangle,
  ShieldAlert,
  Info,
  UserCog,
  KeyRound,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  Users,
  X,
} from 'lucide-react';
import {
  PASSWORD_PLACEHOLDER,
  buildUserSql,
  buildDb2OsUserInstructions,
  userManagementSupport,
  userCreateModes,
  type UserCreateMode,
  dialectSupportsDbAccess,
  privilegesForPrincipal,
  type DbPrincipal,
  type DbPrivilege,
  type PrincipalType,
  type UserAction,
  type UserAlteration,
  type UserRequest,
  generateDb2OsPassword,
  validateDb2OsPassword,
  DB2_OS_PASSWORD_LENGTH,
  type Db2RunMode,
  DB2_DOCKER_CONTAINER,
  DEFAULT_DB2_RUN_MODE,
  osAccountSteps,
  accessCapabilities,
  buildAccessSql,
  highestRisk,
  type AccessPermission,
  type AccessScope,
  type PermissionRequest,
} from '../lib/access';
import { EmptyState, Field, RISK_STYLE, Segmented, inputCls } from './controls';
import { Autocomplete } from '@/shared/components/Autocomplete';
import { ObjectPicker } from './ObjectPicker';
import { useAccessCatalog } from '../lib/useAccessCatalog';
import {
  generateSuggestedPassword,
  sqlNeedsPassword,
  sqlWithPasswordSubstitute,
} from '../lib/password-suggest';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { fetchDbAccess } from '@/shared/api/schemaApi';
import {
  ALTERATION_LABEL,
  availableAlterations,
  dropSafetyNotes,
} from '../lib/accountAlterations';
import type { AccessPrincipalDraft } from '../lib/access';
import { writeClipboard } from '@/shared/utils/clipboard';
import { describeAllowAll, dialectFamily, findAllowAllByName, type AllowAll } from '@foxschema/sql';

type Mode = 'idle' | 'add' | 'edit' | 'drop' | 'list';


function parseMysqlAccount(raw: string): { name: string; host?: string } {
  const s = raw.trim().replace(/^'|'$/g, '');
  const at = s.lastIndexOf('@');
  if (at <= 0) return { name: s };
  return {
    name: s.slice(0, at).replace(/^'|'$/g, ''),
    host: s.slice(at + 1).replace(/^'|'$/g, '') || '%',
  };
}

function principalTypeOf(p: DbPrincipal): PrincipalType {
  return p.kind === 'user' ? 'user' : 'role';
}

/** Short, dialect-specific coaching shown after a connection is chosen. */
function dialectCoach(dialect: string): string | null {
  const d = dialect.toLowerCase();
  if (d === 'postgres' || d === 'cockroachdb' || d === 'yugabytedb') {
    return 'PostgreSQL treats a user as a role with LOGIN. The list shows Name, Type, Roles, and whether login is allowed.';
  }
  if (d === 'redshift') {
    return 'Redshift uses USER and GROUP (not ROLE). Prefer groups for shared privileges, then grant the group to users.';
  }
  if (['mysql', 'mariadb', 'tidb'].includes(d)) {
    return 'Accounts are identified as name@host. The same username with a different host is a different account — Host is required when adding a user.';
  }
  if (dialectFamily(d) === 'sqlserver') {
    return 'SQL Server separates server LOGIN from database USER. Add user generates both statements — run the login against master, then the user against this database.';
  }
  if (d === 'oracle') {
    return 'Oracle needs CREATE SESSION to log in (included in Add user). Rename is not supported here; Drop can optionally CASCADE owned objects.';
  }
  if (d === 'db2') {
    return 'Db2 authenticates OS / LDAP logins — there is no CREATE USER. Add user (OS) creates the Linux account and GRANT CONNECT. Edit → Set password / Disable login / Enable login emit docker steps (chpasswd, passwd -l / -u). Grant access assigns table privileges.';
  }
  if (d === 'clickhouse') {
    return 'ClickHouse supports create / rename / drop here. Account lock (disable) is not available — drop or revoke privileges instead.';
  }
  return 'Review the user and role list, choose Add / Edit / Drop, then copy the SQL preview. Fox Schema never applies it for you.';
}

export const UserManagement: React.FC<{
  onGrantAccess?: (draft: AccessPrincipalDraft) => void;
  lockedConnectionId?: string;
  onConnectionChange?: (id: string) => void;
}> = ({ onGrantAccess, lockedConnectionId, onConnectionChange }) => {
  const connections = useSyncStore((s) => s.connections);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);

  const [localConnectionId, setLocalConnectionId] = useState('');
  const connectionId = lockedConnectionId ?? localConnectionId;
  const pickConnection = (id: string) => {
    onConnectionChange?.(id);
    if (lockedConnectionId === undefined) setLocalConnectionId(id);
  };
  const conn = connections.find((c) => c.id === connectionId) || null;
  const accessCatalog = useAccessCatalog(connectionId, conn);
  const dialect = conn?.dialect ?? '';

  const [principals, setPrincipals] = useState<DbPrincipal[]>([]);
  const [privileges, setPrivileges] = useState<DbPrivilege[]>([]);
  const [listHint, setListHint] = useState<string | null>(null);
  const [listWarning, setListWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'user' | 'role'>('all');

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');

  const [principalType, setPrincipalType] = useState<PrincipalType>('user');
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [alteration, setAlteration] = useState<UserAlteration>('password');
  const [validUntil, setValidUntil] = useState('');
  const [host, setHost] = useState('%');
  const [cascade, setCascade] = useState(false);
  const [osRole, setOsRole] = useState('');
  /**
   * The OS password for a Db2 account.
   *
   * Component state only — never stored, never sent to the server. It reaches
   * the generated chpasswd command and the clipboard, and nowhere else.
   */
  const [osPassword, setOsPassword] = useState('');
  /**
   * Where the OS-level commands are meant to run — Db2's whole procedure, and
   * the OS-account steps other engines offer for socket authentication.
   *
   * The compose file puts these databases in containers, but a real
   * installation is a server with a shell, where a `docker exec` prefix would
   * simply fail.
   */
  const [db2RunMode, setDb2RunMode] = useState<Db2RunMode>(DEFAULT_DB2_RUN_MODE);
  /**
   * The access a new account needs before it can do anything.
   *
   * Creating an account and letting it in are two different statements on every
   * engine, and they used to be two different screens: CREATE USER here, then
   * the permissions tab, re-picking the same connection and re-typing the same
   * name to say "and it may connect to this database". An account that cannot
   * reach a database is not a finished account, so the grants are offered where
   * the account is made.
   *
   * Object-level privileges stay in the permissions grid. What belongs here is
   * only what the account itself is scoped to: which databases, which schemas.
   */
  const [grantDatabases, setGrantDatabases] = useState<string[]>([]);
  const [grantSchemas, setGrantSchemas] = useState<string[]>([]);
  /**
   * Existing roles and groups the new account joins. Picked from the catalog
   * rather than typed: the roles were listed on this very screen, and the form
   * used to offer no way to use them.
   */
  const [memberRoles, setMemberRoles] = useState<string[]>([]);
  const osPasswordError = osPassword ? validateDb2OsPassword(osPassword) : null;
  const [copied, setCopied] = useState(false);
  const [copiedWithPassword, setCopiedWithPassword] = useState(false);
  /**
   * The password just copied, shown once so it can be recorded.
   *
   * Fox Schema does not store passwords and the SQL preview keeps the
   * `<password>` placeholder — that stays true. But copying SQL that contains a
   * credential nobody has seen means the account is created and its password is
   * only on the clipboard: there is no way to tell the new user what it is
   * without pasting it somewhere first. Db2 already shows its password, for its
   * own reasons; this makes the rest consistent without putting one in the
   * preview.
   *
   * Held in component state only. It is cleared whenever the generated
   * statement changes (`sqlText`) and on dismiss, and never reaches the store,
   * the history, or a log.
   */
  const [shownPassword, setShownPassword] = useState<string | null>(null);
  /**
   * What the clipboard actually holds relative to `shownPassword`.
   *
   * Shared write-status used to live on both Copy buttons, so a later
   * successful Copy SQL (placeholder SQL) would flip the panel to claim the
   * generated password was on the clipboard.
   */
  const [passwordClipboard, setPasswordClipboard] = useState<
    'on-clipboard' | 'blocked' | 'preview-copied' | null
  >(null);
  // A password the reader typed. Held in component state only: it is cleared on
  // any change to the form, never written to the store, never sent to the
  // server, and never entered in history.
  const [sqlPassword, setSqlPassword] = useState('');

  const support = useMemo(() => userManagementSupport(dialect), [dialect]);
  /**
   * SQL or command line, per what this engine can actually do.
   *
   * Db2 has no CREATE USER, so "Add user" there always meant shell commands —
   * the form just did not say so until it had produced them. The choice is
   * stated up front now, with the reason, and collapses to a single line when
   * the engine offers only one route.
   */
  const createModes = useMemo(() => userCreateModes(dialect), [dialect]);
  const [createMode, setCreateMode] = useState<UserCreateMode>(createModes.preferred);
  // A different engine has different modes; keeping the old pick would leave
  // the form on a route this dialect cannot take.
  useEffect(() => {
    setCreateMode(createModes.preferred);
  }, [createModes]);
  const activeMode = createModes.options.find((o) => o.mode === createMode);
  const coach = useMemo(() => (dialect ? dialectCoach(dialect) : null), [dialect]);
  const listSupport = useMemo(
    () => (dialect ? dialectSupportsDbAccess(dialect) : null),
    [dialect]
  );
  const isMysqlFamily = ['mysql', 'mariadb', 'tidb'].includes(dialect.toLowerCase());
  const isOracle = dialect.toLowerCase() === 'oracle';
  const isSqlServer = ['sqlserver', 'azuresql'].includes(dialect.toLowerCase());
  const isDb2 = dialect.toLowerCase() === 'db2';
  const accessPrincipalName =
    isMysqlFamily && principalType === 'user'
      ? `${name.trim()}@${(host || '%').trim() || '%'}`
      : isDb2 && principalType === 'user'
        ? name.trim().toUpperCase()
        : name.trim();

  const editOptions = useMemo(
    () => availableAlterations(support, principalType),
    [support, principalType]
  );

  useEffect(() => {
    if (mode === 'edit' && editOptions.length && !editOptions.includes(alteration)) {
      setAlteration(editOptions[0]!);
    }
  }, [mode, editOptions, alteration]);

  const selected = useMemo(
    () => principals.find((p) => p.name === selectedName) ?? null,
    [principals, selectedName]
  );

  const dropNotes = useMemo(() => {
    if (mode !== 'drop' || !selected) return [];
    return dropSafetyNotes(selected, privileges);
  }, [mode, selected, privileges]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return principals.filter((p) => {
      if (kindFilter === 'user' && p.kind !== 'user') return false;
      if (kindFilter === 'role' && p.kind === 'user') return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.memberOf.some((r) => r.toLowerCase().includes(q)) ||
        p.kind.toLowerCase().includes(q)
      );
    });
  }, [principals, filter, kindFilter]);

  /** Accounts allowed everything — superuser, all of `*.*`, or the whole database. */
  const allowAllByName = useMemo(
    () =>
      dialect ? findAllowAllByName({ principals, privileges, dialect }) : new Map<string, AllowAll>(),
    [principals, privileges, dialect]
  );

  const nameOptions = useMemo(
    () =>
      principals
        .filter((p) => (principalType === 'user' ? p.kind === 'user' : p.kind !== 'user'))
        .map((p) => ({ value: p.name, hint: p.kind })),
    [principals, principalType]
  );

  const roleOptions = useMemo(
    () => principals.filter((p) => p.kind !== 'user').map((p) => ({ value: p.name, hint: 'role' })),
    [principals]
  );

  const action: UserAction =
    mode === 'add' ? 'create' : mode === 'drop' ? 'drop' : mode === 'edit' ? 'alter' : 'create';

  const request: UserRequest = useMemo(
    () => ({
      action,
      principalType,
      name,
      newName,
      alteration,
      validUntil: alteration === 'expire' ? validUntil : undefined,
      // Roles carry the host too: a MySQL role is `'r'@'%'`, and a role listed
      // with another host must be dropped by that one. MariaDB ignores it.
      host: isMysqlFamily ? host : undefined,
      cascade,
      roles: action === 'create' ? memberRoles : undefined,
    }),
    [action, principalType, name, newName, alteration, validUntil, host, isMysqlFamily, cascade, memberRoles]
  );

  const generated = useMemo(() => {
    if (mode === 'idle' || !dialect) return null;
    // Listing is about every account, so it does not need a name typed.
    if (mode === 'list') {
      return buildDb2OsUserInstructions({
        name: '',
        action: 'list',
        database: conn?.database,
        runMode: db2RunMode,
      });
    }
    if (!name.trim()) return null;
    if (isDb2 && principalType === 'user') {
      if (mode === 'add') {
        return buildDb2OsUserInstructions({
          name,
          role: osRole,
          database: conn?.database,
          password: osPassword || undefined,
          runMode: db2RunMode,
        });
      }
      if (
        mode === 'edit' &&
        (alteration === 'password' || alteration === 'disable' || alteration === 'enable')
      ) {
        return buildDb2OsUserInstructions({
          name,
          database: conn?.database,
          action: alteration,
          password: alteration === 'password' ? osPassword || undefined : undefined,
          runMode: db2RunMode,
        });
      }
      if (mode === 'drop') {
        // Removing a Db2 account is an OS operation, like adding one. Routed
        // here rather than through buildUserSql so it honours the run-mode
        // toggle and this connection's database, as add and edit already do.
        return buildDb2OsUserInstructions({
          name,
          database: conn?.database,
          action: 'drop',
          runMode: db2RunMode,
        });
      }
    }
    return buildUserSql(request, dialect);
  }, [mode, dialect, name, request, isDb2, principalType, osRole, conn?.database, alteration, osPassword, db2RunMode]);

  const accessCaps = useMemo(() => accessCapabilities(dialect), [dialect]);

  /**
   * Grants that let the new account in, appended to the CREATE statements.
   *
   * Only offered while adding: editing an existing account's access is the
   * permissions grid's job, and a checkbox here would silently re-grant on
   * every save. Only the scopes the engine actually has — MySQL, MariaDB, TiDB
   * and Oracle have no schema-level GRANT, so their list is databases alone.
   */
  const accessGrants = useMemo(() => {
    if (mode !== 'add' || !dialect || !name.trim()) return null;
    // Engines with CONNECT grant that at database scope. MySQL-family engines
    // have no CONNECT privilege: an account exists server-wide, and SELECT on
    // db.* is the narrow grant that lets it use the database selected here.
    // Schema `read` also includes whatever reachability the engine requires,
    // such as PostgreSQL USAGE.
    const scoped: { scope: AccessScope; permissions: AccessPermission[] }[] = [
      ...grantDatabases.map((database) => ({
        scope: { type: 'database', database } as AccessScope,
        permissions: [
          accessCaps.connectPrivilege ? 'connect' : 'read',
        ] as AccessPermission[],
      })),
      ...grantSchemas.map((schemaName) => ({
        scope: { type: 'schema', schema: schemaName } as AccessScope,
        permissions: ['read'] as AccessPermission[],
      })),
    ];
    if (scoped.length === 0) return null;
    const generatedPerScope = scoped.map(({ scope, permissions }) => {
      const request: PermissionRequest = {
        principal: { type: principalType, name: accessPrincipalName },
        action: 'grant',
        scope,
        permissions,
      };
      return buildAccessSql(request, dialect);
    });
    return {
      statements: generatedPerScope.flatMap((g) => ('error' in g ? [] : g.statements)),
      warnings: generatedPerScope.flatMap((g) => ('error' in g ? [] : g.warnings)),
      errors: generatedPerScope.flatMap((g) => ('error' in g ? [g.error] : [])),
    };
  }, [
    mode,
    dialect,
    name,
    principalType,
    accessPrincipalName,
    accessCaps.connectPrivilege,
    grantDatabases,
    grantSchemas,
  ]);

  const osAccount = useMemo(() => {
    if (isDb2 || !dialect || !name.trim()) return null;
    return osAccountSteps(dialect, {
      name,
      runMode: db2RunMode,
      database: conn?.database,
    });
  }, [isDb2, dialect, name, db2RunMode, conn?.database]);

  /** What the generator produced, placeholder intact. */
  const rawSqlText =
    generated && !('error' in generated)
      ? generated.statements.map((s) => s.sql).join('\n\n')
      : '';

  /**
   * Put a typed password into a statement for display and copying.
   *
   * Db2's OS password already appears in its commands, and splitting the
   * behaviour by engine — typed here, hidden there — is how a reader ends up
   * running `IDENTIFIED BY '<password>'` believing the field had been applied.
   */
  const applyPassword = useCallback(
    (sql: string) => (sqlPassword ? sqlWithPasswordSubstitute(sql, sqlPassword, dialect) : sql),
    [sqlPassword, dialect]
  );

  const sqlText = applyPassword(rawSqlText);

  const grantDraft = useMemo((): AccessPrincipalDraft | null => {
    if (!onGrantAccess || !connectionId) return null;
    if (mode === 'add' && name.trim() && generated && !('error' in generated)) {
      // MySQL-family accounts are name@host. Permission Builder / formatDbGrantee
      // need the host or GRANT targets `` `user` `` instead of 'user'@'%'.
      return { connectionId, principalName: accessPrincipalName, principalType };
    }
    if (selected) {
      return {
        connectionId,
        principalName: selected.name,
        principalType: principalTypeOf(selected),
      };
    }
    return null;
  }, [
    onGrantAccess,
    connectionId,
    mode,
    name,
    accessPrincipalName,
    generated,
    principalType,
    selected,
  ]);

  const readyForGrant = Boolean(grantDraft);

  /**
   * Which catalog read is the current one.
   *
   * A read takes as long as the engine takes, and Oracle's is slow. Pick a
   * different connection while one is in flight and its response used to arrive
   * afterwards and repaint the list — so the panel showed one database's
   * accounts under another database's name. On a screen whose buttons drop
   * users and grant privileges, acting on the wrong list is the worst thing
   * this component can do, so a superseded response is discarded.
   */
  const loadToken = useRef(0);

  const loadPrincipals = useCallback(async (opts?: { force?: boolean }) => {
    if (!connectionId) return;
    if (listSupport && !listSupport.query) {
      setPrincipals([]);
      setPrivileges([]);
      setListHint(listSupport.hint || 'This engine has no user catalog to list.');
      setListWarning(null);
      setListError(null);
      return;
    }
    const token = ++loadToken.current;
    const superseded = () => loadToken.current !== token;
    setLoading(true);
    setListError(null);
    try {
      const res = await fetchDbAccess(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        { schema: conn?.schema || undefined, force: opts?.force === true }
      );
      if (superseded()) return;
      setPrincipals(res.principals ?? []);
      setPrivileges(res.privileges ?? []);
      setListHint(res.support?.hint || null);
      setListWarning(res.warning || null);
      if (selectedName && !(res.principals ?? []).some((p) => p.name === selectedName)) {
        setSelectedName(null);
        if (mode !== 'add') setMode('idle');
      }
    } catch (e: unknown) {
      if (superseded()) return;
      setPrincipals([]);
      setPrivileges([]);
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      // Only the newest read owns the spinner; an older one finishing must not
      // report the current one as done.
      if (!superseded()) setLoading(false);
    }
  }, [connectionId, listSupport, sessionPasswords, conn?.schema, selectedName, mode]);

  useEffect(() => {
    // Leaving a connection invalidates any read still in flight for it, so the
    // cleared list cannot be repainted by the connection just left.
    loadToken.current++;
    setPrincipals([]);
    setPrivileges([]);
    setSelectedName(null);
    setMode('idle');
    setOsPassword('');
    setListError(null);
    setListHint(null);
    setListWarning(null);
    setName('');
    setFilter('');
    setMemberRoles([]);
  }, [connectionId]);

  useEffect(() => {
    if (connectionId && listSupport?.query) {
      void loadPrincipals();
    }
  }, [connectionId]); // eslint-disable-line react-hooks/exhaustive-deps -- load once per connection

  const startAdd = (type: PrincipalType) => {
    setMode('add');
    setSelectedName(null);
    setPrincipalType(type);
    setName('');
    setNewName('');
    setHost('%');
    setCascade(false);
    setOsRole('');
    setOsPassword('');
    setAlteration('password');
  };

  const startDrop = (p: DbPrincipal) => {
    setMode('drop');
    setSelectedName(p.name);
    setPrincipalType(principalTypeOf(p));
    // Users and MySQL/TiDB roles are listed as name@host; a MariaDB role has
    // no @ and parses to its bare name.
    if (isMysqlFamily) {
      const parsed = parseMysqlAccount(p.name);
      setName(parsed.name);
      setHost(parsed.host || '%');
    } else {
      setName(p.name);
    }
    setCascade(false);
  };

  const startEdit = (p: DbPrincipal) => {
    setMode('edit');
    setSelectedName(p.name);
    setPrincipalType(principalTypeOf(p));
    // Users and MySQL/TiDB roles are listed as name@host; a MariaDB role has
    // no @ and parses to its bare name.
    if (isMysqlFamily) {
      const parsed = parseMysqlAccount(p.name);
      setName(parsed.name);
      setHost(parsed.host || '%');
    } else {
      setName(p.name);
    }
    setNewName('');
    setAlteration(p.kind === 'user' ? 'password' : 'rename');
  };

  const selectRow = (p: DbPrincipal) => {
    setSelectedName(p.name);
    if (mode === 'add') setMode('idle');
    else if (mode === 'drop') startDrop(p);
    else if (mode === 'edit') startEdit(p);
  };

  const copy = async () => {
    if (!sqlText) return;
    if (!(await writeClipboard(sqlText))) return;
    // Clipboard now holds the preview, which still reads <password>.
    if (shownPassword) setPasswordClipboard('preview-copied');
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  // A shown password belongs to one specific statement. sqlText is that
  // statement — host, expiry, rename, cascade, and the rest all rewrite it.
  // A stale password on screen is worse than none: it invites recording a
  // credential the SQL no longer sets.
  useEffect(() => {
    setShownPassword(null);
    setPasswordClipboard(null);
    // Carrying a password across a change of statement would put it into DDL
    // the reader never reviewed.
    setSqlPassword('');
    // Keyed on the *raw* statement, not the displayed one. `sqlText` now has
    // the typed password substituted into it, so keying on that would mean
    // every keystroke changed sqlText, which cleared the password, which
    // changed sqlText back — the field wiping itself as it was typed.
  }, [rawSqlText]);

  const copyWithGeneratedPassword = async () => {
    if (!rawSqlText || !sqlNeedsPassword(rawSqlText)) return;
    // The generated password replaces anything typed. Leaving both would put
    // one credential on the clipboard while the field showed another.
    setSqlPassword('');
    const password = generateSuggestedPassword();
    const ok = await writeClipboard(sqlWithPasswordSubstitute(rawSqlText, password, dialect));
    // Shown whether or not the clipboard accepted it, and until dismissed rather
    // than on a timer. It is the only copy of a credential that is about to
    // exist on a database: if the clipboard refused, this panel is the one place
    // it can still be read, and a toast that fades after two seconds is not
    // somewhere to read a 20-character password from either way.
    setShownPassword(password);
    setPasswordClipboard(ok ? 'on-clipboard' : 'blocked');
    if (!ok) return;
    setCopiedWithPassword(true);
    setTimeout(() => setCopiedWithPassword(false), 2500);
  };

  const showPasswordCopy = Boolean(rawSqlText && sqlNeedsPassword(rawSqlText));

  // The same sentence used to run under all three of these, telling everyone to
  // substitute a password by hand. That is only true in the last case: with the
  // copy button the substitution is done for you, and on Db2 a filled-in field
  // is already in the commands. Being told to replace a password that is
  // already set is how someone runs a CREATE USER with the literal text
  // `<password>` as the credential.
  //
  // A non-empty OS field is not enough: generation still returns nothing when
  // the name is empty, and an invalid password is an error, not commands.
  //
  // Read from the raw statement, not the displayed one: a typed password
  // substituted into `sqlText` would make this read as "already in the
  // commands" on engines that have no OS account at all.
  const passwordInCommands =
    Boolean(osPassword) &&
    Boolean(rawSqlText) &&
    generated != null &&
    !('error' in generated) &&
    !sqlNeedsPassword(rawSqlText);

  const passwordHint = sqlPassword
    ? 'The password above is already in the statement on the right; copy it as it is.'
    : showPasswordCopy
    ? 'Type a password above, or use “Copy with generated password” to fill one in — it is shown once so you can pass it on.'
    : passwordInCommands
      ? 'The password above is already in the commands below; copy them as they are.'
      : `Commands use ${PASSWORD_PLACEHOLDER} — replace it before you run them.`;

  const goGrantAccess = () => {
    if (!grantDraft || !onGrantAccess) return;
    onGrantAccess(grantDraft);
  };

  const noun = principalType === 'user' ? 'user' : 'role';

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="user-management">
      {/* How this works */}
      <div
        data-testid="user-howto"
        className="shrink-0 border-b border-slate-800 bg-slate-950/80 px-5 py-3"
      >
        <div className="flex items-start gap-2">
          <Users className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-100">How User Management works</p>
            <ol className="mt-1 grid gap-0.5 text-[11px] text-slate-400 sm:grid-cols-2 lg:grid-cols-5">
              <li>
                <span className="font-semibold text-slate-300">1.</span> Choose a database
                connection
              </li>
              <li>
                <span className="font-semibold text-slate-300">2.</span> Review the user / role list
              </li>
              <li>
                <span className="font-semibold text-slate-300">3.</span> Add, edit, or drop one
                account
              </li>
              <li>
                <span className="font-semibold text-slate-300">4.</span> Check the SQL preview on the
                right
              </li>
              <li>
                <span className="font-semibold text-slate-300">5.</span> Copy SQL and run it yourself
                — Fox Schema never applies it
              </li>
            </ol>
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ── Left: connection + list + action form ─────────────────── */}
        <div className="w-[52%] min-w-[400px] border-r border-slate-800 p-4 flex flex-col gap-3 min-h-0 overflow-hidden">
          <div className="shrink-0 flex flex-col gap-3">
          <div className={lockedConnectionId !== undefined ? 'sr-only' : undefined}>
          <Field label="Database connection">
            <div className="flex gap-2">
              <select
                data-testid="user-connection"
                value={connectionId}
                onChange={(e) => pickConnection(e.target.value)}
                className={`${inputCls} flex-1`}
              >
                <option value="">Select a connection…</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.dialect}
                  </option>
                ))}
              </select>
              {lockedConnectionId === undefined && (
              <button
                type="button"
                data-testid="user-refresh"
                onClick={() => void loadPrincipals({ force: true })}
                disabled={!connectionId || loading || listSupport?.query === false}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 text-[11px] font-semibold text-slate-200 disabled:opacity-40"
                title="Reload users and roles from the database"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Loading…' : 'Refresh'}
              </button>
              )}
            </div>
          </Field>
          </div>
          {lockedConnectionId !== undefined && (
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="user-refresh"
                onClick={() => void loadPrincipals({ force: true })}
                disabled={!connectionId || loading || listSupport?.query === false}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 text-[11px] font-semibold text-slate-200 disabled:opacity-40"
                title="Reload users and roles from the database"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          )}

          {!connectionId && (
            <EmptyState
              title="Select a database"
              body="Pick a saved connection above. Fox Schema will list users and roles from that database so you can add, edit, or drop them with generated SQL."
            />
          )}

          {dialect && !support.supported && (
            <div
              data-testid="user-unsupported"
              className="rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2.5 text-[11px] text-slate-400"
            >
              {support.reason}
            </div>
          )}

          {listError && (
            <div
              data-testid="user-list-error"
              className="rounded-md border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200"
            >
              {listError}
            </div>
          )}

          {listWarning && (
            <div className="rounded-md border border-amber-500/35 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-200">
              {listWarning}
            </div>
          )}

          {coach && support.supported && (
            <div
              data-testid="user-dialect-coach"
              className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-100"
            >
              <span className="font-bold text-sky-50">{dialect}</span>
              <span className="text-sky-200/90"> — {coach}</span>
            </div>
          )}
          </div>

          {connectionId && support.supported && (
            <>
              <div className="shrink-0 flex flex-wrap items-center gap-2">
                {(support.canCreateUser || isDb2) && (
                <button
                  type="button"
                  data-testid="user-add-user"
                  onClick={() => startAdd('user')}
                  title={
                    isDb2
                      ? 'Generate OS-user + GRANT CONNECT steps for the foxschema-db2 container'
                      : 'Generate CREATE USER SQL'
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-[11px] font-bold text-emerald-100"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {isDb2 ? 'Add user (OS)' : 'Add user'}
                </button>
                )}
                {isDb2 && (
                  <button
                    type="button"
                    data-testid="user-list-commands"
                    onClick={() => {
                      setMode('list');
                      setSelectedName(null);
                      setOsPassword('');
                    }}
                    title="Generate commands to list OS logins and Db2 authorization IDs"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-600 bg-slate-800 text-[11px] font-bold text-slate-100 hover:bg-slate-700"
                  >
                    Check users
                  </button>
                )}
                {support.canCreateRole && (
                <button
                  type="button"
                  data-testid="user-add-role"
                  onClick={() => startAdd('role')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-sky-500/40 bg-sky-500/10 text-[11px] font-bold text-sky-100"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add role
                </button>
                )}
                {!support.canCreateUser && !isDb2 && support.reason && (
                  <p data-testid="user-create-blocked" className="text-[11px] text-amber-200/90">
                    {support.reason}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="user-edit-selected"
                  onClick={() => selected && startEdit(selected)}
                  disabled={!selected || editOptions.length === 0}
                  title={
                    editOptions.length === 0
                      ? 'No edit actions are available on this engine for the selected account'
                      : 'Generate ALTER SQL for the selected account'
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-600 text-[11px] font-bold text-slate-200 disabled:opacity-40"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="user-drop-selected"
                  onClick={() => selected && startDrop(selected)}
                  disabled={!selected}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-500/40 bg-rose-500/10 text-[11px] font-bold text-rose-100 disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Drop
                </button>
                {onGrantAccess && (
                  <button
                    type="button"
                    data-testid="user-grant-selected"
                    onClick={goGrantAccess}
                    disabled={!readyForGrant}
                    title="Open Permission Builder for the selected (or newly named) account"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-violet-500/40 bg-violet-500/10 text-[11px] font-bold text-violet-100 disabled:opacity-40"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Grant access
                  </button>
                )}
              </div>

              <div className="shrink-0 flex flex-wrap gap-2 items-center">
                <input
                  data-testid="user-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by name or role…"
                  className={`${inputCls} flex-1 min-w-[10rem]`}
                />
                <Segmented
                  testId="user-kind-filter"
                  value={kindFilter}
                  onChange={(v) => setKindFilter(v as 'all' | 'user' | 'role')}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'user', label: 'Users' },
                    { value: 'role', label: 'Roles' },
                  ]}
                />
              </div>

              <div
                data-testid="user-list"
                className="flex-1 min-h-[10rem] overflow-y-auto overscroll-contain rounded-md border border-slate-800"
              >
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 text-slate-500 uppercase tracking-wide">
                    <tr>
                      <th className="px-2.5 py-1.5 font-bold">Name</th>
                      <th className="px-2.5 py-1.5 font-bold">Type</th>
                      <th className="px-2.5 py-1.5 font-bold">Roles</th>
                      <th className="px-2.5 py-1.5 font-bold">Login</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && principals.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-2.5 py-6 text-center text-slate-500">
                          Reading users and roles…
                        </td>
                      </tr>
                    )}
                    {!loading && filtered.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-2.5 py-6 text-center text-slate-500"
                          data-testid="user-list-empty"
                        >
                          {listSupport && !listSupport.query
                            ? listSupport.hint || 'No user catalog on this engine.'
                            : listHint ||
                              (isDb2
                                ? 'No users with CONNECT (or roles) yet. Use Add user (OS), run the commands, then reload.'
                                : 'No users or roles found. Use Add user / Add role to generate CREATE SQL.')}
                        </td>
                      </tr>
                    )}
                    {filtered.map((p) => {
                      const active = selectedName === p.name;
                      const allow = allowAllByName.get(p.name);
                      return (
                        <tr
                          key={`${p.kind}:${p.name}`}
                          data-testid={`user-row-${p.name}`}
                          // The testid keys on name because a MySQL account is
                          // `report_user@%`, so a test cannot read the kind out
                          // of it. A list mixing users with roles is the normal
                          // case on every engine that has both.
                          data-kind={p.kind}
                          onClick={() => selectRow(p)}
                          onDoubleClick={() => startEdit(p)}
                          title="Click to select · Double-click to edit"
                          className={`cursor-pointer border-b border-slate-800/80 ${
                            active
                              ? 'bg-sky-500/15 text-slate-100'
                              : 'text-slate-300 hover:bg-slate-900/80'
                          }`}
                        >
                          <td className="px-2.5 py-1.5 font-mono text-[12px]">
                            {p.name}
                            {allow && (
                              <span
                                data-testid={`user-allow-all-${p.name}`}
                                title={describeAllowAll(allow)}
                                className="ml-1.5 inline-block rounded border border-rose-500/40 bg-rose-500/10 px-1 font-sans text-[9px] font-bold uppercase tracking-wide text-rose-200"
                              >
                                {allow.kind === 'superuser' ? 'superuser' : 'allow-all'}
                              </span>
                            )}
                          </td>
                          <td className="px-2.5 py-1.5 capitalize">{p.kind}</td>
                          <td className="px-2.5 py-1.5 text-slate-400 truncate max-w-[10rem]" title={p.memberOf.join(', ')}>
                            {p.memberOf.length ? p.memberOf.join(', ') : '—'}
                          </td>
                          <td className="px-2.5 py-1.5">
                            {p.canLogin === true ? 'Yes' : p.canLogin === false ? 'No' : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {mode !== 'idle' && (
                <div
                  data-testid="user-action-form"
                  className="shrink-0 max-h-[40%] overflow-y-auto rounded-md border border-slate-700 bg-slate-900/40 p-3 flex flex-col gap-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                      {mode === 'add' && `Add ${noun}`}
                      {mode === 'edit' && `Edit ${selected?.name || noun}`}
                      {mode === 'drop' && `Drop ${selected?.name || noun}`}
                    </p>
                    <button
                      type="button"
                      data-testid="user-cancel-action"
                      onClick={() => {
                        setMode('idle');
                        setOsPassword('');
                        setName('');
                      }}
                      className="text-[11px] text-slate-500 hover:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>

                  {mode === 'add' && principalType === 'user' && (
                    <Field
                      label="How is this account created?"
                      hint={activeMode?.reason}
                    >
                      {createModes.singleChoice ? (
                        // One route means no choice; a toggle here would offer
                        // a decision the engine has already made.
                        <span
                          data-testid="user-create-mode-only"
                          className="text-[11px] font-bold text-slate-200"
                        >
                          {createModes.options.find((o) => o.available)?.label ?? 'Not available'}
                        </span>
                      ) : (
                        <Segmented
                          testId="user-create-mode"
                          value={createMode}
                          onChange={(v) => setCreateMode(v as UserCreateMode)}
                          options={createModes.options
                            .filter((o) => o.available)
                            .map((o) => ({ value: o.mode, label: o.label }))}
                        />
                      )}
                    </Field>
                  )}

                  {mode === 'add' && (
                    <Field label="What are you adding?">
                      <Segmented
                        testId="user-type"
                        value={principalType}
                        onChange={(v) => setPrincipalType(v as PrincipalType)}
                        options={[
                          ...(support.canCreateUser || isDb2
                            ? [{ value: 'user', label: 'User (logs in)' }]
                            : []),
                          ...(support.canCreateRole
                            ? [{ value: 'role', label: 'Role (holds privileges)' }]
                            : []),
                        ]}
                      />
                    </Field>
                  )}

                  <Field
                    label={mode === 'add' ? `New ${noun} name` : `${noun} name`}
                    hint={
                      mode === 'drop'
                        ? 'Drop removes the account. Privileges granted to it go with it.'
                        : undefined
                    }
                  >
                    {mode === 'add' ? (
                      <Autocomplete
                        data-testid="user-name"
                        theme="slate"
                        value={name}
                        onChange={setName}
                        options={nameOptions}
                        placeholder={principalType === 'user' ? 'report_user' : 'reporting_reader'}
                      />
                    ) : (
                      <input
                        data-testid="user-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={mode === 'drop' || mode === 'edit'}
                        placeholder={principalType === 'user' ? 'report_user' : 'reporting_reader'}
                        className={inputCls}
                      />
                    )}
                  </Field>

                  {!isDb2 && showPasswordCopy && (
                    <Field
                      label="Password"
                      hint={
                        sqlPassword
                          ? 'Written into the statement on the right. Fox Schema does not store it, send it anywhere, or keep it in history.'
                          : 'Optional. Leave empty to keep the <password> placeholder and fill it in yourself.'
                      }
                    >
                      <div className="flex items-center gap-2">
                        <PasswordInput
                          data-testid="user-sql-password"
                          value={sqlPassword}
                          onChange={(e) => {
                            setSqlPassword(e.target.value);
                            // The generated-password panel says the preview
                            // still reads `<password>` and that only the
                            // clipboard has the secret. Both stop being true
                            // once a typed value is substituted, and the two
                            // passwords would be different — so the panel goes
                            // rather than stand there lying about which
                            // credential the statement sets.
                            setShownPassword(null);
                            setPasswordClipboard(null);
                          }}
                          placeholder={PASSWORD_PLACEHOLDER}
                          autoComplete="new-password"
                          className={inputCls}
                        />
                        <button
                          type="button"
                          data-testid="user-sql-password-generate"
                          onClick={() => {
                            setSqlPassword(generateSuggestedPassword());
                            setShownPassword(null);
                            setPasswordClipboard(null);
                          }}
                          title="Generate a 20-character random password"
                          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-600 bg-slate-800 text-[11px] font-bold text-slate-100 hover:bg-slate-700"
                        >
                          Generate
                        </button>
                      </div>
                    </Field>
                  )}

                  {isDb2 &&
                    principalType === 'user' &&
                    (mode === 'add' || (mode === 'edit' && alteration === 'password')) && (
                      <Field
                        label="OS password"
                        hint={
                          osPasswordError ??
                          (osPassword
                            ? 'Written into the chpasswd command below in clear text. Fox Schema does not store it or send it anywhere.'
                            : `Leave empty to get a <password> placeholder to fill in yourself. Generated passwords are ${DB2_OS_PASSWORD_LENGTH} characters and avoid anything the shell would treat as syntax.`)
                        }
                      >
                        <div className="flex items-center gap-2">
                          <PasswordInput
                            data-testid="user-os-password"
                            value={osPassword}
                            onChange={(e) => setOsPassword(e.target.value)}
                            placeholder="<password>"
                            autoComplete="new-password"
                            className={inputCls}
                          />
                          <button
                            type="button"
                            data-testid="user-os-password-generate"
                            onClick={() => setOsPassword(generateDb2OsPassword())}
                            title={`Generate a ${DB2_OS_PASSWORD_LENGTH}-character password valid for a Linux account`}
                            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-600 bg-slate-800 text-[11px] font-bold text-slate-100 hover:bg-slate-700"
                          >
                            Generate
                          </button>
                        </div>
                      </Field>
                    )}

                  {isDb2 && mode === 'add' && principalType === 'user' && (
                    <Field
                      label="Assign role (optional)"
                      hint="GRANT ROLE after CONNECT. Create the role first with Add role if it is not in the list."
                    >
                      <Autocomplete
                        data-testid="user-os-role"
                        theme="slate"
                        value={osRole}
                        onChange={setOsRole}
                        options={roleOptions}
                        placeholder="ANALYSTS"
                      />
                    </Field>
                  )}

                  {isMysqlFamily && principalType === 'user' && (mode === 'add' || mode === 'drop' || mode === 'edit') && (
                    <Field
                      label="Host"
                      hint="MySQL/MariaDB accounts are name@host. Different host = different account. Use % for any host."
                    >
                      <input
                        data-testid="user-host"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        disabled={mode === 'drop' || mode === 'edit'}
                        placeholder="%"
                        className={inputCls}
                      />
                    </Field>
                  )}

                  {mode === 'edit' && editOptions.length > 0 && (
                    <Field label="Change">
                      <Segmented
                        testId="user-alteration"
                        value={alteration}
                        onChange={(v) => setAlteration(v as UserAlteration)}
                        options={editOptions.map((a) => ({
                          value: a,
                          label: ALTERATION_LABEL[a],
                        }))}
                      />
                    </Field>
                  )}

                  {mode === 'edit' && editOptions.length === 0 && (
                    <p className="text-[11px] text-amber-200">
                      This engine has no edit actions for this account type. Use Drop, or manage it
                      outside Fox Schema.
                    </p>
                  )}

                  {mode === 'edit' && alteration === 'rename' && support.canRename && (
                    <Field label="New name">
                      <input
                        data-testid="user-new-name"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                  )}

                  {/*
                    * Let the account in, in the same step that creates it.
                    * These were on the permissions tab, which meant re-picking
                    * this connection and re-typing this name to answer "and
                    * which database may it reach?" — a question CREATE USER
                    * always raises. Object privileges stay in the grid; what
                    * is here is the account's own reach.
                    */}
                  {mode === 'add' && (accessCaps.databaseScope || accessCaps.schemaScope) && (
                    <Field
                      label="Access"
                      hint="What this new account may reach. Per-object privileges are set in Permissions."
                    >
                      <div data-testid="user-access-grants" className="flex flex-col gap-2">
                        {accessCaps.databaseScope && (
                          <ObjectPicker
                            label="Databases it may connect to"
                            testId="user-grant-databases"
                            items={accessCatalog.databaseOptions.map((o) => o.value)}
                            selected={grantDatabases}
                            onChange={setGrantDatabases}
                            emptyHint="No databases listed for this connection."
                          />
                        )}
                        {accessCaps.schemaScope && (
                          <ObjectPicker
                            label="Schemas it may read"
                            testId="user-grant-schemas"
                            items={accessCatalog.schemas}
                            selected={grantSchemas}
                            onChange={setGrantSchemas}
                            emptyHint="No schemas listed for this connection."
                          />
                        )}
                      </div>
                    </Field>
                  )}

                  {mode === 'add' &&
                    !(isDb2 && principalType === 'user') &&
                    roleOptions.some((o) => o.value !== name.trim()) && (
                      <Field
                        label="Member of"
                        hint="Roles and groups this account joins. It holds everything they hold."
                      >
                        <ObjectPicker
                          label="Roles and groups it joins"
                          testId="user-member-of"
                          items={roleOptions.map((o) => o.value).filter((v) => v !== name.trim())}
                          selected={memberRoles}
                          onChange={setMemberRoles}
                          emptyHint="No roles or groups listed for this connection."
                        />
                      </Field>
                    )}

                  {mode === 'edit' && alteration === 'expire' && support.canExpire && (
                    <Field
                      label="Expiry"
                      hint={
                        isMysqlFamily
                          ? 'Days until password must change (leave empty for next-login expiry).'
                          : 'ISO timestamp for VALID UNTIL, or leave empty for infinity (Postgres).'
                      }
                    >
                      <input
                        data-testid="user-valid-until"
                        value={validUntil}
                        onChange={(e) => setValidUntil(e.target.value)}
                        placeholder={isMysqlFamily ? '90' : '2027-12-31'}
                        className={inputCls}
                      />
                    </Field>
                  )}

                  {mode === 'drop' && isOracle && principalType === 'user' && (
                    <label className="flex items-start gap-2 text-[11px] text-slate-300">
                      <input
                        type="checkbox"
                        data-testid="user-cascade"
                        checked={cascade}
                        onChange={(e) => setCascade(e.target.checked)}
                        className="mt-0.5 accent-rose-500"
                      />
                      <span>
                        Drop everything this account owns (CASCADE)
                        <span className="block text-slate-500">
                          Oracle refuses DROP while the account owns objects. Not recoverable.
                        </span>
                      </span>
                    </label>
                  )}

                  {mode === 'drop' && dropNotes.length > 0 && (
                    <div
                      data-testid="user-drop-safety"
                      className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-100"
                    >
                      {dropNotes.map((note, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{note}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {((mode === 'add' && principalType === 'user' && (support.canCreateUser || isDb2)) ||
                    (isDb2 && mode === 'edit' && alteration === 'password')) && (
                    <div
                      data-testid="user-password-hint"
                      className="flex items-start gap-2 rounded-md border border-slate-700 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-400"
                    >
                      <KeyRound className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        {passwordHint}{' '}
                        <span className="text-slate-500">
                          Fox Schema never stores it or sends it anywhere.
                        </span>
                      </span>
                    </div>
                  )}

                  {isDb2 && (mode === 'add' || mode === 'edit') && principalType === 'user' && (
                    <div
                      data-testid="user-db2-hint"
                      className="rounded-md border border-amber-500/35 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-200"
                    >
                      {mode === 'add'
                        ? 'Copy the docker commands into a terminal (replace <password>), then reload this list. Grant access next assigns table privileges to the uppercase authorization ID.'
                        : alteration === 'password'
                          ? 'Db2 stores no SQL password. chpasswd changes the Linux password used to connect.'
                          : alteration === 'disable'
                            ? 'Disable locks the Linux account (passwd -l) and REVOKE CONNECT. Table GRANTs stay until you revoke them.'
                            : alteration === 'enable'
                              ? 'Enable unlocks the Linux account and GRANT CONNECT again.'
                              : 'CREATE ROLE is SQL. After the role exists, Add user (OS) can GRANT ROLE to the new login, or use Grant access.'}
                    </div>
                  )}

                  {isDb2 && mode === 'add' && principalType === 'role' && (
                    <div
                      data-testid="user-db2-hint"
                      className="rounded-md border border-amber-500/35 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-200"
                    >
                      CREATE ROLE is SQL. After the role exists, Add user (OS) can GRANT ROLE to the
                      new login, or use Grant access.
                    </div>
                  )}

                  {isSqlServer && mode === 'add' && principalType === 'user' && (
                    <div
                      data-testid="user-sqlserver-hint"
                      className="rounded-md border border-slate-700 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-400"
                    >
                      SQL Server needs a login (run against master) and a database user (run against
                      this database). Both appear in the preview.
                    </div>
                  )}
                </div>
              )}

              {mode === 'idle' && selected && (
                <p className="shrink-0 text-[11px] text-slate-500">
                  Selected <code className="text-slate-300">{selected.name}</code> (
                  {selected.kind}
                  {selected.memberOf.length
                    ? ` · roles: ${selected.memberOf.join(', ')}`
                    : ''}
                  ). Double-click to edit, or use Edit / Drop / Grant access.
                </p>
              )}
            </>
          )}
        </div>

        {/* ── Right: SQL preview (always) ─────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-y-auto p-5 flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-bold text-slate-100">SQL Preview</h2>
            {generated && !('error' in generated) && (
              <span
                data-testid="user-risk"
                className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${RISK_STYLE[generated.risk]}`}
              >
                {generated.risk}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
              {showPasswordCopy && (
                <button
                  type="button"
                  data-testid="user-copy-with-password"
                  onClick={() => void copyWithGeneratedPassword()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-[11px] font-bold text-emerald-100"
                  title="Copies SQL with a one-time generated password. Fox Schema does not store it."
                >
                  {copiedWithPassword ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <KeyRound className="w-3.5 h-3.5" />
                  )}
                  {copiedWithPassword ? 'Copied with password' : 'Copy with generated password'}
                </button>
              )}
              <button
                type="button"
                data-testid="user-copy"
                onClick={copy}
                disabled={!sqlText}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-sky-500/40 bg-sky-500/15 text-[11px] font-bold text-sky-100 disabled:opacity-40"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy SQL'}
              </button>
              {onGrantAccess && (
                <button
                  type="button"
                  data-testid="user-grant-next"
                  onClick={goGrantAccess}
                  disabled={!readyForGrant}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-violet-500/40 bg-violet-500/15 text-[11px] font-bold text-violet-100 disabled:opacity-40"
                  title={
                    readyForGrant
                      ? `Open Permission Builder for ${grantDraft?.principalName ?? 'this account'}`
                      : 'Select a listed account, or finish Add user / Add role first'
                  }
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Grant access next
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {shownPassword && (
            <div
              data-testid="user-generated-password"
              className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-950/40 px-3 py-2"
            >
              <KeyRound className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-300" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-emerald-100">
                  {passwordClipboard === 'blocked'
                    ? 'Clipboard refused — copy this password and the SQL by hand'
                    : passwordClipboard === 'preview-copied'
                      ? 'SQL copied without this password — copy the password by hand'
                      : 'Password copied with the SQL — record it now'}
                </p>
                <code
                  data-testid="user-generated-password-value"
                  className="mt-1 block break-all rounded bg-slate-950/70 px-2 py-1 font-mono text-[12px] text-emerald-50 select-all"
                >
                  {shownPassword}
                </code>
                <p className="mt-1 text-[11px] text-emerald-200/80">
                  {passwordClipboard === 'blocked'
                    ? 'The browser blocked the clipboard, so nothing was copied. Substitute this for '
                    : passwordClipboard === 'preview-copied'
                      ? 'Copy SQL wrote the preview, which still reads '
                      : 'It is on your clipboard inside the statement, and shown here once. Fox Schema does not store it, and the preview above still reads '}
                  {'<password>'}
                  {passwordClipboard === 'blocked'
                    ? ' in the statement above. Fox Schema does not store it — close this and it is gone.'
                    : passwordClipboard === 'preview-copied'
                      ? '. This password is only on screen — close this and it is gone.'
                      : ' — close this and it is gone.'}
                </p>
              </div>
              <button
                type="button"
                data-testid="user-generated-password-dismiss"
                onClick={() => {
                  setShownPassword(null);
                  setPasswordClipboard(null);
                }}
                title="Hide the password"
                className="shrink-0 rounded p-0.5 text-emerald-200/70 hover:text-emerald-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {mode === 'idle' && (
            <EmptyState
              title="SQL appears here"
              body="Select a user or role and click Edit or Drop, or click Add user / Add role. Fox Schema only generates SQL — you review, copy, and run it on the database."
            />
          )}

          {mode !== 'idle' && !generated && (
            <EmptyState
              title={`Name the ${noun}`}
              body="Enter a name in the form on the left. The SQL preview updates as you type."
            />
          )}

          {generated && 'error' in generated && (
            <div
              data-testid="user-error"
              className="rounded-md border border-amber-500/40 bg-amber-950/30 px-3 py-2.5 text-[11px] text-amber-200"
            >
              {generated.error}
            </div>
          )}

          {generated && !('error' in generated) && (
            <>
              <div
                data-testid="user-sql"
                hidden={mode === 'add' && principalType === 'user' && createMode === 'cli' && !isDb2}
                className="rounded-md border border-slate-800 bg-slate-950/70 divide-y divide-slate-800/70"
              >
                {[
                  ...generated.statements,
                  // The grants that let the account in run after it exists —
                  // the order the reader would paste them in.
                  ...(accessGrants?.statements ?? []),
                ].map((s, i) => (
                  <div key={i} className="p-3">
                    <pre className="text-[12px] font-mono text-slate-100 whitespace-pre-wrap break-words">
                      {applyPassword(s.sql)}
                    </pre>
                    <p className="mt-1.5 text-[11px] text-slate-500">{s.explanation}</p>
                  </div>
                ))}
              </div>

              {/* Db2's steps are already shell commands, and they are only
                  runnable as written if Db2 is in a container. This picks how
                  to reach root and the instance owner instead. */}
              {(isDb2 || osAccount?.applicable) && (
                <label className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-slate-400">
                  Where do these run?
                  <select
                    data-testid="user-db2-run-mode"
                    value={db2RunMode}
                    onChange={(e) => setDb2RunMode(e.target.value as Db2RunMode)}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-[11px] font-normal text-slate-100"
                  >
                    <option value="server">Db2 on a server — Ubuntu, Debian, RHEL (sudo)</option>
                    <option value="docker">Db2 in a container (docker exec)</option>
                  </select>
                  <span className="font-normal text-slate-500">
                    {db2RunMode === 'docker'
                      ? `Prefixes each step with docker exec against ${DB2_DOCKER_CONTAINER}.`
                      : 'Plain OS commands to run on the database server itself. No Docker needed.'}
                  </span>
                </label>
              )}

              {/* Whether an OS account does anything for this engine. Shown
                  for Add user only: it pairs with creating one, and the answer
                  is often "nothing", which is worth saying. */}
              {!isDb2 && mode === 'add' && principalType === 'user' && osAccount && (
                <div className="flex flex-col gap-1.5 rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
                  <p className="text-[11px] font-bold text-slate-400">
                    Operating-system account
                    {!osAccount.applicable && (
                      <span className="ml-1.5 font-normal text-slate-500">not needed here</span>
                    )}
                  </p>
                  <p className="text-[11px] text-slate-500">{osAccount.rationale}</p>
                  {osAccount.statements.map((st, i) => (
                    <div key={i} data-testid={`user-os-step-${i}`}>
                      <pre className="whitespace-pre-wrap break-all text-[11px] font-mono text-slate-200">
                        {st.sql}
                      </pre>
                      <p className="text-[11px] text-slate-500">{st.explanation}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* The Db2 path already emits shell commands; a second one would
                  be noise. Everything else is SQL, and this is how to run it.
                  While adding a user the mode toggle decides: showing the
                  wrapped command under the SQL when the user asked for SQL is
                  the ambiguity this toggle exists to remove. Outside Add there
                  is no toggle, so it stays available as before.

                  It takes the password-substituted statements: in Command-line
                  create mode the SQL preview is hidden, so this is the only
                  statement on screen, and fed the raw text it read
                  `<password>` while the field and hint both said the password
                  had been applied. */}
              {!isDb2 && conn && (mode !== 'add' || principalType !== 'user' || createMode === 'cli') && (
                <CommandModeToggle
                  data-testid="user-command-mode"
                  sql={generated.statements.map((s) => applyPassword(s.sql)).join('\n')}
                  dialect={dialect}
                  target={{
                    host: conn.host,
                    port: conn.port,
                    database: conn.database,
                    username: conn.username,
                    schema: conn.schema,
                  }}
                />
              )}

              {generated.warnings.length > 0 && (
                <div className="flex flex-col gap-1.5" data-testid="user-warnings">
                  {generated.warnings.map((w, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${
                        w.level === 'danger'
                          ? 'border-rose-500/40 bg-rose-950/30 text-rose-200'
                          : w.level === 'caution'
                            ? 'border-amber-500/40 bg-amber-950/25 text-amber-200'
                            : 'border-slate-700 bg-slate-900/50 text-slate-400'
                      }`}
                    >
                      {w.level === 'danger' ? (
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      ) : w.level === 'caution' ? (
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      ) : (
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      )}
                      <span>{w.message}</span>
                    </div>
                  ))}
                </div>
              )}

              <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <UserCog className="w-3.5 h-3.5" />
                {isDb2 && principalType === 'user' && (mode === 'add' || mode === 'edit')
                  ? 'Preview only. Copy and run the docker commands in a terminal — Fox Schema does not create, lock, or change OS users for you.'
                  : 'Preview only. Copy and run this SQL in your DBA tool or the SQL Editor — Fox Schema does not create, change, or drop accounts for you.'}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
