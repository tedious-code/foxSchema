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

export const cockroachDbColumnChange = postgresFamilyColumnChange({ triggers: false });
