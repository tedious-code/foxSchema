/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type on CockroachDB: PostgreSQL's steps, with the setting a general
 * column type change needs, and outside a transaction, where it must run.
 */
import { postgresFamilyTypeDrop } from '../postgres/postgres.type-drop.js';

export const cockroachDbTypeDrop = postgresFamilyTypeDrop({
  alterTypeSetting: 'SET enable_experimental_alter_column_type_general = true;',
  transactional: false,
});
