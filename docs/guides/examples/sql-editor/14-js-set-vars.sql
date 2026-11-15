SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
-- @set people = table
return last.rows.map((r) => ({ id: Number(r[0]), email: r[1] }));
-- @end

-- @js
// Prefer vars.people after @set (last is the previous cell's grid too).
const grid = vars.people;
if (!grid) return [];
return grid.rows.map((r) => ({
  id: r[0],
  email: r[1],
  fromVars: true,
}));
-- @end
