import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortfolioManifest } from '../src/portfolio/load-portfolio.js';
import { planPortfolioDryRun } from '../src/portfolio/plan-portfolio.js';
import {
  commitPortfolioPaths,
  normalizeReportsConfig,
  publishPortfolioAnalysisReport,
  publishPortfolioRollupReport,
} from '../src/portfolio/publish-portfolio.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('publishPortfolioAnalysisReport', () => {
  it('writes immutable reports, latest views, and indexes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-publish-'));
    tempDirs.push(dir);
    const archiveRepoPath = path.join(dir, 'archive');
    await mkdir(archiveRepoPath, { recursive: true });
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = createPublishManifest(archiveRepoPath, true);
    const task = analysisTask(manifest, manifestPath);

    const result = await publishPortfolioAnalysisReport({
      manifest,
      manifestPath,
      task,
      reportText: '# Report\n\nBody.',
      localTimeZone: 'America/Sao_Paulo',
      now: new Date('2026-06-08T21:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'published',
      reportPath: 'reports/analysis/2026-06-08/target.md',
      latestPaths: [
        'reports/analysis/latest/target.md',
        'reports/analysis/targets/target/latest.md',
        'reports/analysis/latest/index.md',
        'reports/analysis/targets/target/index.md',
      ],
      writtenPaths: [
        'reports/analysis/2026-06-08/target.md',
        'reports/analysis/latest/target.md',
        'reports/analysis/targets/target/latest.md',
        'reports/analysis/latest/index.md',
        'reports/analysis/targets/target/index.md',
      ],
    });
    await expect(
      readFile(path.join(archiveRepoPath, 'reports/analysis/2026-06-08/target.md'), 'utf8'),
    ).resolves.toBe('# Report\n\nBody.\n');
    await expect(
      readFile(path.join(archiveRepoPath, 'reports/analysis/latest/index.md'), 'utf8'),
    ).resolves.toContain('[Target](target.md)');
    await expect(
      readFile(path.join(archiveRepoPath, 'reports/analysis/targets/target/index.md'), 'utf8'),
    ).resolves.toContain('[2026-06-08](./../../2026-06-08/target.md)');
  });

  it('skips latest views for historical windows unless updateLatest is set', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-historical-'));
    tempDirs.push(dir);
    const archiveRepoPath = path.join(dir, 'archive');
    await mkdir(archiveRepoPath, { recursive: true });
    const manifest = createPublishManifest(archiveRepoPath, false);
    const manifestPath = path.join(dir, 'portfolio.json');
    const task = analysisTask(manifest, manifestPath);

    const result = await publishPortfolioAnalysisReport({
      manifest,
      manifestPath,
      task,
      reportText: '# Historical report',
      localTimeZone: 'America/Sao_Paulo',
      now: new Date('2026-06-09T21:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'published',
      reportPath: 'reports/analysis/2026-06-08/target.md',
      latestPaths: [],
      writtenPaths: ['reports/analysis/2026-06-08/target.md'],
    });
  });

  it('writes rollup reports with rollup-specific templates', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-rollup-publish-'));
    tempDirs.push(dir);
    const archiveRepoPath = path.join(dir, 'archive');
    await mkdir(archiveRepoPath, { recursive: true });
    const manifest = createPublishManifest(archiveRepoPath, false);
    const manifestPath = path.join(dir, 'portfolio.json');
    const task = rollupTask(manifest, manifestPath);

    const result = await publishPortfolioRollupReport({
      manifest,
      manifestPath,
      task,
      reportText: '# Weekly rollup',
      localTimeZone: 'America/Sao_Paulo',
      now: new Date('2026-06-08T21:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'published',
      reportPath: 'reports/analysis/rollups/weekly/2026-06-02_to_2026-06-08/target.md',
      latestPaths: ['reports/analysis/rollups/weekly/latest/target.md'],
      writtenPaths: [
        'reports/analysis/rollups/weekly/2026-06-02_to_2026-06-08/target.md',
        'reports/analysis/rollups/weekly/latest/target.md',
      ],
    });
    await expect(
      readFile(
        path.join(
          archiveRepoPath,
          'reports/analysis/rollups/weekly/2026-06-02_to_2026-06-08/target.md',
        ),
        'utf8',
      ),
    ).resolves.toBe('# Weekly rollup\n');
  });
});

describe('commitPortfolioPaths', () => {
  it('commits all changed paths in one git commit', async () => {
    const archiveRepoPath = '/tmp/archive';
    const config = normalizeReportsConfig({
      archiveRepoPath,
      commit: {
        enabled: true,
        messageTemplate: 'reports: {{analysis.id}} {{period.key}} {{target.id}}',
      },
    });
    const gitCalls: string[][] = [];

    const result = await commitPortfolioPaths({
      archiveRepoPath,
      config,
      context: {
        analysis: { id: 'analysis' },
        period: { key: '2026-06-08' },
        target: { id: 'multiple' },
      },
      paths: ['reports/a.md', 'state/a.json', 'reports/a.md'],
      gitRunner: async (_cwd, args) => {
        gitCalls.push([...args]);
        return args[0] === 'status'
          ? { stdout: ' M reports/a.md\n M state/a.json\n', stderr: '' }
          : { stdout: '', stderr: '' };
      },
    });

    expect(result).toEqual({
      status: 'committed',
      archiveRepoPath,
      message: 'reports: analysis 2026-06-08 multiple',
      paths: ['reports/a.md', 'state/a.json'],
    });
    expect(gitCalls).toEqual([
      ['status', '--porcelain', '--', 'reports/a.md', 'state/a.json'],
      ['add', '--', 'reports/a.md', 'state/a.json'],
      [
        'commit',
        '-m',
        'reports: analysis 2026-06-08 multiple',
        '--',
        'reports/a.md',
        'state/a.json',
      ],
    ]);
  });

  it('skips gitignored paths that status omits so add does not abort the commit', async () => {
    const archiveRepoPath = '/tmp/archive';
    const config = normalizeReportsConfig({
      archiveRepoPath,
      commit: {
        enabled: true,
        messageTemplate: 'reports: publish {{period.key}}',
      },
    });
    const gitCalls: string[][] = [];

    const result = await commitPortfolioPaths({
      archiveRepoPath,
      config,
      context: {
        period: { key: '2026-07-03' },
      },
      paths: ['reports/a.md', 'state/a.json', 'state/a.json.2026-07-04T02-35-16-384Z.bak'],
      gitRunner: async (_cwd, args) => {
        gitCalls.push([...args]);
        // git status omits ignored *.bak paths even when they are listed as pathspecs
        return args[0] === 'status'
          ? { stdout: ' M reports/a.md\n M state/a.json\n', stderr: '' }
          : { stdout: '', stderr: '' };
      },
    });

    expect(result).toEqual({
      status: 'committed',
      archiveRepoPath,
      message: 'reports: publish 2026-07-03',
      paths: ['reports/a.md', 'state/a.json'],
    });
    expect(gitCalls).toEqual([
      [
        'status',
        '--porcelain',
        '--',
        'reports/a.md',
        'state/a.json',
        'state/a.json.2026-07-04T02-35-16-384Z.bak',
      ],
      ['add', '--', 'reports/a.md', 'state/a.json'],
      ['commit', '-m', 'reports: publish 2026-07-03', '--', 'reports/a.md', 'state/a.json'],
    ]);
  });

  it('does not commit when git reports no changed paths', async () => {
    const archiveRepoPath = '/tmp/archive';
    const config = normalizeReportsConfig({
      archiveRepoPath,
      commit: {
        enabled: true,
      },
    });
    const gitCalls: string[][] = [];

    const result = await commitPortfolioPaths({
      archiveRepoPath,
      config,
      context: {},
      paths: ['reports/a.md'],
      gitRunner: async (_cwd, args) => {
        gitCalls.push([...args]);
        return { stdout: '', stderr: '' };
      },
    });

    expect(result).toEqual({
      status: 'no_changes',
      archiveRepoPath,
      paths: ['reports/a.md'],
    });
    expect(gitCalls.map((args) => args[0])).toEqual(['status']);
  });
});

function analysisTask(manifest: PortfolioManifest, manifestPath: string) {
  const plan = planPortfolioDryRun({
    manifest,
    manifestPath,
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

function rollupTask(manifest: PortfolioManifest, manifestPath: string) {
  const plan = planPortfolioDryRun({
    manifest,
    manifestPath,
    manifestHash: 'hash',
    window: 'previous-5-workdays',
    now: new Date('2026-06-08T21:00:00.000Z'),
    localTimeZone: 'America/Sao_Paulo',
  });
  const task = plan.tasks.find((candidate) => candidate.type === 'rollup');
  if (task?.type !== 'rollup') {
    throw new Error('Expected rollup task');
  }
  return task;
}

function createPublishManifest(archiveRepoPath: string, commitEnabled: boolean): PortfolioManifest {
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
      reports: {
        archiveRepoPath,
        baseDir: 'reports',
        latestViews: true,
        templates: {
          analysisReportPath:
            '{{reports.baseDir}}/{{#with analysis}}{{id}}{{/with}}/{{period.key}}/{{target.id}}.md',
        },
        commit: {
          enabled: commitEnabled,
          messageTemplate: 'reports: {{analysis.id}} {{period.key}} {{target.id}}',
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
        targets: [
          {
            id: 'target',
            name: 'Target',
            status: 'active',
            analysisConfig: {
              channels: [{ id: 'C_TARGET' }],
            },
          },
        ],
      },
    ],
  };
}
