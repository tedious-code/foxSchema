SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
-- @set step1 = table
return last.rows.map((r) => ({ id: Number(r[0]), email: r[1] }));
-- @end

-- @js
// Use last from the previous cell (and/or vars.step1 after @set).
const rows = last && last.rows.length ? last.rows : (vars.step1 ? vars.step1.rows : []);
return rows.map((r) => ({
  id: r[0],
  email: r[1],
  domain: String(r[1]).split('@')[1] || '',
}));
-- @end
