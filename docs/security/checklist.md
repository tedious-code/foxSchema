# Security checklist

Go through this before you open a pull request. Each line names the rule and
where it is enforced or written down, so you can check it rather than trust it.
How the CI security jobs work is in [security-process.md](security-process.md).
To report a vulnerability, see [SECURITY.md](../../SECURITY.md); do not open a
public issue.

## 1. Run the gates

```bash
npm run verify
```

This runs what CI runs on a pull request: typecheck, tests, lint, the frontend
build and budget, `npm audit`, the `node_modules` scan and gitleaks. A step that
cannot run on your machine (gitleaks not installed, no network for the audit)
shows as **SKIPPED**, never as a pass. A skipped security step has not been
checked, so install the tool or let CI run it before merging.

| Gate | Command on its own | Blocks |
|------|--------------------|--------|
| Security lint | `npm run lint:security` | any warning |
| Production advisories | `npm run audit:security` | high or critical |
| Installed-package scan | `npm run scan:deps-security` | high |
| Secret scan | `gitleaks detect --source .` | any finding |

The server's ESLint config runs a handful of security rules and nothing else, so
a clean lint says nothing about correctness. It is not a code review.

## 2. Secrets

- [ ] No password, token, API key, App Password or private key is in the diff,
      including tests, fixtures, Dockerfiles, `docker-compose*.yml` and commit
      messages.
- [ ] New settings are added to `.env.example` with an **empty** value. Real
      values go in `.env`, which git ignores.
- [ ] A new `.gitleaks.toml` allowlist entry has a comment saying why the value
      is safe (for example, a local Docker credential that is not used in
      production).
- [ ] If a secret was ever pushed, rotate it. Removing the commit is not enough.

## 3. Credentials the app holds

- [ ] Database passwords are never stored in the browser (local storage, session
      storage, IndexedDB) or in query history. Saved connections are encrypted on
      the server, and only host, database, schema, port and username come back to
      the browser.
- [ ] A secret the server stores (an SSO client secret, the SMTP password, a cloud
      credential) is encrypted before it is saved, and the API returns only
      whether one is set (`hasPassword`, never the value).
- [ ] Settings that come from environment variables cannot be overwritten from
      the UI.

## 4. Logging and error messages

The full logging contract is in
[BACKEND_ARCHITECTURE.md](../architecture/BACKEND_ARCHITECTURE.md).

- [ ] Nothing logs SQL text, query parameters or result rows.
- [ ] Nothing logs a connection string or options object that holds a password;
      log `host:port/database`.
- [ ] Error messages sent to the browser do not include absolute file paths,
      stack traces or raw npm output.

## 5. Routes and permissions

- [ ] Every new route sits behind the right permission guard
      (`requirePermissions(...)`) or is deliberately public, and a test covers
      the refused case.
- [ ] Anything that sends mail, issues a code or tries a password is rate
      limited.
- [ ] A permission enforced only by the UI is not a permission: the server checks
      it too.
- [ ] Bodyless requests use the shared API client. Fastify rejects an empty body
      sent with a JSON `Content-Type` before the route runs, so a hand-made
      `fetch` can fail without anyone noticing.
- [ ] Links in emails are built from the configured public URL, never from the
      request's `Host` header, which the requester controls.

## 6. SQL that reaches a customer database

- [ ] Statements that write go through the same execute gate as the SQL editor.
      Do not invent a second check: a regex that strips comments before deciding
      whether a statement writes can be fooled (`SELECT ... INTO`, `INTO OUTFILE`).
- [ ] Identifiers in generated DDL come from the real object name
      (`source?.name`), quoted for the dialect. Never use the uppercased compare
      key `obj.tableName`.
- [ ] User-supplied values are passed as parameters, not concatenated into SQL.
- [ ] A multi-statement run that stops on failure says so accurately, and one
      that continues says that instead.

## 7. Sign-in and SSO

The rules for which email each provider is trusted for are in
[DEPLOYMENT.md](../guides/DEPLOYMENT.md). A change to sign-in must keep them:

- [ ] Google: only `email_verified: true`.
- [ ] GitHub: only the primary, verified address.
- [ ] Microsoft: an unverified work-account email is refused under the `common`
      and `organizations` tenants.
- [ ] Codes and session tokens are stored only as hashes.

## 8. Data and migrations

- [ ] Metadata database migrations are append-only
      (`packages/server/src/database/schema.ts`). Never edit a shipped migration;
      add a new one.
- [ ] Destructive operations (drop, revert, force-migrate) are confirmed in the
      UI and refused by the server when policy says so.

## 9. Dependencies

- [ ] A new dependency follows
      [DEPENDENCY_POLICY.md](../conventions/DEPENDENCY_POLICY.md): an exact
      version in `package.json`, and the regenerated lockfile committed with it.
- [ ] `package-lock.json` changes only in the packages you meant to change.
- [ ] Frontend code imports only browser-safe workspace packages. Importing
      `@foxschema/db` or `@foxschema/server` fails the Vite build on purpose.
