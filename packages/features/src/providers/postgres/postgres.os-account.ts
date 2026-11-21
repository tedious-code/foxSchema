/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { OsAccountDialect, OsAccountContext, OsAccountSteps } from '../../modules/access/os-account.types.js';
import { asLinuxName, asUserPrefix, createLoginSteps, notApplicable, rootPrefix } from '../../modules/access/os-account-helpers.js';

export const postgresOsAccount: OsAccountDialect = {
  id: 'postgres',
  steps(ctx: OsAccountContext): OsAccountSteps {
    const linux = asLinuxName(ctx.name);
    if (!linux) {
      return notApplicable(
        `"${ctx.name}" is not a usable Linux login name, so peer authentication cannot match it. The role still works over TCP with a password.`
      );
    }
    const prefix = rootPrefix(ctx);
    if (typeof prefix !== 'string') return notApplicable(prefix.error);
    const asUser = asUserPrefix(ctx, linux);
    if (typeof asUser !== 'string') return notApplicable(asUser.error);

    return {
      applicable: true,
      rationale:
        'Only needed for local socket connections. Debian and Ubuntu ship pg_hba.conf with `peer` for local, which authenticates by matching the OS user to the role name — so a role connecting that way needs an OS login of the same name. A role that connects over TCP with a password does not.',
      statements: [
        ...createLoginSteps(prefix, linux),
        {
          sql: `${prefix}bash -lc "grep -nE '^(local|host)' /etc/postgresql/*/main/pg_hba.conf 2>/dev/null || grep -nE '^(local|host)' /var/lib/postgresql/data/pg_hba.conf"`,
          explanation:
            'Shows how connections are authenticated. A `peer` or `ident` line is what makes the OS account matter; `scram-sha-256`, `md5` or `trust` do not consult it.',
          risk: 'low',
        },
        {
          sql: `${asUser}psql -c "SELECT current_user, inet_client_addr() IS NULL AS over_socket"`,
          explanation: `Connects as ${linux} over the local socket. current_user comes back as the role peer matched, and over_socket is true when no TCP address was used.`,
          risk: 'low',
        },
      ],
    };
  },
};
