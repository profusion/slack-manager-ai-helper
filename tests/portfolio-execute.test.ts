import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executePortfolioAnalyses,
  resolvePortfolioTaskConfig,
} from '../src/portfolio/execute-portfolio.js';
import type { PortfolioManifest } from '../src/portfolio/load-portfolio.js';
import { planPortfolioDryRun } from '../src/portfolio/plan-portfolio.js';
import type { ResolvedConfig } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('executePortfolioAnalyses', () => {
  it('executes analysis tasks and skips later-phase task types', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-execute-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createExecutionManifest(dir);
    const resolvedConfigs: ResolvedConfig[] = [];
    const rollupRanges: unknown[] = [];

    const result = await executePortfolioAnalyses(
      {
        manifest,
        manifestPath,
        manifestHash: 'hash',
        now: new Date('2026-06-08T21:00:00.000Z'),
        localTimeZone: 'America/Sao_Paulo',
        notify: false,
        publish: false,
      },
      async (resolved, _generateText, options) => {
        resolvedConfigs.push(resolved);
        expect(options?.dateRange).toEqual({
          startDate: '2026-06-08',
          endDate: '2026-06-08',
        });
        return {
          runId: 'run-1',
          inputMessageCount: 3,
          matchedMessageCount: 2,
          evidenceMessageCount: 2,
          modelCalled: true,
          executionMode: 'explicit',
          scanStartCursor: '1000',
          scanEndCursor: '1234',
          reportText: 'Report markdown.',
        };
      },
      async (_resolved, options) => {
        rollupRanges.push(options.range);
        return createRollupResult();
      },
    );

    expect(result.summary).toEqual({
      completed: 3,
      skipped: 0,
      failed: 0,
    });
    expect(result.taskResults.map((task) => task.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(result.taskResults[1]).toMatchObject({
      type: 'rollup',
      rollupId: 'weekly',
      rollupResult: {
        modelCalled: true,
        hasReportText: true,
        sourceOutputCount: 1,
      },
    });
    expect(rollupRanges).toEqual([{ startDate: '2026-06-02', endDate: '2026-06-08' }]);
    expect(result.taskResults[2]).toMatchObject({
      type: 'maintenance',
      taskId: 'compact',
      status: 'completed',
      maintenanceKind: 'compact-state',
    });
    expect(resolvedConfigs[0]?.topicId).toBe('analysis-target');
    expect(resolvedConfigs[0]?.config.storage.statePath).toBe(
      path.join(dir, 'state/analysis/target.json'),
    );
  });

  it('resolves a portfolio task to the same config shape runOnce consumes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-resolve-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createExecutionManifest(dir);
    const plan = planPortfolioDryRun({
      manifest,
      manifestPath,
      manifestHash: 'hash',
      targetIds: ['target'],
      now: new Date('2026-06-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });
    const analysisTask = plan.tasks.find((task) => task.type === 'analysis');
    if (analysisTask?.type !== 'analysis') {
      throw new Error('Expected analysis task');
    }

    const resolved = await resolvePortfolioTaskConfig({
      manifest,
      manifestPath,
      task: analysisTask,
    });

    expect(resolved.topicId).toBe('analysis-target');
    expect(resolved.config.channels.map((channel) => channel.id)).toEqual(['C_TARGET']);
    expect(resolved.config.prompts).toEqual(['@DEFAULT_BASE_INSTRUCTIONS@']);
    expect(resolved.config.storage.slacrawlDatabasePath).toBe(path.join(dir, 'slacrawl.db'));
    expect(resolved.config.storage.statePath).toBe(path.join(dir, 'state/analysis/target.json'));
  });

  it('publishes analysis report markdown when publishing is enabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-publish-execute-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createExecutionManifest(dir);

    const result = await executePortfolioAnalyses(
      {
        manifest,
        manifestPath,
        manifestHash: 'hash',
        now: new Date('2026-06-08T21:00:00.000Z'),
        localTimeZone: 'America/Sao_Paulo',
        publish: true,
        notify: false,
      },
      async () => ({
        runId: 'run-1',
        inputMessageCount: 3,
        matchedMessageCount: 2,
        evidenceMessageCount: 2,
        modelCalled: true,
        executionMode: 'explicit',
        scanStartCursor: '1000',
        scanEndCursor: '1234',
        reportText: '# Published report',
      }),
      async () => createRollupResult(),
    );

    expect(result.taskResults[0]).toMatchObject({
      status: 'completed',
      statePath: path.join(dir, 'state/analysis/target.json'),
      publication: {
        status: 'published',
        reportPath: 'reports/analysis/2026-06-08/target.md',
      },
    });
    expect(result.git).toEqual({ status: 'disabled' });
    await expect(
      readFile(path.join(dir, 'archive/reports/analysis/2026-06-08/target.md'), 'utf8'),
    ).resolves.toBe('# Published report\n');
  });

  it('creates one git commit for reports, rollups, and state files reported by git status', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-aggregate-commit-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createExecutionManifest(dir, ['target']);
    const gitCalls: string[][] = [];
    const changedPaths = [
      'reports/analysis/2026-06-08/target.md',
      'reports/analysis/rollups/weekly/2026-06-02_to_2026-06-08/target.md',
      'state/analysis/target.json',
    ];

    const result = await executePortfolioAnalyses(
      {
        manifest: {
          ...manifest,
          defaults: {
            ...manifest.defaults,
            reports: {
              ...manifest.defaults?.reports,
              archiveRepoPath: '.',
              commit: {
                enabled: true,
                messageTemplate: 'portfolio: {{analysis.id}} {{period.key}}',
              },
            },
          },
        },
        manifestPath,
        manifestHash: 'hash',
        now: new Date('2026-06-08T21:00:00.000Z'),
        localTimeZone: 'America/Sao_Paulo',
        publish: true,
        notify: false,
      },
      async (resolved) => {
        await writePortfolioState(resolved);
        return createRunResult('run-1');
      },
      async () => createRollupResult(),
      async (_cwd, args) => {
        gitCalls.push([...args]);
        return args[0] === 'status'
          ? {
              // Status omits gitignored maintenance backups even when they are touched.
              stdout: changedPaths.map((filePath) => ` M ${filePath}`).join('\n'),
              stderr: '',
            }
          : { stdout: '', stderr: '' };
      },
    );

    const backupPath = result.taskResults.find(
      (task) => task.type === 'maintenance' && task.status === 'completed',
    )?.backupPath;
    expect(backupPath).toEqual(expect.stringContaining('state/analysis/target.json.'));
    expect(result.git).toEqual({
      status: 'committed',
      archiveRepoPath: dir,
      message: 'portfolio: analysis multiple',
      paths: changedPaths,
    });
    expect(gitCalls).toHaveLength(3);
    expect(gitCalls.map((args) => args[0])).toEqual(['status', 'add', 'commit']);
    expect(gitCalls[0]).toEqual(expect.arrayContaining([backupPath?.replace(`${dir}/`, '')]));
    expect(gitCalls[1]).toEqual(['add', '--', ...changedPaths]);
    expect(gitCalls[2]).toEqual([
      'commit',
      '-m',
      'portfolio: analysis multiple',
      '--',
      ...changedPaths,
    ]);
  });

  it('records failed analysis tasks and continues later tasks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-failure-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createExecutionManifest(dir);

    const result = await executePortfolioAnalyses(
      {
        manifest,
        manifestPath,
        manifestHash: 'hash',
        now: new Date('2026-06-08T21:00:00.000Z'),
        localTimeZone: 'America/Sao_Paulo',
        publish: false,
        notify: false,
      },
      async () => {
        throw new Error('analysis failed');
      },
      async () => createRollupResult(),
    );

    expect(result.summary).toEqual({
      completed: 2,
      skipped: 0,
      failed: 1,
    });
    expect(result.taskResults[0]).toMatchObject({
      status: 'failed',
      error: 'analysis failed',
    });
  });

  it('runs target lanes in parallel while preserving per-target task order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-parallel-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createExecutionManifest(dir, ['target', 'other']);
    const completedAnalyses = new Set<string>();
    const events: string[] = [];
    let activeAnalyses = 0;
    let maxActiveAnalyses = 0;

    const result = await executePortfolioAnalyses(
      {
        manifest,
        manifestPath,
        manifestHash: 'hash',
        now: new Date('2026-06-08T21:00:00.000Z'),
        localTimeZone: 'America/Sao_Paulo',
        publish: false,
        notify: false,
        concurrency: 2,
      },
      async (resolved) => {
        const targetId = path.basename(resolved.config.storage.statePath, '.json');
        events.push(`analysis:start:${targetId}`);
        activeAnalyses += 1;
        maxActiveAnalyses = Math.max(maxActiveAnalyses, activeAnalyses);
        await delay(10);
        activeAnalyses -= 1;
        completedAnalyses.add(targetId);
        events.push(`analysis:end:${targetId}`);
        return createRunResult(`run-${targetId}`);
      },
      async (resolved) => {
        const targetId = path.basename(resolved.config.storage.statePath, '.json');
        expect(completedAnalyses.has(targetId)).toBe(true);
        events.push(`rollup:start:${targetId}`);
        return createRollupResult();
      },
    );

    expect(result.summary).toEqual({
      completed: 6,
      skipped: 0,
      failed: 0,
    });
    expect(maxActiveAnalyses).toBe(2);
    expect(events.indexOf('analysis:end:target')).toBeLessThan(
      events.indexOf('rollup:start:target'),
    );
    expect(events.indexOf('analysis:end:other')).toBeLessThan(events.indexOf('rollup:start:other'));
    expect(result.taskResults.map((task) => task.targetId)).toEqual([
      'target',
      'target',
      'target',
      'other',
      'other',
      'other',
    ]);
  });
});

function createRunResult(runId: string) {
  return {
    runId,
    inputMessageCount: 3,
    matchedMessageCount: 2,
    evidenceMessageCount: 2,
    modelCalled: true,
    executionMode: 'explicit' as const,
    scanStartCursor: '1000',
    scanEndCursor: '1234',
    reportText: 'Report markdown.',
  };
}

function createRollupResult() {
  return {
    modelCalled: true as const,
    state: {
      topicId: 'analysis-target',
      generatedAt: '2026-06-08T21:00:00.000Z',
      range: {
        startDate: '2026-06-02',
        endDate: '2026-06-08',
      },
      sourceOutputs: [
        {
          date: '2026-06-06',
          runId: 'run-1',
          createdAt: '2026-06-06T21:00:00.000Z',
          reportText: 'Daily report.',
        },
      ],
    },
    reportText: '# Rollup report',
  };
}

async function writePortfolioState(resolved: ResolvedConfig): Promise<void> {
  await mkdir(path.dirname(resolved.config.storage.statePath), { recursive: true });
  await writeFile(
    resolved.config.storage.statePath,
    `${JSON.stringify(
      {
        version: 'v1',
        topicId: resolved.topicId,
        runs: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function createExecutionManifest(
  dir: string,
  targetIds: readonly string[] = ['target'],
): PortfolioManifest {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        storage: {
          slacrawlDatabasePath: path.join(dir, 'slacrawl.db'),
        },
        prompts: ['@DEFAULT_BASE_INSTRUCTIONS@'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
        context: {
          syntheticThreads: {
            enabled: false,
          },
        },
      },
      state: {
        pathTemplate: 'state/{{#with analysis}}{{id}}{{/with}}/{{target.id}}.json',
      },
      reports: {
        archiveRepoPath: 'archive',
        baseDir: 'reports',
        latestViews: true,
        commit: {
          enabled: false,
        },
      },
    },
    analyses: [
      {
        id: 'analysis',
        name: 'Analysis',
        runs: [
          {
            id: 'daily',
            schedule: { kind: 'daily' },
            window: { date: 'today' },
          },
        ],
        rollups: [
          {
            id: 'weekly',
            schedule: { kind: 'daily' },
            window: { name: 'previous-5-workdays' },
            prompt: 'weekly.md',
          },
        ],
        maintenance: [
          {
            id: 'compact',
            kind: 'compact-state',
            schedule: { kind: 'daily' },
            keepRuns: 10,
            backup: true,
          },
        ],
        targets: targetIds.map((targetId) => ({
          id: targetId,
          name: targetId === 'target' ? 'Target' : 'Other',
          status: 'active',
          analysisConfig: {
            channels: [{ id: `C_${targetId.toUpperCase()}` }],
          },
        })),
      },
    ],
  };
}
