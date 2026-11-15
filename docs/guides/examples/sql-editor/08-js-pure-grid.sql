-- @js
import { groupBy } from 'lodash-es';

const rows = [
  { kind: 'a', n: 1 },
  { kind: 'a', n: 2 },
  { kind: 'b', n: 3 },
];
const grouped = groupBy(rows, 'kind');
return [{ a: grouped.a.length, b: grouped.b.length }];
-- @end
