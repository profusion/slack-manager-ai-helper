import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortfolioManifest } from '../src/portfolio/load-portfolio.js';
import {
  notifyPortfolioAnalysisReport,
  type PortfolioCommandRunner,
} from '../src/portfolio/notify-portfolio.js';
import { planPortfolioDryRun } from '../src/portfolio/plan-portfolio.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('notifyPortfolioAnalysisReport', () => {
  it('invokes run-and-notify with markdown stdout config arguments and saved report stdout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-notify-'));
    tempDirs.push(dir);
    const archiveRepoPath = path.join(dir, 'archive');
    const reportRelativePath = 'reports/analysis/2026-06-08/target.md';
    await mkdir(path.dirname(path.join(archiveRepoPath, reportRelativePath)), { recursive: true });
    await writeFile(path.join(archiveRepoPath, reportRelativePath), '# Report\n', 'utf8');
    const manifest = createNotifyManifest();
    const task = analysisTask(manifest);
    const calls: { command: string; args: readonly string[] }[] = [];
    const runner: PortfolioCommandRunner = async (command, args) => {
      calls.push({
        command,
        args,
      });
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const result = await notifyPortfolioAnalysisReport({
      manifest,
      task,
      hasReportText: true,
      publication: {
        status: 'published',
        archiveRepoPath,
        reportPath: reportRelativePath,
      },
      commandRunner: runner,
    });

    expect(result).toEqual({
      status: 'delivered',
      exitCode: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toContain('run-and-notify');
    expect(calls[0]?.args).toEqual([
      '--locale=pt-BR',
      '--transports.smtp.enabled=true',
      '--transports.smtp.to=target@example.com',
      '--name=Target report',
      '--stdout.format=markdown',
      '--',
      'cat',
      path.join(archiveRepoPath, reportRelativePath),
    ]);
  });

  it('tracks failed notification command exit status', async () => {
    const manifest = createNotifyManifest();
    const result = await notifyPortfolioAnalysisReport({
      manifest,
      task: analysisTask(manifest),
      hasReportText: true,
      publication: {
        status: 'published',
        archiveRepoPath: '/tmp/archive',
        reportPath: 'reports/analysis/2026-06-08/target.md',
      },
      commandRunner: async () => ({ exitCode: 2, stdout: '', stderr: 'smtp failed' }),
    });

    expect(result).toEqual({
      status: 'failed',
      exitCode: 2,
      stderr: 'smtp failed',
    });
  });

  it('merges rollup-specific run-and-notify config', async () => {
    const manifest = createNotifyManifest();
    const calls: string[][] = [];

    await notifyPortfolioAnalysisReport({
      manifest,
      task: rollupTask(manifest),
      hasReportText: true,
      publication: {
        status: 'published',
        archiveRepoPath: '/tmp/archive',
        reportPath: 'reports/analysis/rollups/weekly/2026-06-08/target.md',
      },
      commandRunner: async (_command, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls[0]).toEqual([
      '--locale=pt-BR',
      '--transports.smtp.enabled=true',
      '--transports.smtp.to=target@example.com',
      '--name=Weekly rollup',
      '--stdout.format=markdown',
      '--',
      'cat',
      '/tmp/archive/reports/analysis/rollups/weekly/2026-06-08/target.md',
    ]);
  });

  it('sends the default no-report message when no report was published', async () => {
    const manifest = createNotifyManifest();
    const calls: string[][] = [];
    await expect(
      notifyPortfolioAnalysisReport({
        manifest,
        task: analysisTask(manifest),
        hasReportText: false,
        publication: { status: 'skipped', reason: 'no_report' },
        commandRunner: async (_command, args) => {
          calls.push([...args]);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    ).resolves.toEqual({
      status: 'delivered_empty_report',
      exitCode: 0,
    });
    expect(calls[0]?.slice(-4)).toEqual([
      '--',
      'printf',
      '%s\\n',
      'No daily reports found - Target',
    ]);
  });

  it('uses a target-level no-report message template', async () => {
    const manifest = createNotifyManifestWithEmptyReportMessage();
    const calls: string[][] = [];

    await notifyPortfolioAnalysisReport({
      manifest,
      task: analysisTask(manifest),
      hasReportText: false,
      publication: { status: 'skipped', reason: 'no_report' },
      commandRunner: async (_command, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls[0]?.at(-1)).toBe('Nothing for Target (target)');
  });

  it('does not send a no-report message when report publication is disabled', async () => {
    const manifest = createNotifyManifest();

    await expect(
      notifyPortfolioAnalysisReport({
        manifest,
        task: analysisTask(manifest),
        publication: undefined,
        hasReportText: true,
        commandRunner: async () => {
          throw new Error('notification should be skipped');
        },
      }),
    ).resolves.toEqual({ status: 'skipped', reason: 'not_published' });
  });
});

function analysisTask(manifest: PortfolioManifest) {
  const plan = planPortfolioDryRun({
    manifest,
    manifestPath: 'portfolio.json',
    manifestHash: 'hash',
    now: new Date('2026-06-08T21:00:00.000Z'),
    localTimeZone: 'America/Sao_Paulo',
  });
  const task = plan.tasks.find((candidate) => candidate.type === 'analysis');
  if (task?.type !== 'analysis') {
    throw new Error('Expected analysis task');
  }
  return task;
}

function rollupTask(manifest: PortfolioManifest) {
  const plan = planPortfolioDryRun({
    manifest,
    manifestPath: 'portfolio.json',
    manifestHash: 'hash',
    now: new Date('2026-06-08T21:00:00.000Z'),
    localTimeZone: 'America/Sao_Paulo',
  });
  const task = plan.tasks.find((candidate) => candidate.type === 'rollup');
  if (task?.type !== 'rollup') {
    throw new Error('Expected rollup task');
  }
  return task;
}

function createNotifyManifest(): PortfolioManifest {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        prompts: ['@DEFAULT_BASE_INSTRUCTIONS@'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
      },
      runAndNotifyConfig: {
        locale: 'pt-BR',
        transports: {
          smtp: {
            enabled: true,
            to: ['manager@example.com'],
          },
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
            runAndNotifyConfig: {
              name: 'Weekly rollup',
            },
          },
        ],
        targets: [
          {
            id: 'target',
            name: 'Target',
            status: 'active',
            analysisConfig: {
              channels: [{ id: 'C_TARGET' }],
            },
            runAndNotifyConfig: {
              name: 'Target report',
              transports: {
                smtp: {
                  to: ['target@example.com'],
                },
              },
            },
          },
        ],
      },
    ],
  };
}

function createNotifyManifestWithEmptyReportMessage(): PortfolioManifest {
  const manifest = createNotifyManifest();
  const [analysis] = manifest.analyses;
  const [target] = analysis?.targets ?? [];
  if (!analysis || !target) {
    throw new Error('Expected target');
  }
  return {
    ...manifest,
    analyses: [
      {
        ...analysis,
        targets: [
          {
            ...target,
            runAndNotifyConfig: {
              ...target.runAndNotifyConfig,
              emptyReportMessageTemplate: 'Nothing for {{target.name}} ({{target.id}})',
            },
          },
        ],
      },
    ],
  };
}
