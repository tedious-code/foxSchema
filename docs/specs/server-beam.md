# Server Beam — cross-database data move via JS + SQL

## Goal

**Server Beam** lets an editor script move data between databases using mixed
JavaScript/TypeScript and SQL (`sql.on(alias)`), with async / Promises. Saved
credentials are the Beam endpoints; clients choose source and target servers
(and tables). The editor runtime queries only through the server-side bridge
(passwords never reach the browser sandbox).

## Out of scope (v1)

- Billing, entitlements, edition gates, or paid-tier product wording anywhere
  in code, UI copy, or docs for this feature
- Background job service (progress UI beyond the editor run is later)
- Distributed transactions across servers

## Locked decisions

| Rule | Value |
|------|--------|
| Beam servers selectable per editor Execute | **up to 2** (source + target) |
| SQL bridge calls per editor Execute | **up to 20** (`MAX_SQL`) — every `sql` / `sql.on` |
| Async / Promises in Node cells | **required** (already supported by code-cell runtime) |
| Password / decrypt | Server-only via existing `resolveRef` / connection store |

## Concepts

- **Server Beam** — the feature: run a script that reads/writes across up to two
  saved connections in one editor Execute.
- **Beam endpoint** — a saved connection used with an **alias** in editor scripts
  (same encrypted store as today’s credentials; run metadata adds alias + role:
  source | target).
- **`sql.on(alias)`** — Node/`@nodets` cell bridge that runs SQL on the endpoint
  bound to `alias` for this Execute (same trust model as today’s single-ref
  `sql\`...\``: worker posts query to parent; parent applies Safe mode + RBAC).
- **Editor Execute** — one Run from the SQL Editor (may include multiple
  statements / one code cell). Caps above apply per Execute.

## Editor contract (sketch)

```js
-- @node
const rows = await sql.on('oltp').`
  SELECT id, amount FROM orders WHERE id > ${cursor} LIMIT 500
`;
await sql.on('warehouse').`
  INSERT INTO orders_copy (id, amount) ${sql.values(rows)}
`;
return rows;
-- @end
```

- Aliases must map 1:1 to the at most **2** Beam endpoints chosen for the run.
- A third distinct alias / server → hard error.
- An 11th `sql.on()` in the same Execute → hard error.
- Browser-only `@js` / `@ts` cells do **not** get `sql.on` (no DB bridge).

## Backend sketch

1. Extend run payload for Node cells:
   `{ beam: [{ alias, connectionId }], … }`
   (still one worker; parent `makeCellQueryRunner` resolves alias → `ConnectionRef`).
2. Count `sql.on` invocations in the parent bridge; reject over 10.
3. Reject if resolved distinct `connectionId`s > 2.
4. Keep existing row caps / write permission checks per statement.

## UI sketch

- Credentials stay the store; Server Beam mode binds aliases for the run.
- SQL Editor run bar: pick **source** + **target** (max 2) when Beaming.
- Samples: “Server Beam: copy rows oltp → warehouse” using `sql.on`.

## Phases

1. **Bridge** — multi-endpoint `sql.on(alias)` + enforce 2 servers / 10 calls. *(done)*
2. **UI** — Destinations order = source then target when the cell uses `sql.on`;
   samples under Bookmarks → Add samples. *(v1 playable)*
3. **Hardening** — dedicated source/target picker, chunk helpers, more tests.

## How to try (v1)

1. Save **two** credentials; in SQL Editor check them as Destinations
   (**first = source**, **second = target**).
2. Bookmarks → **Add samples** → open
   `★ Sample · Server Beam ping (source + target)` or the copy/chunked samples.
3. Run. Node cells with `sql.on` execute **once** across both servers (no fan-out).

## Naming in repo

- Product / UI / docs: **Server Beam**
- Code identifiers (suggested): `serverBeam`, `beam`, `sql.on`
- Do not introduce paid-tier / entitlement flags for this feature in v1.
  Safety caps (2 servers / 10 `sql.on`) are product limits only.
