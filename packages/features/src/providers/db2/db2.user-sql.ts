/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2 account DDL — roles in SQL; users are OS/directory accounts. The
 * Docker instruction builder emits copy-paste steps (never executed here).
 */
import { PASSWORD_PLACEHOLDER, type GeneratedUserSql, type UserSqlDialect } from '../../modules/access/user-sql.types.js';
import { createUserSqlEmitter } from '../../modules/access/user-sql-helpers.js';
import type { GeneratedStatement } from '../../modules/access/access-sql.types.js';

const DB2_REASON =
  'Db2 authenticates against the operating system or a directory service, so there is ' +
  'no CREATE USER. Create the account on the server, then grant it privileges here.';

export const db2UserSql: UserSqlDialect = {
  id: 'db2',
  support: {
    supported: true,
    canCreateUser: false,
    canCreateRole: true,
    canDisable: true,
    canRename: false,
    canExpire: false,
    reason: DB2_REASON,
  },

  build(request, dialect) {
    const { name, isUser, noun, add, q, finish } = createUserSqlEmitter(request, dialect);
    const support = this.support;

    if (request.action === 'create') {
      if (isUser) {
        return { error: support.reason ?? 'This engine cannot create users in SQL.' };
      }
      add(
        `CREATE ROLE ${q(name)};`,
        `Creates the role ${name}. A role holds privileges; grant it to users afterwards.`
      );
      return finish();
    }

    if (request.action === 'drop') {
      // Db2 has no DROP USER: the account lives in the operating system, which
      // is the same reason CREATE USER is refused above. Emitting it produced
      // SQL0104N, a syntax error, rather than anything a DBA could run.
      if (isUser) return buildDb2OsUserInstructions({ name, action: 'drop' });
      add(
        `DROP ROLE ${q(name)};`,
        `Drops the ${noun} ${name}. Privileges granted to it are removed with it.`,
        'administrative'
      );
      return finish();
    }

    const change = request.alteration ?? 'password';
    if (change === 'rename') {
      const next = request.newName?.trim();
      if (!next) return { error: 'Enter the new name.' };
      return {
        error: `${dialect} cannot rename an account. Create the new one and drop the old.`,
      };
    }
    if (change === 'password') {
      if (!isUser) return { error: 'A role has no password.' };
      return buildDb2OsUserInstructions({ name, action: 'password' });
    }
    if (change === 'disable') {
      if (!isUser) return { error: 'A role cannot be locked this way.' };
      return buildDb2OsUserInstructions({ name, action: 'disable' });
    }
    if (change === 'enable') {
      if (!isUser) return { error: 'A role cannot be unlocked this way.' };
      return buildDb2OsUserInstructions({ name, action: 'enable' });
    }
    if (change === 'expire') {
      if (!isUser) return { error: 'A role has no expiry date.' };
      return { error: `${dialect} cannot set account expiry in SQL.` };
    }
    return {
      error: `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`,
    };
  },
};

/** Compose container from this repo's `docker-compose.yml`. */
export const DB2_DOCKER_CONTAINER = 'foxschema-db2';
/** Default database created by that compose file. */
export const DB2_DOCKER_DATABASE = 'foxdb';

/**
 * How long a generated Db2 OS password is.
 *
 * Db2 on Linux authenticates through the operating system, so the rules that
 * actually apply are the OS's (PAM / shadow), not Db2's — Db2 LUW itself
 * accepts far longer. Nine keeps it comfortably inside every Db2 platform
 * limit, including the eight-character ceilings on older AIX and z/OS setups
 * that this length deliberately clears.
 */
export const DB2_OS_PASSWORD_LENGTH = 9;

/**
 * Characters a generated password is built from.
 *
 * The password is pasted into
 * `bash -lc 'echo "user:PASSWORD" | chpasswd'` and run as root, so anything
 * that could end a quote, expand, or split a field is left out:
 *
 *   '  "  \  $  `   end the quoting or expand inside it
 *   :             separates the fields chpasswd reads
 *   !             history-expands if the line is pasted into an interactive shell
 *   ~  #          expand or start a comment if the quotes are ever stripped
 *   space, control breaks the line
 *
 * Look-alike characters (0/O, 1/l/I) are also out, because this password gets
 * read off a screen and typed again.
 */
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' + 'abcdefghijkmnopqrstuvwxyz' + '23456789' + '-_.+=@%^';

/** The classes PAM's common complexity rules expect to see. */
const CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[-_.+=@%^]/];

/**
 * Anything that must never reach the shell command, whatever its length.
 *
 * Kept as a rejection list rather than an escape: the statement is run by hand
 * with root privileges, so a password this cannot represent exactly is refused
 * rather than quoted and hoped for.
 */
const UNSAFE_PASSWORD = /['"\\$`:!~#\s]|[\x00-\x1f\x7f]/;

/**
 * Reject a password that cannot be written into the chpasswd command safely.
 *
 * Returns an explanation, or null when the password is usable.
 */
export function validateDb2OsPassword(password: string): string | null {
  if (password.length === 0) return 'Enter a password, or generate one.';
  if (UNSAFE_PASSWORD.test(password)) {
    return (
      'That password contains a character the chpasswd command cannot carry: quotes, ' +
      'backslash, $, backtick, colon, !, ~, #, or a space. Colon separates the fields ' +
      'chpasswd reads, and the rest would end or expand the shell quoting.'
    );
  }
  if (password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 255) return 'Db2 accepts at most 255 characters.';
  return null;
}

/** A random index in [0, size), without the bias a plain modulo would add. */
function unbiasedIndex(size: number, random: () => number): number {
  // 256 is not a multiple of most alphabet sizes, so the tail of the byte
  // range would favour the first few characters. Draw again instead.
  const limit = Math.floor(256 / size) * size;
  let byte = random();
  while (byte >= limit) byte = random();
  return byte % size;
}

/**
 * A password that is valid for a Linux account and safe in the generated
 * command.
 *
 * `randomByte` exists so a test can make the output deterministic; it defaults
 * to the platform's cryptographic source.
 */
/**
 * One cryptographically random byte, from WebCrypto.
 *
 * Reached through `globalThis` rather than the bare `crypto` global because
 * `tsconfig.build.json` declares `lib: ["es2022"]` and `types: []` on purpose —
 * no DOM, no @types/node — so that a Node built-in or a browser-only API breaks
 * the publish build loudly. That guard did its job: the bare global is in
 * neither lib, and the publish build had been failing on it, which meant
 * `npm run publish:sql` could not produce a tarball at all.
 *
 * An ambient `declare const crypto` would fix the build and then collide with
 * DOM's own declaration everywhere the web app typechecks. This needs no
 * ambient at all. `crypto.getRandomValues` is WebCrypto — standard in browsers
 * and in Node since 19 — and reaching it as a global rather than importing
 * `node:crypto` is what keeps `purity.test.ts` satisfied.
 */
function defaultRandomByte(): number {
  const webCrypto = (
    globalThis as {
      crypto?: { getRandomValues?<T extends Uint8Array>(array: T): T };
    }
  ).crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error(
      'No WebCrypto available: cannot generate a password from a cryptographic source. ' +
        'Pass an explicit randomByte, or run on Node 19+ / a modern browser.'
    );
  }
  const buf = new Uint8Array(1);
  webCrypto.getRandomValues(buf);
  return buf[0]!;
}

export function generateDb2OsPassword(
  length: number = DB2_OS_PASSWORD_LENGTH,
  randomByte?: () => number
): string {
  const draw = randomByte ?? defaultRandomByte;

  for (let attempt = 0; attempt < 100; attempt++) {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += PASSWORD_ALPHABET[unbiasedIndex(PASSWORD_ALPHABET.length, draw)];
    }
    // Redraw rather than patching a class in at a fixed position, which would
    // make that position predictable.
    if (CLASSES.every((re) => re.test(out))) return out;
  }
  throw new Error('Could not generate a password meeting every character class.');
}

/**
 * Where the commands are meant to run.
 *
 * The Fox Schema compose file puts Db2 in a container, but a real installation
 * is a server you have a shell on. The commands are the same; only how you
 * reach root and the instance owner differs, so that is all this switches.
 */
export type Db2RunMode = 'docker' | 'server';

/**
 * Most Db2 installations are a server you have a shell on, not a container —
 * Ubuntu and Debian included. The container form stays one selection away for
 * the compose setup this repo ships.
 */
export const DEFAULT_DB2_RUN_MODE: Db2RunMode = 'server';

interface Db2Prefixes {
  /** Root through a login shell, for anything with a pipe or its own quoting. */
  rootShell: string;
  /** Root, invoking a binary directly. */
  root: string;
  /** The Db2 instance owner, through its profile — `db2` is not on root's PATH. */
  instance: string;
}

/**
 * A Db2 catalog query as a command the reader can run in the same terminal.
 *
 * Quoting is the whole difficulty. Db2 string literals must use single quotes,
 * so `WHERE GRANTEETYPE = 'U'` cannot sit inside a single-quoted shell
 * argument. Outer double quotes for `su -c`, an escaped double quote for the
 * db2 argument, and the SQL's own single quotes are then literal.
 *
 * The connect is silenced so the answer is the only thing printed.
 */
function db2Query(prefix: string, database: string, sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  return `${prefix}"db2 connect to ${database} > /dev/null && db2 \\"${oneLine}\\""`;
}

function prefixesFor(mode: Db2RunMode, container: string): Db2Prefixes {
  if (mode === 'server') {
    // sudo rather than assuming the reader is already root: the same line then
    // works whether or not they are.
    return {
      rootShell: 'sudo bash -lc ',
      root: 'sudo ',
      instance: 'sudo su - db2inst1 -c ',
    };
  }
  return {
    rootShell: `docker exec -u 0 ${container} bash -lc `,
    root: `docker exec -u 0 ${container} `,
    instance: `docker exec ${container} su - db2inst1 -c `,
  };
}

const LINUX_ACCOUNT = /^[a-z_][a-z0-9_]{0,31}$/;
const SAFE_DOCKER_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_DB_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function linuxAccountName(raw: string): string | { error: string } {
  const linux = raw.trim().toLowerCase();
  if (!LINUX_ACCOUNT.test(linux)) {
    return {
      error:
        'Use a Linux login name: start with a letter or underscore, then letters, digits, or _ (max 32).',
    };
  }
  return linux;
}

/**
 * Copy-paste steps for an OS login in the Fox Schema Db2 container.
 * Fox Schema does not run these. Passwords stay a placeholder.
 */
export type Db2OsUserAction = 'create' | 'drop' | 'password' | 'disable' | 'enable' | 'list';

/**
 * Commands that answer "who exists, and who can connect?".
 *
 * Two lists, because they are different populations: the OS knows every login
 * on the box, and Db2 knows only the authorization IDs someone has granted
 * something to. An account can exist in one and not the other, which is the
 * usual reason a new user cannot log in.
 */
function listInstructions(args: {
  container?: string;
  database?: string;
  runMode?: Db2RunMode;
}): GeneratedUserSql | { error: string } {
  const container = (args.container || DB2_DOCKER_CONTAINER).trim() || DB2_DOCKER_CONTAINER;
  const database = (args.database || DB2_DOCKER_DATABASE).trim() || DB2_DOCKER_DATABASE;
  if (!SAFE_DOCKER_NAME.test(container)) {
    return { error: 'Container name contains characters that cannot be copied into a docker exec command.' };
  }
  if (!SAFE_DB_NAME.test(database)) {
    return { error: 'Database name must be a simple identifier (letters, digits, underscore).' };
  }
  const P = prefixesFor(args.runMode ?? DEFAULT_DB2_RUN_MODE, container);

  return {
    statements: [
      {
        // Ordinary logins start at UID 1000; below that is system accounts.
        //
        // Double quotes on the outside and single quotes around the awk
        // program, with the field references escaped so the outer shell leaves
        // them alone. Single quotes on both levels would close the outer string
        // at the awk program and leave $3 to expand to nothing.
        sql:
          `${P.rootShell}` +
          `"getent passwd | awk -F: '\\$3 >= 1000 && \\$3 < 65534 {print \\$1, \\$3, \\$6}'"`,
        explanation:
          `Every ordinary OS login ${args.runMode === 'server' ? 'on the server' : 'in the container'}, with its UID and home directory. These are the names Db2 can authenticate.`,
        risk: 'low',
      },
      {
        // `passwd -S` one account at a time: the Db2 image's passwd does not
        // accept -Sa or --all, so asking for every account in one call fails
        // with "unknown option". Unfiltered on purpose — a locked or
        // password-less account is what someone checking this list wants to see.
        sql:
          `${P.rootShell}` +
          `"getent passwd | awk -F: '\\$3 >= 1000 && \\$3 < 65534 {print \\$1}' | xargs -r -n1 passwd -S"`,
        explanation:
          'Password status per login. The second field is PS when a password is set, LK when the account is locked, NP when none is set — the last two cannot authenticate.',
        risk: 'low',
      },
      {
        sql:
          db2Query(
            P.instance,
            database,
            `SELECT TRIM(GRANTEE) AS authid, CONNECTAUTH, DBADMAUTH FROM SYSCAT.DBAUTH WHERE GRANTEETYPE = 'U' ORDER BY 1`
          ),
        explanation: `Authorization IDs Db2 has granted something on ${database}. An OS account missing here cannot connect yet.`,
        risk: 'low',
      },
      {
        sql:
          db2Query(
            P.instance,
            database,
            `SELECT TRIM(GRANTEE) AS authid, TRIM(ROLENAME) AS role FROM SYSCAT.ROLEAUTH WHERE GRANTEETYPE = 'U' ORDER BY 1, 2`
          ),
        explanation: 'Which roles each user holds.',
        risk: 'low',
      },
    ],
    warnings: [
      {
        level: 'info',
        message:
          'The OS list and the Db2 list are different populations. A login that exists in the OS but not in SYSCAT.DBAUTH has no CONNECT yet; an authid in Db2 with no OS account can never authenticate.',
      },
    ],
    risk: 'low',
  };
}

export function buildDb2OsUserInstructions(args: {
  name: string;
  role?: string;
  container?: string;
  database?: string;
  action?: Db2OsUserAction;
  /** Where the commands run: inside the container, or on the server itself. */
  runMode?: Db2RunMode;
  /**
   * Written into the chpasswd command instead of the placeholder.
   *
   * Refused when {@link validateDb2OsPassword} rejects it, rather than escaped:
   * the caller runs this as root, so a password that cannot be represented
   * exactly must not be guessed at.
   */
  password?: string;
}): GeneratedUserSql | { error: string } {
  const action = args.action ?? 'create';
  const runMode = args.runMode ?? DEFAULT_DB2_RUN_MODE;
  // The account name is not needed to list accounts.
  if (action === 'list') return listInstructions(args);
  const linux = linuxAccountName(args.name);
  if (typeof linux !== 'string') return linux;

  const secret = args.password ?? '';
  if (secret) {
    const bad = validateDb2OsPassword(secret);
    if (bad) return { error: bad };
  }
  const pw = secret || PASSWORD_PLACEHOLDER;
  const usingRealPassword = secret.length > 0;
  const authId = linux.toUpperCase();
  const container = (args.container || DB2_DOCKER_CONTAINER).trim() || DB2_DOCKER_CONTAINER;
  const database = (args.database || DB2_DOCKER_DATABASE).trim() || DB2_DOCKER_DATABASE;
  if (!SAFE_DOCKER_NAME.test(container)) {
    return { error: 'Container name contains characters that cannot be copied into a docker exec command.' };
  }
  if (!SAFE_DB_NAME.test(database)) {
    return { error: 'Database name must be a simple identifier (letters, digits, underscore).' };
  }
  const P = prefixesFor(runMode, container);
  const where = runMode === 'server' ? 'on the database server' : `inside ${container}`;

  if (action === 'password') {
    return {
      statements: [
        {
          sql:
            `${P.rootShell}` +
            `'echo "${linux}:${pw}" | chpasswd'`,
          explanation: `Sets a new OS password for ${linux}. Db2 has no ALTER USER … PASSWORD — this is the password Fox Schema will send on connect.`,
          risk: 'elevated',
        },
        {
          sql: `${P.root}passwd -S ${linux}`,
          explanation: `Shows lock/status. P = password set; L = locked (disabled).`,
          risk: 'low',
        },
      ],
      warnings: [
        {
          level: 'danger',
          message:
            `Replace ${PASSWORD_PLACEHOLDER} before running. Fox Schema never handles the password.`,
        },
      ],
      risk: 'elevated',
    };
  }

  if (action === 'disable') {
    return {
      statements: [
        {
          sql: `${P.root}passwd -l ${linux}`,
          explanation: `Locks the OS account ${linux}. Authentication fails until you unlock it (Edit → Enable).`,
          risk: 'administrative',
        },
        {
          sql:
            `${P.instance}` +
            `"db2 connect to ${database} && db2 'REVOKE CONNECT ON DATABASE FROM USER ${authId}'"`,
          explanation: `Also takes away CONNECT on ${database}. ${authId} cannot attach even if the OS lock is later skipped.`,
          risk: 'elevated',
        },
        {
          sql: `${P.root}passwd -S ${linux}`,
          explanation: `Confirm LK / L in the status. Locked means disable worked.`,
          risk: 'low',
        },
        {
          sql:
            db2Query(
              P.instance,
              database,
              `SELECT TRIM(GRANTEE) AS authid, CONNECTAUTH FROM SYSCAT.DBAUTH WHERE GRANTEETYPE = 'U' AND TRIM(GRANTEE) = '${authId}'`
            ),
          explanation: `CONNECTAUTH N (or no row) means ${authId} cannot connect to ${database}.`,
          risk: 'low',
        },
      ],
      warnings: [
        {
          level: 'caution',
          message:
            'Disable is two layers: OS lock (passwd -l) and REVOKE CONNECT. Enable runs the reverse. Table GRANTs stay until you revoke them separately.',
        },
      ],
      risk: 'administrative',
    };
  }

  if (action === 'enable') {
    return {
      statements: [
        {
          sql: `${P.root}passwd -u ${linux}`,
          explanation: `Unlocks the OS account ${linux} so the password works again.`,
          risk: 'elevated',
        },
        {
          sql:
            `${P.instance}` +
            `"db2 connect to ${database} && db2 'GRANT CONNECT ON DATABASE TO USER ${authId}'"`,
          explanation: `Restores CONNECT on ${database}. Table privileges from before disable are unchanged.`,
          risk: 'elevated',
        },
        {
          sql: `${P.root}passwd -S ${linux}`,
          explanation: `Status should show P (password set), not L (locked).`,
          risk: 'low',
        },
      ],
      warnings: [
        {
          level: 'info',
          message: `Db2 authorization ID is ${authId}. If login still fails, set a password (Edit → Password) after unlocking.`,
        },
      ],
      risk: 'elevated',
    };
  }

  if (action === 'drop') {
    return {
      statements: [
        {
          sql:
            `${P.instance}` +
            `"db2 connect to ${database} && db2 'REVOKE CONNECT ON DATABASE FROM USER ${authId}'"`,
          explanation: `Takes CONNECT on ${database} away from ${authId}. Run this before removing the OS login, while the name still resolves.`,
          risk: 'administrative',
        },
        {
          sql: `${P.root}userdel ${linux}`,
          explanation: `Removes the OS login ${linux}. Db2 has no DROP USER — the account only exists in the operating system. Add -r to delete its home directory too.`,
          risk: 'administrative',
        },
        {
          sql: `${P.rootShell}'id ${linux} >/dev/null 2>&1 && echo STILL_PRESENT || echo REMOVED'`,
          explanation: `REMOVED confirms the OS login is gone, so nothing can authenticate as ${authId} any more.`,
          risk: 'low',
        },
        {
          sql:
            db2Query(
              P.instance,
              database,
              `SELECT TRIM(GRANTEE) AS authid, CONNECTAUTH FROM SYSCAT.DBAUTH WHERE GRANTEETYPE = 'U' AND TRIM(GRANTEE) = '${authId}'`
            ),
          explanation: `No row means ${authId} holds no database authority. Table privileges granted to it are listed separately in SYSCAT.TABAUTH.`,
          risk: 'low',
        },
      ],
      warnings: [
        {
          level: 'caution',
          message:
            `Db2 keeps privileges by name, not by account: GRANTs to ${authId} survive removing the OS login and apply again to anyone later created with the same name. Revoke what it holds, and reassign anything it owns, before reusing the name.`,
        },
      ],
      risk: 'administrative',
    };
  }

  let roleAuth: string | undefined;
  const roleRaw = args.role?.trim();
  if (roleRaw) {
    const roleLinux = linuxAccountName(roleRaw);
    if (typeof roleLinux !== 'string') {
      return { error: 'Role name must use the same characters as a Linux login (letters, digits, underscore).' };
    }
    roleAuth = roleLinux.toUpperCase();
  }

  const statements: GeneratedStatement[] = [
    {
      sql:
        `${P.rootShell}` +
        `'id ${linux} >/dev/null 2>&1 || useradd -m -s /bin/bash ${linux}'`,
      explanation: `Creates the OS login ${linux} ${where}. Db2 authenticates this name; there is no CREATE USER.`,
      risk: 'elevated',
    },
    {
      sql:
        `${P.rootShell}` +
        `'echo "${linux}:${pw}" | chpasswd'`,
      explanation: `Sets the OS password for ${linux}. Replace ${PASSWORD_PLACEHOLDER} before running.`,
      risk: 'elevated',
    },
    {
      sql:
        `${P.instance}` +
        `"db2 connect to ${database} && db2 'GRANT CONNECT ON DATABASE TO USER ${authId}'"`,
      explanation: `Lets ${authId} connect to ${database}. Until this runs, Fox Schema will not list the account.`,
      risk: 'elevated',
    },
  ];

  if (roleAuth) {
    statements.push({
      sql:
        `${P.instance}` +
        `"db2 connect to ${database} && db2 'GRANT ROLE ${roleAuth} TO USER ${authId}'"`,
      explanation: `Assigns role ${roleAuth} to ${authId}. Create the role first with Add role if it does not exist.`,
      risk: 'elevated',
    });
  }

  statements.push(
    {
      sql: `${P.root}getent passwd ${linux}`,
      explanation: `Lists the OS account. You should see ${linux} in the passwd line.`,
      risk: 'low',
    },
    {
      sql:
        db2Query(
          P.instance,
          database,
          `SELECT TRIM(GRANTEE) AS authid, CONNECTAUTH FROM SYSCAT.DBAUTH WHERE GRANTEETYPE = 'U' AND TRIM(GRANTEE) = '${authId}'`
        ),
      explanation: `CONNECTAUTH Y or G means ${authId} can log in.`,
      risk: 'low',
    },
    {
      sql:
        db2Query(
          P.instance,
          database,
          `SELECT TRIM(ROLENAME) AS role FROM SYSCAT.ROLEAUTH WHERE GRANTEETYPE = 'U' AND TRIM(GRANTEE) = '${authId}'`
        ),
      explanation: `Roles granted to ${authId}. Reload User Management after CONNECT so the user appears in the list.`,
      risk: 'low',
    }
  );

  return {
    statements,
    warnings: [
      {
        level: 'danger',
        message:
          usingRealPassword
          ? 'These commands contain the password in clear text and run as root. Fox Schema does not ' +
            'store it or send it anywhere, but your clipboard and shell history will keep it — clear ' +
            'them afterwards.'
          : `Replace ${PASSWORD_PLACEHOLDER} with a real OS password before running chpasswd. Fox Schema ` +
          'never handles the password.',
      },
      {
        level: 'info',
        message:
          `Db2 authorization ID is ${authId} (uppercase of the Linux name). Use Grant access next for table privileges.`,
      },
    ],
    risk: 'elevated',
  };
}
