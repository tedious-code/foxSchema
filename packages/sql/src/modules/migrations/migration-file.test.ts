/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A migration file must read back into exactly the steps that were written —
 * a teammate's migration pulled from Git runs those steps — and must never
 * carry a password.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMigrationFile,
  findLeftoverSecrets,
  migrationFileName,
  parseMigrationFile,
  scrubSecrets,
} from './migration-file';
import type { MigrationStep } from './sql-generator.module';

const header = {
  note: 'Add the orders index\n\nThe reports need it.',
  dialect: 'postgres',
  target: 'app_db.public',
  source: 'staging.public',
  author: 'ana@example.com',
  created: '2026-10-02T15:30:12.000Z',
};

const steps: MigrationStep[] = [
  { action: 'CREATE', objectType: 'TABLE', objectName: 'orders', statements: ['CREATE TABLE orders (\n  id int primary key,\n  note text\n);', 'CREATE INDEX ix_orders ON orders (id);'] },
  { action: 'ALTER', objectType: 'VIEW', objectName: 'My "odd" view', statements: ["CREATE OR REPLACE VIEW v AS\nSELECT '-- fox:step not a marker' AS x;\n\n\nSELECT 2;"] },
  { action: 'DROP', objectType: 'FUNCTION', objectName: 'f', statements: ['DROP FUNCTION f();'], skipped: 'kept: still referenced' },
  { action: 'CREATE', objectType: 'PROCEDURE', objectName: 'p', statements: ['CREATE PROCEDURE p()\nBEGIN\n-- fox:next looks like a marker\nSELECT 1;\nEND'] },
];

describe('migration files', () => {
  it('read back into exactly the steps and header that were written', () => {
    const { content } = buildMigrationFile(header, steps);
    expect(content.startsWith('-- fox:migration v1\n-- note: Add the orders index\n')).toBe(true);
    expect(content).not.toContain('localhost');
    const parsed = parseMigrationFile(content);
    expect(parsed.header).toEqual(header);
    expect(parsed.steps).toEqual(steps);
  });

  it('round-trips with Windows line endings too', () => {
    const { content } = buildMigrationFile(header, steps.slice(0, 1));
    expect(parseMigrationFile(content.replace(/\n/g, '\r\n')).steps).toEqual(steps.slice(0, 1));
  });

  it('needs a note and at least one step, and refuses files that are not Fox migrations', () => {
    expect(() => buildMigrationFile({ ...header, note: ' ' }, steps)).toThrow(/note is required/);
    expect(() => buildMigrationFile(header, [])).toThrow(/nothing to commit/);
    expect(() => parseMigrationFile('CREATE TABLE x (id int);')).toThrow(/not a Fox migration/);
    expect(() => parseMigrationFile('-- fox:migration v9\n-- dialect: x')).toThrow(/version 9/);
  });

  it('names files by time and note', () => {
    expect(migrationFileName('Add the orders index!', new Date('2026-10-02T15:30:12Z'))).toBe('20261002-153012__add-the-orders-index.sql');
    expect(migrationFileName('   ', new Date('2026-10-02T15:30:12Z'))).toBe('20261002-153012__migration.sql');
    expect(migrationFileName('Ça marche: déjà vu', new Date('2026-10-02T15:30:12Z'))).toBe('20261002-153012__ca-marche-deja-vu.sql');
  });
});

describe('secrets', () => {
  const scrub = (sql: string, dialect = 'postgres') => scrubSecrets(sql, dialect);
  /** Each input becomes its output: one password replaced, nothing refused. */
  const expectScrubbedOnce = (cases: Array<[string, string]>, dialect?: string) => {
    for (const [input, output] of cases) expect(scrub(input, dialect), input).toEqual({ text: output, replaced: 1, unreadable: [] });
  };
  const expectUntouched = (sqls: string[], dialect?: string) => {
    for (const sql of sqls) expect(scrub(sql, dialect), sql).toEqual({ text: sql, replaced: 0, unreadable: [] });
  };
  /** The 1-based line of the file where the first line of `step`'s statement lands. */
  const statementLine = (step: MigrationStep) =>
    buildMigrationFile(header, [{ ...step, statements: ['SELECT 1;'] }]).content.split('\n').indexOf('SELECT 1;') + 1;

  it('replaces password literals in every dialect shape', () => {
    expectScrubbedOnce([
      ["CREATE ROLE app WITH LOGIN PASSWORD 's3cret';", "CREATE ROLE app WITH LOGIN PASSWORD '<password>';"],
      ["CREATE USER app IDENTIFIED BY 'p@ss';", "CREATE USER app IDENTIFIED BY '<password>';"],
      ['CREATE USER app IDENTIFIED BY "Oracle#1";', 'CREATE USER app IDENTIFIED BY "<password>";'],
      ['ALTER USER app IDENTIFIED BY Plain123;', 'ALTER USER app IDENTIFIED BY <password>;'],
      ["CREATE LOGIN app WITH PASSWORD = N'Sql!Server1';", "CREATE LOGIN app WITH PASSWORD = N'<password>';"],
      ["CREATE USER app IDENTIFIED WITH sha256_password BY 'ch';", "CREATE USER app IDENTIFIED WITH sha256_password BY '<password>';"],
      ["ALTER USER app PASSWORD 'it''s';", "ALTER USER app PASSWORD '<password>';"],
    ]);
    expect(scrub("CREATE ROLE app PASSWORD '<password>';").replaced).toBe(0);
  });

  it('leaves ordinary SQL that mentions passwords exactly as written', () => {
    const ordinary = [
      "CREATE VIEW stale AS SELECT id FROM users WHERE password = 'changeme'",
      "CREATE PROCEDURE reset_pw() BEGIN UPDATE users SET password = 'reset'; END",
      "UPDATE settings SET value = 'x' WHERE name = 'password'",
      "CREATE TABLE t (password varchar(100) DEFAULT 'none')",
      "-- who still has the default\nCREATE VIEW v AS SELECT id FROM users WHERE password = 'x'",
    ];
    expectUntouched(ordinary);
    const built = buildMigrationFile(header, ordinary.map((sql, i) => ({ action: 'CREATE' as const, objectType: 'VIEW' as const, objectName: `v${i}`, statements: [sql] })));
    expect(built.scrubbed).toBe(0);
    expect(parseMigrationFile(built.content).steps.map((s) => s.statements[0])).toEqual(ordinary);
  });

  it('does not read keywords inside string literals or quoted names', () => {
    expectScrubbedOnce([[`CREATE USER "PASSWORD 'x'" IDENTIFIED BY 'real';`, `CREATE USER "PASSWORD 'x'" IDENTIFIED BY '<password>';`]]);
  });

  it('reads account statements behind leading comments, and quotes in comments do not hide a value', () => {
    expectScrubbedOnce([
      ["-- the app role\nCREATE ROLE app LOGIN PASSWORD 'hunter2';", "-- the app role\nCREATE ROLE app LOGIN PASSWORD '<password>';"],
      ["/* rotated */ ALTER USER app IDENTIFIED BY 'hunter2';", "/* rotated */ ALTER USER app IDENTIFIED BY '<password>';"],
      ["CREATE USER app -- the user's account\n  PASSWORD 'hunter2';", "CREATE USER app -- the user's account\n  PASSWORD '<password>';"],
      ["CREATE ROLE app PASSWORD /* keep */ 'hunter2';", "CREATE ROLE app PASSWORD /* keep */ '<password>';"],
      ["SET PASSWORD FOR app -- it's\n = 'hunter2';", "SET PASSWORD FOR app -- it's\n = '<password>';"],
    ]);
  });

  it("reads # as a comment only where the dialect does: MySQL's comment, Oracle's name character", () => {
    expectScrubbedOnce(
      [
        ["CREATE USER app # the user's account\n  IDENTIFIED BY 'hunter2';", "CREATE USER app # the user's account\n  IDENTIFIED BY '<password>';"],
        ["# the user's account\nCREATE USER app IDENTIFIED BY 'hunter2';", "# the user's account\nCREATE USER app IDENTIFIED BY '<password>';"],
      ],
      'mysql'
    );
    expectScrubbedOnce([['CREATE USER app#1 IDENTIFIED BY "hunter2";', 'CREATE USER app#1 IDENTIFIED BY "<password>";']], 'oracle');
  });

  it('replaces passwords however they are quoted or encoded', () => {
    expectScrubbedOnce([
      ['CREATE ROLE app PASSWORD $$hunter2$$;', 'CREATE ROLE app PASSWORD $$<password>$$;'],
      ["CREATE ROLE app PASSWORD $pw$it's$pw$ VALID UNTIL '2027-01-01';", "CREATE ROLE app PASSWORD $pw$<password>$pw$ VALID UNTIL '2027-01-01';"],
      ["CREATE ROLE app PASSWORD E'hunter2';", "CREATE ROLE app PASSWORD E'<password>';"],
      ["CREATE ROLE app PASSWORD 'hun'\n  'ter2';", "CREATE ROLE app PASSWORD '<password>';"],
      ['CREATE USER app PASSWORD = "hunter2";', 'CREATE USER app PASSWORD = "<password>";'],
      ['CREATE LOGIN app WITH PASSWORD = 0x0200A1B2C3 HASHED;', 'CREATE LOGIN app WITH PASSWORD = <password> HASHED;'],
      ["CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED WITH 'caching_sha2_password' BY 'hunter2';", "CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED WITH 'caching_sha2_password' BY '<password>';"],
      ["SET PASSWORD FOR 'app'@'localhost' = 'hunter2';", "SET PASSWORD FOR 'app'@'localhost' = '<password>';"],
      ["SET PASSWORD = PASSWORD('hunter2');", "SET PASSWORD = PASSWORD('<password>');"],
      ["CREATE DATABASE SCOPED CREDENTIAL c WITH IDENTITY = 'svc', SECRET = 'hunter2';", "CREATE DATABASE SCOPED CREDENTIAL c WITH IDENTITY = 'svc', SECRET = '<password>';"],
      ["CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'app', password 'hunter2');", "CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'app', password '<password>');"],
      ["CREATE PUBLIC DATABASE LINK l CONNECT TO app IDENTIFIED BY hunter2 USING 'db';", "CREATE PUBLIC DATABASE LINK l CONNECT TO app IDENTIFIED BY <password> USING 'db';"],
      ["GRANT ALL ON *.* TO 'app'@'%' IDENTIFIED BY 'hunter2';", "GRANT ALL ON *.* TO 'app'@'%' IDENTIFIED BY '<password>';"],
    ]);
    // The old password too, wherever a statement takes one.
    expect(scrub("ALTER LOGIN app WITH PASSWORD = 'new1' OLD_PASSWORD = 'old1';").text).toBe(
      "ALTER LOGIN app WITH PASSWORD = '<password>' OLD_PASSWORD = '<password>';"
    );
    expect(scrub("ALTER USER app IDENTIFIED BY 'new1' REPLACE 'old1' RETAIN CURRENT PASSWORD;").text).toBe(
      "ALTER USER app IDENTIFIED BY '<password>' REPLACE '<password>' RETAIN CURRENT PASSWORD;"
    );
    expect(scrub('ALTER USER app IDENTIFIED BY new1 REPLACE old1;').text).toBe('ALTER USER app IDENTIFIED BY <password> REPLACE <password>;');
    expect(scrub("CREATE ROLE a PASSWORD 'x1'; CREATE ROLE b PASSWORD 'y2';").replaced).toBe(2);
  });

  it('leaves password options, names and parameters in account statements alone', () => {
    expectUntouched([
      'ALTER USER app PASSWORD EXPIRE;',
      'ALTER ROLE app PASSWORD NULL;',
      'ALTER USER app RESET PASSWORD;',
      'CREATE USER app IDENTIFIED BY RANDOM PASSWORD;',
      'CREATE USER app IDENTIFIED WITH auth_socket;',
      "ALTER ROLE app SET password_encryption = 'scram-sha-256';",
      'GRANT SELECT (id, password) ON users TO app;',
      'GRANT SELECT ON secret.tokens TO app;',
      'CREATE USER password WITH LOGIN;',
      'ALTER LOGIN app WITH PASSWORD = @pw;',
      "CREATE ROLE app PASSWORD '';",
    ]);
  });

  it('fails closed on a password it cannot read, naming the line', () => {
    expect(scrub('CREATE ROLE app\n  LOGIN\n  PASSWORD 12345;').unreadable).toEqual([3]);
    expect(scrub("CREATE USER app PASSWORD 'it\\'s';").unreadable).toEqual([1]);
    // Where a string ends depends on the dialect's escaping, so a later password could hide in it.
    expect(scrub("CREATE USER 'o\\'brien'@'%' IDENTIFIED BY 'hunter2';", 'mysql').unreadable).toEqual([1]);
    expect(scrub('SET PASSWORD FOR app;').unreadable).toEqual([1]);
    expect(scrub("CREATE USER app -- old password 'hunter1'\n  PASSWORD 'hunter2';")).toEqual({
      text: "CREATE USER app -- old password 'hunter1'\n  PASSWORD '<password>';",
      replaced: 1,
      unreadable: [1],
    });
    // A refusal inside a value that is replaced still counts.
    expect(scrub("CREATE ROLE app PASSWORD 'a' /* password 'b' */ 'c';").unreadable).toEqual([1]);
    const step: MigrationStep = { action: 'CREATE', objectType: 'ROLE', objectName: 'app', statements: ['CREATE ROLE app\n  PASSWORD 12345;'] };
    expect(() => buildMigrationFile(header, [step])).toThrow(new RegExp(`^Line ${statementLine(step) + 1} .*password`));
  });

  it('handles hostile input in linear time', () => {
    const t0 = Date.now();
    scrub('CREATE USER a PASSWORD ' + "'" + "''".repeat(50000));
    scrub('CREATE USER a ' + '/*'.repeat(50000));
    scrub('CREATE USER a ' + ' $a'.repeat(50000));
    scrub('CREATE USER a ' + 'PASSWORD '.repeat(50000));
    scrub('SET PASSWORD FOR ' + "'a'@".repeat(50000));
    scrub('SET ' + 'PASSWORD FOR x '.repeat(50000));
    scrub('CREATE USER a PASSWORD ' + '('.repeat(50000) + "'x'");
    findLeftoverSecrets('x'.repeat(100000) + "'password=" + 'a'.repeat(100000));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('commits a scrubbed plan, and says how many it scrubbed', () => {
    const built = buildMigrationFile(header, [
      { action: 'CREATE', objectType: 'ROLE', objectName: 'app', statements: ["CREATE ROLE app WITH LOGIN PASSWORD 'hunter2';"] },
    ]);
    expect(built.scrubbed).toBe(1);
    expect(built.content).not.toContain('hunter2');
  });

  it('refuses a plan that still carries a credential, naming the line', () => {
    const leaky: MigrationStep = { action: 'CREATE', objectType: 'VIEW', objectName: 'v', statements: ["CREATE VIEW v AS SELECT 'postgres://app:hunter2@db:5432/x' AS dsn;"] };
    expect(() => buildMigrationFile(header, [leaky])).toThrow(new RegExp(`Line ${statementLine(leaky)} .*credential`));
    expect(findLeftoverSecrets("SELECT 'Server=db;User Id=app;Password=hunter2;'")).toEqual([1]);
    expect(findLeftoverSecrets("SELECT 'api_key=abc123def'")).toEqual([1]);
    expect(findLeftoverSecrets("CREATE ROLE r PASSWORD '<password>';")).toEqual([]);
    expect(findLeftoverSecrets("SELECT * FROM users WHERE password = 'x'")).toEqual([]);
  });
});
