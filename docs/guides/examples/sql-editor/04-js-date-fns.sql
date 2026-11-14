SELECT '2020-01-02' AS day
UNION ALL
SELECT '2021-06-15';

-- @js
import { format, parseISO } from 'date-fns';

return last.rows.map((r) => ({
  day: r[0],
  stamped: format(parseISO(String(r[0])), 'yyyy-MM-dd'),
}));
-- @end
