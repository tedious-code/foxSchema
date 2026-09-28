# Unreleased

Notes for the next release. At ship time, rename this file to that version's
`RELEASE_<version>.md` and use it as the GitHub Release body.

## Workspaces

- **Snapshots** is its own left-rail workspace (schema history / Lokee). **Applies**
  at the bottom of the rail is migration-run history. They are not the same list.
- **Utils** is its own workspace (Index Management, Clone Table, insights, Query
  files, DB users & grants) — not a SQL Editor sidebar.
- Saved credentials are grouped by dialect; Home continues last compare / query.

## Origin policy

`npm run dev` allows this machine's own literal IPs on ports 5173 / 5199 / 3210 /
3211, so a Vite **Network:** URL works. Arbitrary hostnames are still refused.
Production stays same-origin; set `FOX_ALLOWED_ORIGINS` for a split hostname.
See [DEPLOYMENT.md](../DEPLOYMENT.md#origin-policy).

## Schema history (Lokee): definitions are compared the way Compare compares them

Compare and Lokee used to decide "is this view / routine / trigger the same?"
differently. Compare folded case and dropped schema qualifiers; Lokee only
collapsed whitespace. So an object Compare called **unchanged** could still get
a new Lokee version — for example after the engine re-cased a view on storage,
or when the same body was captured with and without its `schema.` prefix.

Both now use one rule (`normalizeDefinitionText` in `@foxschema/sql`):

- whitespace and a trailing `;` are formatting;
- keyword and identifier case is folded;
- the history's own schema qualifier is ignored (`app.orders` = `orders`);
- **the case inside string literals is kept**: `status = 'Active'` and
  `status = 'active'` select different rows. Compare used to fold these too and
  report a real change as unchanged; it now reports it as modified.

Lokee applies the rule only when computing an object's hash. The definition it
stores is still exactly as captured, because revert builds its DDL from it.

### What you will see once

Hashes of views, routines and triggers change under the new rule. The first
capture of each existing history after upgrading records **one new version**
listing those objects as modified, although their text has not changed. After
that capture, versions appear only for real changes.

Revert and force-migrate are not affected by the boundary: when two stored
versions' hashes differ, both sides are re-hashed with the current rule before
deciding whether an object changed.
