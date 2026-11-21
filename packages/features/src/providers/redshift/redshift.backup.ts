/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redshift backup and restore: cluster snapshots, through the AWS CLI.
 *
 * pg_dump does not support Redshift, and there is no file to write: AWS keeps
 * snapshots. The cluster identifier is the first label of the endpoint
 * (`mycluster.abc123.us-east-1.redshift.amazonaws.com`); anything else gets a
 * placeholder to fill in.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { shellArg } from '../../modules/utilities/backup-helpers.js';

/** Snapshot identifiers: lowercase letters, digits and hyphens, starting with a letter. */
function snapshotId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z]+/, '').replace(/-$/, '');
  return id || 'fox-backup';
}

function clusterOf(host: string | null | undefined): { cluster: string; region: string | null } {
  const m = /^([a-z][a-z0-9-]*)\.[^.]+\.([a-z0-9-]+)\.redshift\.amazonaws\.com$/i.exec((host ?? '').trim());
  return m ? { cluster: m[1]!.toLowerCase(), region: m[2]!.toLowerCase() } : { cluster: '<cluster-id>', region: null };
}

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const { cluster, region } = clusterOf(conn.host);
  const snapshot = snapshotId(req.fileName);
  const regionArg = region ? ` --region ${region}` : '';
  return {
    language: 'shell',
    backup: `aws redshift create-cluster-snapshot --cluster-identifier ${shellArg(cluster)} --snapshot-identifier ${snapshot}${regionArg}`,
    restore: `aws redshift restore-from-cluster-snapshot --cluster-identifier ${shellArg(`${cluster}-restored`)} --snapshot-identifier ${snapshot}${regionArg}`,
    location: snapshot,
    notes: [
      'A snapshot covers the whole cluster, every database in it.',
      `The restore creates a new cluster, ${cluster}-restored; the original keeps running.`,
      ...(cluster === '<cluster-id>' ? ['The cluster identifier could not be read from the host; replace <cluster-id>.'] : []),
    ],
  };
}

export const redshiftBackup: BackupDialect = {
  tool: 'AWS CLI (cluster snapshot)',
  runsOn: 'cloud',
  folder: null,
  formats: [{ id: 'snapshot', label: 'Cluster snapshot', hint: 'Kept by AWS; restores as a new cluster.' }],
  scopes: ['full'],
  compression: false,
  tables: false,
  schemaLimit: false,
  passwordNote: 'Uses your AWS CLI credentials (aws configure), not the database password.',
  build,
};
