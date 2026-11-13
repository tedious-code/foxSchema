/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-package.ts).
 */
import type { CredentialMeta } from '@foxschema/workflow-engine';
import type { WorkflowDef } from '@foxschema/workflow-engine';

/**
 * Shareable workflow package (Agentic OS Phase D).
 *
 * The *manifest* carries no secret material: credentials appear as an id and a
 * kind, and variables as key names, so an importer can remap them against its
 * own store. The workflow itself travels verbatim, which is what makes the
 * package importable — and means anything the author typed directly into a
 * pipe config travels with it. A bearer token pasted into a header is part of
 * the workflow, not part of the credential store, and nothing here can tell it
 * apart from a legitimate constant.
 *
 * So rather than claim a guarantee it cannot keep, the package reports what it
 * found: `manifest.inlineSecretWarnings` lists config paths that look like
 * secrets, for a human to check before sharing. Detection is a heuristic and
 * an empty list is not a clean bill of health.
 */

export interface WorkflowPackageManifest {
  format: 'foxflow.workflow-package';
  formatVersion: 1;
  exportedAt: string;
  workflowId: string;
  workflowVersion: number;
  purpose?: string;
  tags: string[];
  expectedResult?: string;
  /** Credential ids referenced → kind (never secret material). */
  credentials: Array<{ id: string; kind: string; name?: string }>;
  /** Variable keys referenced via {{vars.*}} heuristics + workflow-scoped. */
  variableKeys: string[];
  /** Sub-workflow ids pinned from workflow.sub pipes. */
  subWorkflowIds: string[];
  /**
   * Config paths holding something that looks like an inline secret, for a
   * human to review before sharing. Heuristic: empty does not prove clean.
   * Omitted when nothing was flagged, so existing packages are unchanged.
   */
  inlineSecretWarnings?: InlineSecretWarning[];
}

export interface InlineSecretWarning {
  /** e.g. `pipelines[main].pipes[call].config.request.headers.Authorization` */
  path: string;
  /** Why it was flagged, in words a reader can act on. */
  reason: string;
}

export interface WorkflowPackage {
  manifest: WorkflowPackageManifest;
  workflow: WorkflowDef;
}

export function buildWorkflowPackage(
  workflow: WorkflowDef,
  credentials: CredentialMeta[] = [],
): WorkflowPackage {
  const credentialIds = new Set<string>();
  const variableKeys = new Set<string>();
  const subWorkflowIds = new Set<string>();

  collectFromWorkflow(workflow, credentialIds, variableKeys, subWorkflowIds);
  const inlineSecretWarnings = findInlineSecrets(workflow);

  const credById = new Map(credentials.map((c) => [c.id, c]));
  const credentialEntries = [...credentialIds].map((id) => {
    const meta = credById.get(id);
    return {
      id,
      kind: meta?.kind ?? 'unknown',
      ...(meta?.name ? { name: meta.name } : {}),
    };
  });

  return {
    manifest: {
      format: 'foxflow.workflow-package',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      ...(workflow.purpose ? { purpose: workflow.purpose } : {}),
      tags: workflow.tags ?? [],
      ...(workflow.expectedResult
        ? { expectedResult: workflow.expectedResult }
        : {}),
      credentials: credentialEntries,
      variableKeys: [...variableKeys].sort(),
      subWorkflowIds: [...subWorkflowIds].sort(),
      ...(inlineSecretWarnings.length > 0 ? { inlineSecretWarnings } : {}),
    },
    workflow,
  };
}

export interface ImportWorkflowPackageInput {
  package: WorkflowPackage;
  /** Remap credential ids from package → local store. */
  credentialMap?: Record<string, string>;
  /** Override workflow id on import. */
  workflowId?: string;
  /** Start at this version (default 1). */
  version?: number;
}

export function importWorkflowPackage(
  input: ImportWorkflowPackageInput,
): WorkflowDef {
  const pkg = input.package;
  if (pkg.manifest?.format !== 'foxflow.workflow-package') {
    throw new Error('invalid package: expected foxflow.workflow-package');
  }
  let workflow = structuredClone(pkg.workflow);
  if (input.workflowId) {
    workflow = { ...workflow, id: input.workflowId, name: input.workflowId };
  }
  workflow = {
    ...workflow,
    version: input.version ?? 1,
    // Overwritten, never read from the package. The file is written by whoever
    // is sharing it, so a package claiming `origin: 'authored'` is claiming a
    // trust level about itself — exactly the assertion an import must not take
    // at face value. This is the whole point of the field.
    origin: 'imported',
  };

  const map = input.credentialMap ?? {};
  if (Object.keys(map).length > 0) {
    workflow = {
      ...workflow,
      pipelines: workflow.pipelines.map((pipeline) => ({
        ...pipeline,
        pipes: pipeline.pipes.map((pipe) => {
          let next = pipe;
          if (pipe.credentialId && map[pipe.credentialId]) {
            next = { ...next, credentialId: map[pipe.credentialId] };
          }
          if (pipe.config && typeof pipe.config === 'object') {
            next = {
              ...next,
              config: remapConfigCredentials(
                pipe.config as Record<string, unknown>,
                map,
              ),
            };
          }
          return next;
        }),
      })),
    };
  }
  return workflow;
}

function remapConfigCredentials(
  config: Record<string, unknown>,
  map: Record<string, string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(next)) {
    if (
      (key === 'credentialId' || key.endsWith('CredentialId')) &&
      typeof value === 'string' &&
      map[value]
    ) {
      next[key] = map[value];
    } else if (Array.isArray(value)) {
      next[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? remapConfigCredentials(item as Record<string, unknown>, map)
          : item,
      );
    } else if (value && typeof value === 'object') {
      next[key] = remapConfigCredentials(
        value as Record<string, unknown>,
        map,
      );
    }
  }
  return next;
}

/** Field names that carry a secret often enough to be worth a second look. */
const SECRET_KEY = /pass(word|wd)?$|secret|token|api[-_]?key|^authorization$|private[-_]?key|access[-_]?key/i;

/** Query parameters that carry a secret in a URL. */
const SECRET_PARAM = /^(api[-_]?key|key|token|access[-_]?token|secret|password|sig|signature)$/i;

/**
 * A `{{vars.x}}` / `{{...}}` reference is the *recommended* shape — it names a
 * value rather than carrying one — so flagging it would train readers to
 * ignore the warnings.
 */
function isReference(value: string): boolean {
  return /\{\{[^}]+\}\}/.test(value.trim());
}

function inspectForSecrets(
  value: unknown,
  path: string,
  found: InlineSecretWarning[],
): void {
  if (typeof value === 'string') {
    // A URL can smuggle a key past a field-name check: the field is `url`.
    if (/^https?:\/\//i.test(value) && value.includes('?')) {
      const query = value.slice(value.indexOf('?') + 1);
      for (const pair of query.split('&')) {
        const [rawKey, rawValue = ''] = pair.split('=');
        if (
          rawKey &&
          SECRET_PARAM.test(decodeURIComponent(rawKey)) &&
          rawValue &&
          !isReference(decodeURIComponent(rawValue))
        ) {
          found.push({
            path: `${path} (query "${decodeURIComponent(rawKey)}")`,
            reason: 'URL carries a literal value in a credential-shaped query parameter',
          });
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectForSecrets(item, `${path}[${index}]`, found),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      // Credential *references* are the safe pattern this format is built on.
      const isCredentialRef =
        key === 'credentialId' || key.endsWith('CredentialId');
      if (
        !isCredentialRef &&
        SECRET_KEY.test(key) &&
        typeof child === 'string' &&
        child.trim() !== '' &&
        !isReference(child)
      ) {
        found.push({
          path: childPath,
          reason: `"${key}" holds a literal value rather than a credential or {{vars.*}} reference`,
        });
      }
      inspectForSecrets(child, childPath, found);
    }
  }
}

/** Walk every pipe config looking for values that should not be shared. */
export function findInlineSecrets(workflow: WorkflowDef): InlineSecretWarning[] {
  const found: InlineSecretWarning[] = [];
  for (const pipeline of workflow.pipelines) {
    for (const pipe of pipeline.pipes) {
      inspectForSecrets(
        pipe.config,
        `pipelines[${pipeline.id}].pipes[${pipe.id}].config`,
        found,
      );
    }
  }
  return found;
}

function collectFromWorkflow(
  workflow: WorkflowDef,
  credentialIds: Set<string>,
  variableKeys: Set<string>,
  subWorkflowIds: Set<string>,
): void {
  for (const pipeline of workflow.pipelines) {
    for (const pipe of pipeline.pipes) {
      if (pipe.credentialId) credentialIds.add(pipe.credentialId);
      scanValue(pipe.config, credentialIds, variableKeys, subWorkflowIds);
      if (pipe.type === 'workflow.sub') {
        const id = pipe.config.workflowId;
        if (typeof id === 'string' && id) subWorkflowIds.add(id);
      }
    }
  }
  for (const trigger of workflow.triggers) {
    if (
      'credentialId' in trigger &&
      typeof trigger.credentialId === 'string'
    ) {
      credentialIds.add(trigger.credentialId);
    }
  }
}

function scanValue(
  value: unknown,
  credentialIds: Set<string>,
  variableKeys: Set<string>,
  subWorkflowIds: Set<string>,
): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{\s*vars\.([\w.-]+)\s*\}\}/g)) {
      if (match[1]) variableKeys.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanValue(item, credentialIds, variableKeys, subWorkflowIds);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === 'credentialId' || key.endsWith('CredentialId')) &&
        typeof child === 'string'
      ) {
        credentialIds.add(child);
      }
      if (key === 'workflowId' && typeof child === 'string') {
        subWorkflowIds.add(child);
      }
      scanValue(child, credentialIds, variableKeys, subWorkflowIds);
    }
  }
}
