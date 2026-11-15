SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
function isOdd(n) {
  return n % 2 === 1;
}
const out = [];
let i = 0;
while (i < last.rows.length) {
  const id = Number(last.rows[i][0]);
  if (isOdd(id)) {
    out.push({ id, email: last.rows[i][1], kind: 'odd' });
  }
  i++;
}
return out;
-- @end
