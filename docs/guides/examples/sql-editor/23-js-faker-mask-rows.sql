-- Replace real values from the previous grid with fake ones (read-only — the
-- masked rows are returned, nothing is written back).
--
-- Seed per row id rather than once per cell: the same id then always masks to
-- the same value, so a value duplicated in another table can be masked to
-- match instead of drifting apart.

SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
import { faker } from '@faker-js/faker';

return (last?.rows ?? []).map((r) => {
  const id = Number(r[0]);
  faker.seed(id);
  const name = faker.person.fullName();
  return {
    id,
    real_email: String(r[1]),
    masked_name: name,
    masked_email: faker.internet.email({ firstName: name.split(' ')[0] }),
    masked_phone: faker.phone.number(),
  };
});
-- @end
