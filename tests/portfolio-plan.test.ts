import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPortfolioCommand } from '../src/commands/run-portfolio.js';
import { loadPortfolioManifest, type PortfolioManifest } from '../src/portfolio/load-portfolio.js';
import { planPortfolioDryRun } from '../src/portfolio/plan-portfolio.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planPortfolioDryRun', () => {
  it('plans active targets by default and skips archived targets', async () => {
    const { manifest, manifestHash, manifestPath } = await loadPortfolioManifest(
      'examples/portfolio-plan-reviews.json',
    );

    const plan = planPortfolioDryRun({
      manifest,
      manifestPath,
      manifestHash,
      now: new Date('2026-06-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });

    expect(plan.tasks.filter((task) => task.type === 'analysis')).toHaveLength(4);
    expect(plan.tasks.filter((task) => task.type === 'rollup')).toHaveLength(4);
    expect(plan.tasks.filter((task) => task.type === 'maintenance')).toHaveLength(4);
    expect(plan.tasks.map((task) => task.targetId)).not.toContain('legacy-project');
    expect(plan.skippedTargets).toContainEqual({
      analysisId: 'plan-reviews',
      targetId: 'legacy-project',
      targetName: 'Legacy Project',
      status: 'archived',
      reason: 'archived',
    });
  });

  it('allows explicitly selected paused targets and requires includeArchived for archived targets', () => {
    const manifest = createManifestWithLifecycleTargets();
    const base = {
      manifest,
      manifestPath: 'portfolio.json',
      manifestHash: 'hash',
      now: new Date('2026-06-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    };

    expect(
      planPortfolioDryRun({
        ...base,
        targetIds: ['paused'],
      }).tasks.map((task) => task.targetId),
    ).toEqual(['paused']);
    expect(
      planPortfolioDryRun({
        ...base,
        targetIds: ['archived'],
      }).tasks,
    ).toHaveLength(0);
    expect(
      planPortfolioDryRun({
        ...base,
        targetIds: ['archived'],
        includeArchived: true,
      }).tasks.map((task) => task.targetId),
    ).toEqual(['archived']);
  });

  it('filters due tasks by local schedule day and time', () => {
    const manifest = createDueManifest();

    const mondayPlan = planPortfolioDryRun({
      manifest,
      manifestPath: 'portfolio.json',
      manifestHash: 'hash',
      due: true,
      now: new Date('2026-06-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });
    expect(
      mondayPlan.tasks.map(
        (task) => `${task.type}:${task.type === 'analysis' ? task.runId : task.type}`,
      ),
    ).toEqual(['analysis:daily', 'analysis:workday']);

    const fridayPlan = planPortfolioDryRun({
      manifest,
      manifestPath: 'portfolio.json',
      manifestHash: 'hash',
      due: true,
      now: new Date('2026-06-12T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });
    expect(fridayPlan.tasks.map((task) => task.type)).toEqual(['analysis', 'analysis', 'rollup']);
  });

  it('filters tasks by schedule when --date is provided without --due', () => {
    const manifest = createDueManifest();

    const tuesdayPlan = planPortfolioDryRun({
      manifest,
      manifestPath: 'portfolio.json',
      manifestHash: 'hash',
      date: '2026-07-07',
      now: new Date('2026-07-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });
    expect(
      tuesdayPlan.tasks.map((task) =>
        task.type === 'analysis'
          ? `analysis:${task.runId}`
          : task.type === 'rollup'
            ? `rollup:${task.rollupId}`
            : task.type,
      ),
    ).toEqual(['analysis:daily', 'analysis:workday', 'analysis:late']);
    expect(
      tuesdayPlan.tasks.some((task) => task.type === 'rollup' && task.rollupId === 'weekly'),
    ).toBe(false);

    const fridayPlan = planPortfolioDryRun({
      manifest,
      manifestPath: 'portfolio.json',
      manifestHash: 'hash',
      date: '2026-06-12',
      now: new Date('2026-07-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });
    expect(
      fridayPlan.tasks.map((task) =>
        task.type === 'analysis'
          ? `analysis:${task.runId}`
          : task.type === 'rollup'
            ? `rollup:${task.rollupId}`
            : task.type,
      ),
    ).toEqual(['analysis:daily', 'analysis:workday', 'analysis:late', 'rollup:weekly']);
  });

  it('uses CLI date windows as an override for manifest task windows', async () => {
    const { manifest, manifestHash, manifestPath } = await loadPortfolioManifest(
      'examples/portfolio-plan-reviews.json',
    );

    const plan = planPortfolioDryRun({
      manifest,
      manifestPath,
      manifestHash,
      analysisIds: ['plan-reviews'],
      targetIds: ['project-alpha'],
      window: 'previous-5-workdays',
      now: new Date('2026-06-08T21:00:00.000Z'),
      localTimeZone: 'America/Sao_Paulo',
    });

    expect(plan.tasks.map((task) => ('window' in task ? task.window : undefined))).toEqual([
      { startDate: '2026-06-02', endDate: '2026-06-08' },
      { startDate: '2026-06-02', endDate: '2026-06-08' },
      undefined,
    ]);
  });
});

describe('runPortfolioCommand', () => {
  it('prints a dry-run JSON execution plan', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runPortfolioCommand.handler({
      manifest: 'examples/portfolio-plan-reviews.json',
      dryRun: true,
      analysis: ['plan-reviews'],
      target: ['project-alpha'],
      due: false,
      notify: true,
      publish: true,
      updateLatest: false,
      concurrency: 3,
      includePaused: false,
      includeArchived: false,
      $0: 'slack-manager-ai-helper',
      _: ['run-portfolio'],
    });

    const plan = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly mode: string;
      readonly selection: {
        readonly concurrency: number;
      };
      readonly tasks: readonly { readonly targetId: string }[];
    };
    expect(plan.mode).toBe('dry-run');
    expect(plan.selection.concurrency).toBe(3);
    expect(plan.tasks.every((task) => task.targetId === 'project-alpha')).toBe(true);
  });
});

function createManifestWithLifecycleTargets(): PortfolioManifest {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        prompts: ['base.md'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
      },
    },
    analyses: [
      {
        id: 'analysis',
        name: 'Analysis',
        runs: [
          {
            id: 'run',
            schedule: { kind: 'daily' },
            window: { date: 'today' },
          },
        ],
        targets: [
          {
            id: 'paused',
            name: 'Paused',
            status: 'paused',
            analysisConfig: { channels: [{ id: 'C_PAUSED' }] },
          },
          {
            id: 'archived',
            name: 'Archived',
            status: 'archived',
            endedOn: '2026-06-01',
            analysisConfig: { channels: [{ id: 'C_ARCHIVED' }] },
          },
        ],
      },
    ],
  };
}

function createDueManifest(): PortfolioManifest {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        prompts: ['base.md'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
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
            schedule: { kind: 'daily', time: '18:00' },
            window: { date: 'today' },
          },
          {
            id: 'workday',
            schedule: { kind: 'workdays', time: '18:00' },
            window: { date: 'today' },
          },
          {
            id: 'late',
            schedule: { kind: 'daily', time: '23:00' },
            window: { date: 'today' },
          },
          {
            id: 'manual',
            schedule: { kind: 'manual' },
            window: { date: 'today' },
          },
        ],
        rollups: [
          {
            id: 'weekly',
            schedule: { kind: 'weekdays', weekdays: ['friday'], time: '18:00' },
            window: { name: 'previous-5-workdays' },
            prompt: 'weekly.md',
          },
        ],
        targets: [
          {
            id: 'target',
            name: 'Target',
            status: 'active',
            analysisConfig: { channels: [{ id: 'C_TARGET' }] },
          },
        ],
      },
    ],
  };
}
