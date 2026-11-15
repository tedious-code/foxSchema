SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com'
UNION ALL
SELECT 3, 'cara@example.com';

-- @js
import _ from 'lodash';

function doubleRow(r) {
  return { id: r[0], email: r[1], n: Number(r[0]) * 2 };
}
return _.map(last.rows, doubleRow);
-- @end
