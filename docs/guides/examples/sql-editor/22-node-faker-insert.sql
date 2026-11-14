-- Seed a table with fake rows from a Node cell, using the `sql` bridge.
-- WRITES — turn Safe mode OFF to run. Written for Postgres / MySQL / SQLite /
-- SQL Server (Oracle and Db2 spell DROP ... IF EXISTS differently).
-- Point this at a scratch database, never production.

-- @node
import { faker } from '@faker-js/faker';

const rows = Array.from({ length: 25 }, (_, i) => {
  // Deterministic per id, so re-running rebuilds the same people.
  faker.seed(1000 + i);
  return {
    id: i + 1,
    name: faker.person.fullName(),
    email: faker.internet.email(),
    city: faker.location.city(),
  };
});

await sql`DROP TABLE IF EXISTS fox_demo_people`;
await sql`CREATE TABLE fox_demo_people (id INTEGER, name VARCHAR(200), email VARCHAR(200), city VARCHAR(200))`;

// One INSERT per batch, every value bound — not 25 round trips.
const CHUNK = 10;
for (let i = 0; i < rows.length; i += CHUNK) {
  await sql`INSERT INTO ${sql.id('fox_demo_people')} ${sql.values(rows.slice(i, i + CHUNK))}`;
}

return await sql`SELECT id, name, email, city FROM fox_demo_people ORDER BY id`;
-- @end
