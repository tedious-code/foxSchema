/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2 OS passwords and the account-listing commands.
 *
 * The password is pasted into a chpasswd command that the user runs as root,
 * so the tests below care about one thing above all: nothing a person types
 * can end the quoting and become a second command.
 */
import { describe, expect, it } from 'vitest';
import {
  DB2_OS_PASSWORD_LENGTH,
  buildDb2OsUserInstructions,
  generateDb2OsPassword,
  validateDb2OsPassword,
} from './db2.user-sql.js';

const create = (password?: string) =>
  buildDb2OsUserInstructions({ name: 'report_user', database: 'foxdb', password });

const sqlOf = (out: ReturnType<typeof create>) =>
  'error' in out ? '' : out.statements.map((s) => s.sql).join('\n');

describe('generateDb2OsPassword', () => {
  it('is nine characters by default', () => {
    expect(DB2_OS_PASSWORD_LENGTH).toBe(9);
    expect(generateDb2OsPassword()).toHaveLength(9);
  });

  it('only ever produces passwords the command can carry', () => {
    for (let i = 0; i < 300; i++) {
      expect(validateDb2OsPassword(generateDb2OsPassword())).toBeNull();
    }
  });

  it('contains every character class PAM usually asks for', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateDb2OsPassword();
      expect(/[A-Z]/.test(pw), pw).toBe(true);
      expect(/[a-z]/.test(pw), pw).toBe(true);
      expect(/[0-9]/.test(pw), pw).toBe(true);
      expect(/[-_.+=@%^]/.test(pw), pw).toBe(true);
    }
  });

  it('leaves out characters that are easy to misread', () => {
    // The password is read off a screen and typed again.
    const all = Array.from({ length: 400 }, () => generateDb2OsPassword()).join('');
    for (const ch of ['0', 'O', '1', 'l', 'I']) expect(all, ch).not.toContain(ch);
  });

  it('redraws instead of folding the tail of the byte range back to the start', () => {
    // The alphabet has 65 characters and 256 is not a multiple of it, so bytes
    // 195..255 have no unbiased mapping. A plain `byte % 65` would fold them
    // onto the first characters; the generator must discard and draw again.
    const drawn: number[] = [];
    // One index from each class (upper, lower, digit, symbol), so the first
    // attempt satisfies every class and the generator does not restart.
    const accepted = [0, 24, 49, 57];
    let k = 0;
    let rejectNext = true;
    const feed = () => {
      const b = rejectNext ? 200 : accepted[k++ % accepted.length]!;
      rejectNext = !rejectNext;
      drawn.push(b);
      return b;
    };

    const pw = generateDb2OsPassword(9, feed);

    expect(pw).toHaveLength(9);
    // Rejected bytes were consumed without producing a character, so more
    // bytes were drawn than characters returned.
    expect(drawn.filter((b) => b >= 195).length).toBeGreaterThan(0);
    expect(drawn.length).toBeGreaterThan(pw.length);
    // And nothing outside the alphabet leaked through.
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9\-_.+=@%^]+$/);
  });
});

describe('validateDb2OsPassword', () => {
  it.each([
    ["a quote", "pa'ss1A-"],
    ['a double quote', 'pa"ss1A-'],
    ['a backslash', 'pa\\ss1A-'],
    ['a dollar sign', 'pa$ss1A-'],
    ['a backtick', 'pa`ss1A-'],
    ['a colon', 'pa:ss1A-'],
    ['an exclamation mark', 'pa!ss1A-'],
    ['a hash', 'pa#ss1A-'],
    ['a tilde', 'pa~ss1A-'],
    ['a space', 'pa ss1A-'],
  ])('refuses %s', (_label, password) => {
    expect(validateDb2OsPassword(password)).toBeTruthy();
  });

  it('refuses a newline, which would split the command in two', () => {
    expect(validateDb2OsPassword(`pass1A-${String.fromCharCode(10)}x`)).toBeTruthy();
  });

  it('accepts an ordinary strong password', () => {
    expect(validateDb2OsPassword('Kp7-tR2xQ')).toBeNull();
  });

  it('asks for a reasonable length', () => {
    expect(validateDb2OsPassword('Ab3-x')).toMatch(/at least 8/);
    expect(validateDb2OsPassword('')).toBeTruthy();
  });
});

describe('buildDb2OsUserInstructions with a password', () => {
  it('writes the password into chpasswd instead of the placeholder', () => {
    const sql = sqlOf(create('Kp7-tR2xQ'));
    expect(sql).toContain('report_user:Kp7-tR2xQ');
    expect(sql).not.toContain('<password>');
  });

  it('keeps the placeholder when no password is given', () => {
    const sql = sqlOf(create());
    expect(sql).toContain('<password>');
  });

  it('refuses a password that would break out of the quoting', () => {
    // `'; rm -rf / #` would end the outer single quote and start a command.
    const out = create("x'; rm -rf / #");
    expect('error' in out).toBe(true);
  });

  it.each([["'"], ['"'], ['$'], ['`'], [':'], ['\\']])(
    'never emits a raw %s inside the chpasswd argument',
    (ch) => {
      const out = create(`Kp7${ch}tR2xQ`);
      // Refusing is the only correct answer; it must not appear in a command.
      expect('error' in out, `accepted ${ch}`).toBe(true);
    }
  );

  it('warns that the command now carries the password in clear text', () => {
    const out = create('Kp7-tR2xQ');
    if ('error' in out) throw new Error(out.error);
    expect(out.warnings.some((w) => /clear text/i.test(w.message))).toBe(true);
  });

  it('sets the same password on the change-password path', () => {
    const out = buildDb2OsUserInstructions({
      name: 'report_user',
      action: 'password',
      password: 'Kp7-tR2xQ',
    });
    if ('error' in out) throw new Error(out.error);
    expect(out.statements.map((s) => s.sql).join('\n')).toContain('report_user:Kp7-tR2xQ');
  });
});

describe('buildDb2OsUserInstructions list action', () => {
  const list = () => buildDb2OsUserInstructions({ name: '', action: 'list', database: 'foxdb' });

  it('does not need an account name', () => {
    // Listing is about every account, so an empty name must not be rejected.
    expect('error' in list()).toBe(false);
  });

  it('lists OS logins and Db2 authorization IDs separately', () => {
    const out = list();
    if ('error' in out) throw new Error(out.error);
    const sql = out.statements.map((s) => s.sql).join('\n');
    expect(sql).toContain('getent passwd');
    // `passwd -S` per account: this image's passwd rejects -Sa / --all.
    expect(sql).toContain('passwd -S');
    expect(sql).not.toContain('passwd -Sa');
    expect(sql).toContain('SYSCAT.DBAUTH');
    expect(sql).toContain('SYSCAT.ROLEAUTH');
  });

  it('quotes the awk program so the outer shell does not eat it', () => {
    // Single quotes on both levels would close the bash -lc string at the awk
    // program and leave $3 to expand to nothing. Verified by running the
    // emitted command against the Db2 container.
    const out = list();
    if ('error' in out) throw new Error(out.error);
    const awkCmd = out.statements.find((s) => s.sql.includes('awk'))!.sql;
    expect(awkCmd).toContain(`bash -lc "`);
    expect(awkCmd).toContain(`awk -F: '`);
    expect(awkCmd).toContain('\\$3');
  });

  it('says why the two lists differ', () => {
    const out = list();
    if ('error' in out) throw new Error(out.error);
    expect(out.warnings.some((w) => /different populations/i.test(w.message))).toBe(true);
  });

  it('reads only — nothing here changes an account', () => {
    const out = list();
    if ('error' in out) throw new Error(out.error);
    expect(out.statements.every((s) => s.risk === 'low')).toBe(true);
    const sql = out.statements.map((s) => s.sql).join('\n');
    for (const verb of ['useradd', 'chpasswd', 'userdel']) {
      expect(sql, verb).not.toContain(verb);
    }
    // As whole words: SYSCAT columns are named GRANTEE and GRANTEETYPE, which
    // contain "GRANT" without granting anything.
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/\bREVOKE\b/);
  });

  it('refuses a container name that could not be pasted safely', () => {
    const out = buildDb2OsUserInstructions({
      name: '',
      action: 'list',
      container: 'evil; rm -rf /',
    });
    expect('error' in out).toBe(true);
  });
});

describe('run mode', () => {
  const build = (runMode: 'docker' | 'server', action: 'create' | 'list' = 'create') =>
    buildDb2OsUserInstructions({
      name: action === 'list' ? '' : 'report_user',
      database: 'FOXDB',
      action,
      runMode,
    });

  const sqlText = (runMode: 'docker' | 'server', action: 'create' | 'list' = 'create') => {
    const out = build(runMode, action);
    if ('error' in out) throw new Error(out.error);
    return out.statements.map((s) => s.sql).join('\n');
  };

  it('server mode mentions docker nowhere', () => {
    // The whole point: on a real server there is no container to exec into,
    // and a docker prefix would simply fail.
    expect(sqlText('server')).not.toContain('docker');
    expect(sqlText('server', 'list')).not.toContain('docker');
  });

  it('server mode reaches root and the instance owner through sudo', () => {
    const sql = sqlText('server');
    expect(sql).toContain('sudo bash -lc ');
    expect(sql).toContain('sudo su - db2inst1 -c ');
  });

  it('docker mode is unchanged', () => {
    const sql = sqlText('docker');
    expect(sql).toContain('docker exec -u 0 foxschema-db2 bash -lc ');
    expect(sql).toContain('docker exec foxschema-db2 su - db2inst1 -c ');
    expect(sql).not.toContain('sudo ');
  });

  it('runs the same commands either way', () => {
    // Only the way root is reached differs; the work must not.
    for (const verb of ['useradd', 'chpasswd', 'GRANT CONNECT']) {
      expect(sqlText('docker'), verb).toContain(verb);
      expect(sqlText('server'), verb).toContain(verb);
    }
  });

  it('does not claim the account is inside a container in server mode', () => {
    const out = build('server');
    if ('error' in out) throw new Error(out.error);
    const text = out.statements.map((st) => st.explanation).join('\n');
    expect(text).toContain('on the database server');
    expect(text).not.toContain('foxschema-db2');
  });

  it('defaults to the server, where most Db2 installations are', () => {
    // Ubuntu, Debian and RHEL hosts far outnumber the compose container this
    // repo ships, and a docker prefix on a plain server simply fails.
    const out = buildDb2OsUserInstructions({ name: 'report_user', database: 'FOXDB' });
    if ('error' in out) throw new Error(out.error);
    const sql = out.statements.map((s) => s.sql).join('\n');
    expect(sql).not.toContain('docker');
    expect(sql).toContain('sudo ');
  });

  it('makes the catalog checks runnable in the same terminal', () => {
    // These used to be bare SELECTs to paste into the SQL Editor, which meant
    // leaving the shell in the middle of the procedure.
    const out = buildDb2OsUserInstructions({ name: 'report_user', database: 'FOXDB' });
    if ('error' in out) throw new Error(out.error);
    const sql = out.statements.map((s) => s.sql).join('\n');
    expect(sql).toContain('db2 connect to FOXDB');
    expect(sql).toContain('SYSCAT.DBAUTH');
    // Every statement is a command; none is left as bare SQL.
    for (const st of out.statements) {
      expect(st.sql.startsWith('sudo ') || st.sql.startsWith('docker '), st.sql.slice(0, 40)).toBe(
        true
      );
    }
  });

  it('quotes a catalog query so its own single quotes survive', () => {
    // Db2 string literals must use single quotes, so `GRANTEETYPE = 'U'`
    // cannot sit inside a single-quoted shell argument. Verified by running
    // the emitted command against the Db2 container.
    const out = buildDb2OsUserInstructions({ name: 'report_user', database: 'FOXDB' });
    if ('error' in out) throw new Error(out.error);
    const q = out.statements.find((st) => st.sql.includes('SYSCAT.DBAUTH'))!.sql;
    expect(q).toContain('su - db2inst1 -c "');
    expect(q).toContain('db2 \\"SELECT');
    expect(q).toContain("GRANTEETYPE = 'U'");
  });
});
