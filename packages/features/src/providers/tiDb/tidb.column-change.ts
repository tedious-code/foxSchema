/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * TiDB takes MySQL's SQL but has no triggers, and cannot rename two columns
 * in one ALTER: the copy is run once more just before the switch-over, and
 * the switch is two RENAME statements.
 */
import { mysqlFamilyColumnChange } from '../mysql/mysql.column-change.js';

export const tiDbColumnChange = mysqlFamilyColumnChange({ triggers: false, atomicSwitch: false });
