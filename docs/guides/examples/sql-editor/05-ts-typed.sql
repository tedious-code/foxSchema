SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @ts
const factor: number = 3;
const out = (last ? last.rows : []).map((r: unknown[]) => ({
  id: Number(r[0]),
  email: String(r[1]),
  n: Number(r[0]) * factor,
}));
return out;
-- @end
