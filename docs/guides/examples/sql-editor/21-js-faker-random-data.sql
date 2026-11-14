-- Generate random rows with @faker-js/faker (browser cell, no DB needed).
-- faker.seed(n) makes a run reproducible — drop it for fresh values each time.

-- @js
import { faker } from '@faker-js/faker';

faker.seed(2026);

const rows = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  name: faker.person.fullName(),
  email: faker.internet.email(),
  city: faker.location.city(),
  signed_up: faker.date.past({ years: 2 }).toISOString().slice(0, 10),
  balance: Number(faker.finance.amount({ min: 0, max: 5000, dec: 2 })),
}));
return rows;
-- @end
