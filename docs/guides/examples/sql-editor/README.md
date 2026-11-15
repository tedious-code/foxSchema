# SQL Editor code-cell examples

Copy any `.sql` file into the SQL Editor, or use **Bookmarks → Add samples** in the app
to install the same scripts as named bookmarks (★ Sample · …).

They use `UNION ALL` demo rows so they run without a `user` table.

| File | What it shows |
|------|----------------|
| `01`–`08` | Sync JS/TS transforms, lodash, date-fns, chaining |
| `09-js-async-fetch.sql` | Browser `-- @js` with `await fetch` |
| `10-node-async-fetch.sql` | Server `-- @node` with `await fetch` |
| `11-ts-async-fetch.sql` | Browser `-- @ts` typed async fetch |
| `12-nodets-async-fetch.sql` | Server `-- @nodets` typed async fetch |
| `13-node-sql-transform.sql` | SQL rows → Node + lodash |
| `14-js-set-vars.sql` | `-- @set` then read `vars.*` |
| `15-js-promise-all.sql` | Parallel `Promise.all` + fetch |
| `16-js-lodash-aggregate.sql` | `groupBy` / `sumBy` over SQL rows |
| `17-js-columns-rows.sql` | Explicit `{ columns, rows }` return |
| `18-js-api-post.sql` | POST with query string, headers, JSON body |
| `19-js-api-bearer-secret.sql` | Bearer token from secret `vars.apiToken` |
| `20-node-api-post.sql` | Node POST with headers / query / body |
| `21-js-faker-random-data.sql` | Random rows from `@faker-js/faker` (seeded) |
| `22-node-faker-insert.sql` | Node cell seeding a table via the `sql` bridge |
| `23-js-faker-mask-rows.sql` | Mask real rows, seeded per id so values stay stable |
