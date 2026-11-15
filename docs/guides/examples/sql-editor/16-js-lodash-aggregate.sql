SELECT 'a' AS kind, 10 AS n
UNION ALL
SELECT 'a', 5
UNION ALL
SELECT 'b', 7
UNION ALL
SELECT 'b', 3;

-- @js
import { groupBy, sumBy } from 'lodash-es';

const rows = last.rows.map((r) => ({
  kind: String(r[0]),
  n: Number(r[1]),
}));
const byKind = groupBy(rows, 'kind');
return Object.keys(byKind).map((kind) => ({
  kind,
  count: byKind[kind].length,
  total: sumBy(byKind[kind], 'n'),
}));
-- @end
