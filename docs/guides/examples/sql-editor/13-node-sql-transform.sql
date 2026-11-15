SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @node
import _ from 'lodash';

return _.map(last.rows, (r) => ({
  id: Number(r[0]),
  email: String(r[1]),
  domain: String(r[1]).split('@')[1] || '',
  runtime: 'node',
}));
-- @end
