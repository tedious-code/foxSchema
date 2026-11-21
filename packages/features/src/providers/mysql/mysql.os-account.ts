/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { OsAccountDialect, OsAccountContext, OsAccountSteps } from '../../modules/access/os-account.types.js';
import { asLinuxName, createLoginSteps, notApplicable, rootPrefix } from '../../modules/access/os-account-helpers.js';

export const mysqlOsAccount: OsAccountDialect = {
  id: 'mysql',
  steps(ctx: OsAccountContext): OsAccountSteps {
    const linux = asLinuxName(ctx.name);
    if (!linux) {
      return notApplicable(
        `"${ctx.name}" is not a usable Linux login name, so auth_socket cannot match it. The account still works with a password.`
      );
    }
    const prefix = rootPrefix(ctx);
    if (typeof prefix !== 'string') return notApplicable(prefix.error);

    return {
      applicable: true,
      rationale:
        'Only needed for the auth_socket plugin, which Debian and Ubuntu use for local connections. It authenticates by matching the OS user to the account name, so `CREATE USER … IDENTIFIED WITH auth_socket` needs an OS login of the same name. An account with a password does not.',
      statements: [
        ...createLoginSteps(prefix, linux),
        {
          sql: `${prefix}bash -lc "mysql -N -e \\"SELECT plugin_name, plugin_status FROM information_schema.plugins WHERE plugin_name IN ('auth_socket','unix_socket')\\""`,
          explanation:
            'Confirms the plugin is loaded. Nothing empty here means socket authentication is unavailable and the account needs a password instead.',
          risk: 'low',
        },
        {
          sql: `${prefix}bash -lc "mysql -N -e \\"SELECT user, host, plugin FROM mysql.user WHERE user = '${linux}'\\""`,
          explanation: `Shows how ${linux} authenticates. A plugin of auth_socket or unix_socket is what makes the OS account matter.`,
          risk: 'low',
        },
      ],
    };
  },
};
