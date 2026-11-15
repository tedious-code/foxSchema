SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
const out = [];
const factor = 2;
for (const r of last.rows) {
  const id = Number(r[0]);
  out.push({ id, email: r[1], n: id * factor });
}
return out;
-- @end
