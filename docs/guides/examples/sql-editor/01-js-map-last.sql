SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
-- @set doubled = table
return {
  columns: ['id', 'email', 'n'],
  rows: last.rows.map((r) => [r[0], r[1], Number(r[0]) * 2]),
};
-- @end
