/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/agentic-os.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowDef } from '@foxschema/workflow-engine';
import { extractPipeline } from './workflow-extract.js';
import {
  buildWorkflowPackage,
  importWorkflowPackage,
} from './workflow-package.js';
import { proposeWorkflow } from './workflow-propose.js';
import { buildRunFailureSummary } from './run-failure.js';

function sampleWorkflow(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id: 'parent-flow',
    name: 'Parent',
    purpose: 'Ingest orders and enrich them',
    tags: ['orders', 'enrich'],
    expectedResult: 'Enriched order records',
    version: 2,
    pipelines: [
      {
        id: 'enrich',
        name: 'Enrich',
        task: 'Call LLM to classify each order',
        pipes: [
          {
            id: 'src',
            role: 'source',
            type: 'source.triggerPayload',
            intent: 'Accept payload',
            config: {},
            concurrency: 1,
          },
          {
            id: 'ai',
            role: 'transform',
            type: 'transform.ai.generate',
            intent: 'Classify order',
            config: {
              prompt: 'Classify {{id}}',
              models: [{ provider: 'anthropic', model: 'claude-sonnet-5', priority: 0 }],
            },
            concurrency: 1,
            credentialId: 'cred-llm',
          },
        ],
        edges: [{ from: 'src', to: 'ai' }],
      },
    ],
    dependencies: [],
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
    onOverlap: 'skip',
    origin: 'authored',
    middleware: [],
    ...overrides,
  };
}

describe('extractPipeline', () => {
  it('promotes a pipeline and replaces it with a pinned workflow.sub', () => {
    const source = sampleWorkflow();
    const result = extractPipeline(source, {
      pipelineId: 'enrich',
      newWorkflowId: 'reuse-enrich',
      purpose: 'Reusable order classification',
      tags: ['ai'],
    });

    expect(result.extracted.id).toBe('reuse-enrich');
    expect(result.extracted.purpose).toBe('Reusable order classification');
    expect(result.extracted.triggers.some((t) => t.kind === 'parent')).toBe(
      true,
    );
    expect(result.extracted.pipelines[0]?.id).toBe('main');
    expect(result.extracted.pipelines[0]?.pipes).toHaveLength(2);

    const replacement = result.source.pipelines.find((p) => p.id === 'enrich');
    expect(replacement?.pipes.map((p) => p.type)).toEqual([
      'source.triggerPayload',
      'workflow.sub',
    ]);
    const sub = replacement?.pipes.find((p) => p.type === 'workflow.sub');
    expect(sub?.config).toMatchObject({
      workflowId: 'reuse-enrich',
      workflowVersion: 1,
    });
    expect(result.source.version).toBe(3);
  });
});

describe('workflow package', () => {
  it('exports credential kinds without secrets and remaps on import', () => {
    const workflow = sampleWorkflow();
    const pkg = buildWorkflowPackage(workflow, [
      { id: 'cred-llm', name: 'LLM', kind: 'llm', source: 'local', createdAt: '', updatedAt: '' },
    ]);
    expect(pkg.manifest.format).toBe('foxflow.workflow-package');
    expect(pkg.manifest.credentials).toEqual([
      { id: 'cred-llm', kind: 'llm', name: 'LLM' },
    ]);
    expect(pkg.manifest.purpose).toBe(workflow.purpose);

    const imported = importWorkflowPackage({
      package: pkg,
      workflowId: 'imported-flow',
      credentialMap: { 'cred-llm': 'local-llm' },
    });
    expect(imported.id).toBe('imported-flow');
    expect(imported.version).toBe(1);
    expect(imported.pipelines[0]?.pipes[1]?.credentialId).toBe('local-llm');
  });
});

describe('proposeWorkflow', () => {
  it('prefers callable catalog entries over inventing pipes', () => {
    const catalog: WorkflowDef[] = [
      {
        ...sampleWorkflow({
          id: 'login',
          purpose: 'Browser login to partner portal',
          tags: ['login', 'browser'],
        }),
        triggers: [
          { id: 'manual', kind: 'manual', enabled: true },
          { id: 'parent', kind: 'parent', enabled: true, allowFrom: [] },
        ],
      },
    ];
    const result = proposeWorkflow({
      purpose: 'login to partner portal then pull orders',
      id: 'orchestrate-orders',
      tags: ['login'],
      catalog,
    });
    expect(result.reused).toHaveLength(1);
    expect(result.reused[0]?.workflowId).toBe('login');
    expect(
      result.workflow.pipelines[0]?.pipes.some((p) => p.type === 'workflow.sub'),
    ).toBe(true);
    expect(result.notes[0]).toMatch(/reusable/i);
  });
});

describe('buildRunFailureSummary', () => {
  it('surfaces failed pipeline/pipe, gate skips, and AI failover', () => {
    const workflow = sampleWorkflow();
    const summary = buildRunFailureSummary({
      run: {
        id: 'run-1',
        workflowId: workflow.id,
        workflowVersion: 2,
        status: 'failed',
        trigger: 'manual',
        startedAt: '2026-01-01T00:00:00.000Z',
        error: 'pipe ai failed',
        instanceId: 'local',
      },
      workflow,
      pipelines: [
        {
          id: 'pr1',
          workflowRunId: 'run-1',
          pipelineId: 'enrich',
          status: 'failed',
          error: 'AI quota',
        },
        {
          id: 'pr2',
          workflowRunId: 'run-1',
          pipelineId: 'notify',
          status: 'skipped',
          error: 'gate false',
        },
      ],
      pipes: [
        {
          id: 'pp1',
          workflowRunId: 'run-1',
          pipelineId: 'enrich',
          pipeId: 'ai',
          status: 'failed',
          attempt: 1,
          processedBatches: 1,
          processedRecords: 1,
          error: 'rate limited',
        },
      ],
      events: [
        {
          seq: 1,
          workflowRunId: 'run-1',
          at: '2026-01-01T00:00:01.000Z',
          type: 'retry.attempt',
          pipeId: 'ai',
          data: {
            kind: 'ai.failover',
            from: 'anthropic:claude-opus-4-8',
            to: 'openai:gpt-4o-mini',
            reason: '429 rate limit',
            aiUsage: { inputTokens: 10, outputTokens: 0 },
          },
        },
      ],
    });

    expect(summary.workflowPurpose).toBe(workflow.purpose);
    expect(summary.failedPipeline?.task).toBe('Call LLM to classify each order');
    expect(summary.failedPipe?.intent).toBe('Classify order');
    expect(summary.gateSkipped).toEqual([
      { pipelineId: 'notify', error: 'gate false' },
    ]);
    expect(summary.aiFailovers[0]).toMatchObject({
      from: 'anthropic:claude-opus-4-8',
      to: 'openai:gpt-4o-mini',
    });
    expect(summary.aiUsage).toEqual({ inputTokens: 10, outputTokens: 0 });
  });
});
