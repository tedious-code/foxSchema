SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
// Explicit grid shape (alternative to returning objects).
return {
  columns: ['id', 'email', 'upper'],
  rows: last.rows.map((r) => [
    Number(r[0]),
    String(r[1]),
    String(r[1]).toUpperCase(),
  ]),
};
-- @end
