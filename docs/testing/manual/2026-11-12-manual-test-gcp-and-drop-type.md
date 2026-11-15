# Manual test — Google Cloud secrets and Drop Type (2026-11-12)

Two parts, each run in its own build of Fox:

| Part | Feature | Where it is | Run Fox from |
|---|---|---|---|
| A | Google Cloud secrets: Connect, Fetch, connect at Google sign-in | `main` (0.3.6: #605, #606) | the main checkout |
| B | Utilities → Drop Type | branch `feat/utilities-drop-type`, not committed | `.claude/worktrees/drop-type` |

Write the result of each row in the **Result** column: ✅ pass, ❌ fail (with what you saw), or ⏭ skipped.
Seed files are next to this file.

---

## 0. Setup (once)

1. **Start Docker Desktop**, then start the two databases:
   ```bash
   docker start foxschema-postgres foxschema-sqlserver
   ```
   Wait until `docker ps` shows both as `healthy`.
2. **Bring the main checkout's packages in line with the lockfile.** `npm run verify` found 85 out-of-date packages and 11 folders left over from an interrupted install. Stop `npm run dev` first, then:
   ```bash
   cd /Users/hiphan/Documents/GitHub/foxSchema && git pull && npm ci
   ```
3. **Google Cloud.** In the project that holds your secrets:
   - Enable **Secret Manager API**.
   - Create the secret `fox-manual-test`, with version 1 = `hello-v1`, then add version 2 = `hello-v2`.
   - In IAM, give your Google account **Secret Manager Secret Accessor** and **Secret Manager Viewer**.
   - On the OAuth app's **Audience** page, if it's *External* and in *Testing*, add your Google account as a **test user**.
4. **OAuth client redirect URIs** (Google Cloud Console → Clients → your Web client). Add both:
   ```
   http://localhost:5173/api/app-secrets/providers/gcp/oauth/callback
   http://localhost:5173/api/auth/sso/google/callback
   ```

---

## Part A — Google Cloud secrets (main checkout)

### A-setup: dedicated Google Cloud client

Add to `apps/web/.env` in the main checkout:
```
GCP_OAUTH_CLIENT_ID=<your client id>
GCP_OAUTH_CLIENT_SECRET=<your client secret>
```
Then run `npm run dev`, open http://localhost:5173 and sign in.

| ID | Steps | Expected | Result |
|---|---|---|---|
| A1 | Activity rail → **Credentials** → **Cloud providers** tab. Name: `Manual GCP`. Click **Connect Google Cloud**. | Google's consent screen asks for read-only access to Google Cloud data. After **Allow** you're back in Fox, and the list shows **Manual GCP** as Google Cloud. No token is shown anywhere. | |
| A2 | Open the browser's devtools → **Network**, then reopen Credentials → Cloud providers. Inspect the JSON response that lists cloud credentials. | No `refreshToken` or `accessToken` field anywhere in the response. | |
| A3 | **SQL Editor** → **Secrets** panel → **+** → mode **Fetch from cloud**. Variable name `gcpTest`. Credential **Manual GCP**, then pick your project, then secret `fox-manual-test`. Leave the version at the newest. Click **Fetch**. | The secret is added and shows `••••`, never the value. | |
| A4 | In the editor, insert the secret (**Insert** on the `gcpTest` row puts `${{gcpTest}}` at the cursor). Run `SELECT '${{gcpTest}}' AS v;` on any connection. | The result shows `hello-v2`. **Recent** and the **Out [n]** label show `${{gcpTest}}` or `(secret)`, not the value. | |
| A5 | Repeat A3 with name `gcpOld`, version **1**. | Fetch works; running it gives `hello-v1`. | |
| A6 | Reload the page, then look at the Secrets panel. | The secrets are still listed, but their values are gone; you fetch them again after a reload (they're session-only). | |
| A7 | Credentials → Cloud providers → add an **AWS** credential named `Clash` (any fake keys) → Save. Then type name `Clash` and click **Connect Google Cloud**. | Refused: a credential named "Clash" exists and isn't a Google Cloud connection. The AWS credential is unchanged. | |
| A8 | Click **Connect Google Cloud** again with name `Manual GCP`. | It reconnects in place, as you're an admin: still one **Manual GCP**, and A3 still works. | |
| A9 | Click **Connect Google Cloud**, then switch Fox to a different workspace in another tab before approving on Google. Then approve. | Refused: the workspace changed. Nothing is saved in either workspace. | |
| A10 | Access control → **Sign-in** → **Google** card. | The **Also connect Google Cloud for secrets** switch is there, with an amber note: *Not in effect … GCP_OAUTH_CLIENT_ID …*. | |
| A11 | (Optional) In IAM, remove **Secret Manager Secret Accessor** from your account, wait a minute, then repeat A3. Put the role back afterwards. | **Fetch** shows a permission error from Google. Nothing is added. | |

### A-setup 2: sign-in client only (for connecting at sign-in)

1. Remove `GCP_OAUTH_CLIENT_ID` and `GCP_OAUTH_CLIENT_SECRET` from `apps/web/.env`, then restart `npm run dev`.
2. In Access control → Sign-in → **Google**, enter the **same** client's ID and secret, then **Save**.
3. The Fox account you sign in with must use **the same email as your Google account**. Google sign-in signs in existing accounts only.

| ID | Steps | Expected | Result |
|---|---|---|---|
| A12 | Access control → Sign-in → Google card. | The switch has **no** amber note now, and is unticked (off by default). | |
| A13 | Credentials → Cloud providers: delete any connection named exactly **Google Cloud** in your **personal** workspace. Sign out, then **Continue with Google**. | Google asks only for your profile and email, not Google Cloud. You're signed in, and no "Google Cloud" connection appears. | |
| A14 | Tick **Also connect Google Cloud for secrets**. Sign out, then **Continue with Google**. | Google asks for Google Cloud access. You're signed in. In your **personal** workspace, Credentials → Cloud providers shows **Google Cloud**, and A3 works with it. | |
| A15 | Sign out, then sign in with Google again. | No Google Cloud consent this time (already granted). Still exactly one **Google Cloud**, unchanged. | |
| A16 | Switch to a **shared** workspace → Credentials → Cloud providers. | The sign-in connection is **not** there; it lives in your personal workspace only. | |
| A17 | (Needs a second Google account that is also a Fox user.) Revoke Fox's access for it at myaccount.google.com → Security → Third-party connections. Sign in with Google and **untick** Google Cloud on the consent screen. | Signed in. No "Google Cloud" connection is created for that account. | |
| A18 | Untick the switch. Sign out, then sign in with Google. | The consent asks only for profile and email, and sign-in works. | |

---

## Part B — Drop Type (Drop Type branch)

### B-setup

1. **Stop** the main checkout's `npm run dev`. Both apps use ports 3210 and 5173.
2. Give the branch a **copy** of your app database, so your account and saved connections come along. No migrations were added since its base, so the copy works:
   ```bash
   cd /Users/hiphan/Documents/GitHub/foxSchema
   cp packages/server/src/database/foxschema.db* .claude/worktrees/drop-type/packages/server/src/database/
   ```
3. Start the branch:
   ```bash
   cd /Users/hiphan/Documents/GitHub/foxSchema/.claude/worktrees/drop-type && npm run dev
   ```
4. In Credentials, add these saved connections. The **schema** matters: Drop Type lists the types in the connection's schema.

   | Name | Engine | Host / file | Database | User / password | Schema |
   |---|---|---|---|---|---|
   | Manual PG | PostgreSQL | 127.0.0.1:5432 | foxdb | foxuser / foxpass | `fox_manual` |
   | Manual MSSQL | SQL Server | 127.0.0.1:1433 | master | sa / FoxPass123! | `fox_manual` |
   | Manual Duck | DuckDB | `/Users/hiphan/fox-manual.duckdb` | — | — | `main` |
   | (any) | MySQL | your existing MySQL connection | | | |

5. Seed each engine. In the SQL editor, pick the connection, paste the whole seed file and run it:
   - Manual PG: `drop-type-seed-postgres.sql`
   - Manual MSSQL: `drop-type-seed-sqlserver.sql`
   - Manual Duck: `drop-type-seed-duckdb.sql`

   Rerunning a seed starts that engine over.
6. Open **Utilities** → **Maintenance** → **Drop Type**, and pick the connection in the Utilities header. After seeding, reload the page so the type list is fresh.

### PostgreSQL (Manual PG)

| ID | Steps | Expected | Result |
|---|---|---|---|
| PG-1 | Open the **Type** list. | `address`, `email`, `mood`, `order_status`, `point2`, `priority`. | |
| PG-2 | Pick `mood`. | Shown as an enum with 2 values, `sad · ok`. *What uses it:* none. **1 step**: `DROP TYPE "fox_manual"."mood";`, with the note "No CASCADE …". No "Its columns become" field. | |
| PG-3 | Click **Execute all**. With Safe mode on, **Confirm: drop mood** appears; click **Cancel** first, then **Execute all** → **Confirm**. | Cancel runs nothing. Confirm shows **Dropped mood.**, and `mood` leaves the list. | |
| PG-4 | Pick `priority`. | **Refused**: *bump takes priority as a parameter … Drop it, or change its parameters …*. No steps and no Execute button. Function `bump` is listed as may-use. | |
| PG-5 | Pick `address`. | **Refused**: *A column is declared with address (customers.home), and PostgreSQL has no in-place change …*. | |
| PG-6 | Pick `point2` → Execute all → Confirm. | **Dropped point2.** | |
| PG-7 | Pick `order_status`. Type `varchar(5)` in **Its columns become**. | **Refused**: *varchar(5) is shorter than the longest value, 'cancelled' (9 characters).* | |
| PG-8 | Clear the field (the placeholder shows `text`). Leave **Keep the allowed values** ticked. | Uses: `orders.status · not null · default 'new'::…` and `orders.tags (array)`. **3 steps**: change `orders.status` to text (DROP DEFAULT, TYPE text, SET DEFAULT `'new'`, ADD CONSTRAINT … CHECK IN (…4 values)); change `orders.tags` to `text[]` (CHECK `<@ ARRAY[…]`); drop `order_status`. No CASCADE. | |
| PG-9 | Click **Copy all** and paste somewhere. Then **Open in editor**. | The clipboard has the 3 steps under `-- Step n:` comments. A new editor tab **Drop order_status** opens with the same SQL, set to Manual PG only. | |
| PG-10 | Back in Drop Type: **Execute all** → Confirm. The view `v_open` uses `status` without naming the type, so Fox can't see it. | Stops at step 1 with an error like *cannot alter type of a column used by a view or rule*. **Nothing changed**: `order_status` is still listed. | |
| PG-11 | Straight after PG-10, run `SELECT 1;` on Manual PG in the SQL editor, three times. | Works every time. Before today's fix, a failed step could leave a connection stuck: *current transaction is aborted, commands ignored …*. | |
| PG-12 | Run `DROP VIEW fox_manual.v_open;`, return to Drop Type, reload, pick `order_status`, **Execute all** → Confirm. | **Dropped order_status.** | |
| PG-13 | Check the data. Run `SELECT id, status, tags, pg_typeof(status) FROM fox_manual.orders ORDER BY id;` | 3 rows, values unchanged (`paid`/`{new,shipped}`, `cancelled`/null, `new`/`{paid}`). Type is `text`. | |
| PG-14 | Check the rules. Run `INSERT INTO fox_manual.orders (id, status) VALUES (9, 'bogus');`, then `INSERT INTO fox_manual.orders (id) VALUES (10); SELECT status FROM fox_manual.orders WHERE id = 10;` | The first is refused by `orders_status_check`. The second stores `new` (the default, now without the cast). | |
| PG-15 | Pick `email`. | A domain over `character varying(120)`. Warning: *A domain's own rules (NOT NULL, CHECK) go with it …*. 2 steps. Execute all → Confirm → **Dropped email.** Afterwards `contact` is `varchar(120)` with default `'a@b.c'`. | |

### SQL Server (Manual MSSQL)

| ID | Steps | Expected | Result |
|---|---|---|---|
| MS-1 | Open the **Type** list. | `Phone`, `Unused`. | |
| MS-2 | Pick `Unused` → Execute all → Confirm. | 1 step, `DROP TYPE [fox_manual].[Unused];`. **Dropped Unused.** | |
| MS-3 | Pick `Phone`. | An alias type over `varchar(20)`. Uses `orders.phone`, `orders.alt`, `orders.memo`. **4 steps**: one per column (each a single batch, `SET XACT_ABORT ON … COMMIT TRANSACTION;`), then `DROP TYPE`. | |
| MS-4 | Execute all → Confirm. | **Dropped Phone.** | |
| MS-5 | Run `SELECT c.name, TYPE_NAME(c.user_type_id) t, c.max_length, c.is_nullable, OBJECT_NAME(c.default_object_id) df FROM sys.columns c WHERE c.object_id = OBJECT_ID('fox_manual.orders') ORDER BY c.column_id;` | `phone` varchar 20, not null, default **`df_orders_phone`**. `alt` varchar 20, null, default **`df_alt`**. `memo` varchar 20, null, a `DF__…` name. Named defaults keep their names; this is today's fix. | |
| MS-6 | Run `SELECT * FROM fox_manual.orders; INSERT INTO fox_manual.orders (id) VALUES (3); SELECT phone, alt, memo FROM fox_manual.orders WHERE id = 3;` and check that index `orders_phone_idx` still exists. | Rows 1–2 are unchanged. Row 3 gets `000`, `it's`, `zz`. The index is still there. | |

### DuckDB (Manual Duck)

| ID | Steps | Expected | Result |
|---|---|---|---|
| DK-1 | Pick `size_t`. | **Refused**: *shirts.size cannot be moved off size_t: DuckDB will not change a column of shirts while the table has an index (shirts_size_idx) …*. | |
| DK-2 | Pick `mood`. | Uses `diary.m`. No **Keep the allowed values** box. Warning: *… DuckDB cannot add a check constraint to an existing table.* 2 steps: change `diary.m` to `VARCHAR`, then drop `mood`. | |
| DK-3 | Execute all → Confirm, then `SELECT * FROM diary ORDER BY id;` | **Dropped mood.** Rows `sad`, `happy`, null are unchanged, and the column is `VARCHAR` with default `'ok'`. | |

### Other engines

| ID | Steps | Expected | Result |
|---|---|---|---|
| OT-1 | Pick a **MySQL** connection in the Utilities header. | *MySQL has no user-defined types of its own, so there is nothing here to drop.* No type list. | |
| OT-2 | Pick a connection that needs a session password, if you have one. | A **Session password** field and **Unlock**. After unlocking, the type list loads. | |

### Regression: Rename Column (shares today's transaction fix)

| ID | Steps | Expected | Result |
|---|---|---|---|
| RC-1 | After PG-15, where `contact` is now a plain `varchar(120)` (don't reseed): Utilities → **Rename Column** → table `orders`, column `contact`. New type `varchar(200)`. Tick **Large table mode**, then **Execute all** → Confirm. | All parts finish. `contact` is `varchar(200)` with its values intact. | |
| RC-2 | Run `SELECT 1;` on Manual PG a few times. | Works every time. | |

---

## Afterwards

- **Part B:** stop the branch's `npm run dev`, then start the main checkout's again. Your real database was never touched: the branch used a copy.
- **Scratch data:**
  - PostgreSQL: `DROP SCHEMA fox_manual CASCADE;`
  - SQL Server: run the first lines of its seed file, which drop the table, the types and the schema.
  - DuckDB: delete `/Users/hiphan/fox-manual.duckdb`.
- Send me the rows marked ❌.
