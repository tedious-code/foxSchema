# @foxschema/db-db2

IBM Db2 support for [`@foxschema/db`](../db), as an add-on.

Db2's driver (`ibm_db`, with the IBM CLI driver it downloads) is about 59 MB, so
`@foxschema/db` does not carry it. Install this package only when you talk to Db2:

```bash
npm install @foxschema/db @foxschema/db-db2
```

```ts
import { openDatabase } from '@foxschema/db';

// Finds and registers @foxschema/db-db2 on first use.
const db = await openDatabase('db2', { host, port: 50000, database, username, password });
```

Without this package, `openDatabase('db2', …)` fails with
`db2 support is an add-on: npm install @foxschema/db-db2`.

A host that always wants Db2 registers it once at startup:

```ts
import { registerDb2 } from '@foxschema/db-db2';
registerDb2();
```

Generating Db2 SQL (DDL, type mapping, migrations) needs no driver and stays in
`@foxschema/sql`.

`ibm_db` runs an install script that downloads the IBM CLI driver. If scripts
were skipped, reinstall with `npm install ibm_db@4.1.0 --foreground-scripts`
(or `foxschema drivers install db2`).
