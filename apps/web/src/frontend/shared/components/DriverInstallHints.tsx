/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What to tell someone whose driver is missing, wherever they hit it: why it
 * does not load, the command to run by hand, Db2's extra steps, and who may
 * press Install. The credential form had all of this and the SQL editor's
 * banner had none of it; both render this now.
 */
import React from 'react';
import { IBM_DB_VERSION } from '@foxschema/ui-shared';
import type { DriverInfo } from '@/shared/lib/types';

export const DriverInstallHints: React.FC<{
  info: DriverInfo | null;
  /** The missing package, when known from `info` or the error that named it. */
  packageName: string;
  installing: boolean;
  installError: string;
  /** False without the Install drivers permission: say who can, and how. */
  canInstall: boolean;
}> = ({ info, packageName, installing, installError, canInstall }) => {
  if (installing) return null;
  const command = info?.installCommand ?? (packageName ? `npm install ${packageName}` : '');
  return (
    <>
      {installError ? (
        <p className="text-[11px] text-rose-300 break-words" data-testid="driver-install-error">
          {installError}
        </p>
      ) : null}
      {!canInstall ? (
        <p className="text-[11px] text-amber-200/80 leading-snug" data-testid="driver-install-needs-admin">
          Installing a driver runs npm on the server, so it needs an admin (the Install drivers
          permission).
          {command ? (
            <>
              {' '}
              Ask one, or run <span className="font-mono text-amber-100">{command}</span> where Fox
              Schema runs.
            </>
          ) : null}
        </p>
      ) : info?.error ? (
        <p className="text-[11px] text-amber-200/80 break-words font-mono leading-snug">
          {info.error.slice(0, 280)}
          {command ? (
            <>
              {' '}
              — run <span className="text-amber-100">{command}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {packageName === 'ibm_db' ? (
        <p className="text-[11px] text-amber-200/70 leading-snug">
          Db2 needs a native build + IBM clidriver download. Prefer{' '}
          <span className="text-amber-100 font-mono">foxschema drivers install db2</span>, then{' '}
          <span className="text-amber-100 font-mono">foxschema stop && foxschema</span>. In a
          monorepo:{' '}
          <span className="text-amber-100 font-mono">
            npm install ibm_db@{IBM_DB_VERSION} --foreground-scripts -w @foxschema/db
          </span>
          . On linux/arm64 use Docker (
          <span className="text-amber-100 font-mono">5nickels/foxschema:latest</span>).
        </p>
      ) : null}
    </>
  );
};
