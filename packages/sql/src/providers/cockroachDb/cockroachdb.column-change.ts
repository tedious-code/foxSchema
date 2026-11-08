/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * CockroachDB takes PostgreSQL's DDL. Triggers only arrived in recent
 * versions, so the plan does not rely on one: the copy is run once more just
 * before the switch-over instead.
 */
import { postgresFamilyColumnChange } from '../postgres/postgres.column-change.js';

export const cockroachDbColumnChange = postgresFamilyColumnChange({
  triggers: false,
  // Widening a string or an int is allowed as is; any other conversion needs this.
  alterTypeSetting: 'SET enable_experimental_alter_column_type_general = true;',
  alterTypeNote:
    'Lengthening a string or widening an int is a metadata change. Any other change rewrites the column in the ' +
    'background, which CockroachDB refuses for a column that is part of an index (drop the index first) and inside ' +
    'an explicit transaction. A value that does not convert stops it.',
});
