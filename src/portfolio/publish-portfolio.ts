import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import Handlebars from 'handlebars';
import { type DateRange, localDateForDate } from '../date-range.js';
import { resolveFromConfig } from '../utils/paths.js';
import {
  type JsonObject,
  materializeReportsConfig,
  type PortfolioAnalysis,
  type PortfolioManifest,
  type PortfolioTarget,
} from './load-portfolio.js';
import type { PlannedPortfolioTask } from './plan-portfolio.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TEMPLATES = {
  analysisReportPath: '{{reports.baseDir}}/{{analysis.id}}/{{period.key}}/{{target.id}}.md',
  analysisLatestIndexPath: '{{reports.baseDir}}/{{analysis.id}}/latest/index.md',
  analysisLatestReportPath: '{{reports.baseDir}}/{{analysis.id}}/latest/{{target.id}}.md',
  targetLatestReportPath: '{{reports.baseDir}}/{{analysis.id}}/targets/{{target.id}}/latest.md',
  targetIndexPath: '{{reports.baseDir}}/{{analysis.id}}/targets/{{target.id}}/index.md',
  rollupReportPath:
    '{{reports.baseDir}}/{{analysis.id}}/rollups/{{rollup.id}}/{{period.key}}/{{target.id}}.md',
  rollupLatestReportPath:
    '{{reports.baseDir}}/{{analysis.id}}/rollups/{{rollup.id}}/latest/{{target.id}}.md',
} as const;

export type PortfolioGitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type PortfolioAnalysisReportPublication = {
  readonly status: 'published' | 'skipped';
  readonly reason?: 'no_report' | 'latest_not_updated' | undefined;
  readonly archiveRepoPath?: string | undefined;
  readonly reportPath?: string | undefined;
  readonly latestPaths?: readonly string[] | undefined;
  readonly writtenPaths?: readonly string[] | undefined;
};

export type PortfolioRollupReportPublication = PortfolioAnalysisReportPublication;

export type PortfolioGitCommitResult =
  | {
      readonly status: 'disabled';
    }
  | {
      readonly status: 'no_changes';
      readonly archiveRepoPath: string;
      readonly paths: readonly string[];
    }
  | {
      readonly status: 'committed';
      readonly archiveRepoPath: string;
      readonly message: string;
      readonly paths: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly archiveRepoPath?: string | undefined;
      readonly error: string;
      readonly paths: readonly string[];
    };

export type ReportsConfig = {
  readonly archiveRepoPath: string;
  readonly baseDir: string;
  readonly latestViews: boolean;
  readonly templates: typeof DEFAULT_TEMPLATES;
  readonly commit: {
    readonly enabled: boolean;
    readonly messageTemplate: string;
  };
};

type PublishContext = {
  readonly reports: {
    readonly baseDir: string;
  };
  readonly analysis: {
    readonly id: string;
    readonly name: string;
  };
  readonly target: {
    readonly id: string;
    readonly name: string;
    readonly status: PortfolioTarget['status'];
  };
  readonly run: {
    readonly id: string;
  };
  readonly rollup?:
    | {
        readonly id: string;
      }
    | undefined;
  readonly period: {
    readonly key: string;
    readonly startDate?: string | undefined;
    readonly endDate?: string | undefined;
  };
  readonly report: {
    readonly path?: string | undefined;
  };
  readonly startedAt: string;
};

export async function publishPortfolioAnalysisReport(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'analysis' }>;
  readonly reportText: string | undefined;
  readonly updateLatest?: boolean | undefined;
  readonly now?: Date | undefined;
  readonly localTimeZone: string;
}): Promise<PortfolioAnalysisReportPublication> {
  if (input.reportText === undefined) {
    return {
      status: 'skipped',
      reason: 'no_report',
    };
  }

  const analysis = findById(input.manifest.analyses, input.task.analysisId, 'analysis');
  const target = findById(analysis.targets, input.task.targetId, 'target');
  const reports = materializeReportsConfig({
    manifest: input.manifest,
    analysisId: analysis.id,
  });
  const config = normalizeReportsConfig(reports);
  const archiveRepoPath = resolveFromConfig(input.manifestPath, config.archiveRepoPath);
  const startedAt = (input.now ?? new Date()).toISOString();
  const context = publishContext({
    reports: config,
    analysis,
    target,
    task: input.task,
    reportPath: undefined,
    startedAt,
  });
  const reportPath = renderReportPath({
    archiveRepoPath,
    template: config.templates.analysisReportPath,
    context,
  });
  const contextWithReport = {
    ...context,
    report: {
      path: reportPath.relativePath,
    },
  };
  const writtenPaths: string[] = [];

  await writeMarkdownFile(reportPath.absolutePath, input.reportText);
  writtenPaths.push(reportPath.relativePath);

  const latestPaths: string[] = [];
  if (config.latestViews && shouldUpdateLatest(input.task.window, input)) {
    const latestReportPath = renderReportPath({
      archiveRepoPath,
      template: config.templates.analysisLatestReportPath,
      context: contextWithReport,
    });
    const targetLatestPath = renderReportPath({
      archiveRepoPath,
      template: config.templates.targetLatestReportPath,
      context: contextWithReport,
    });
    await writeMarkdownFile(latestReportPath.absolutePath, input.reportText);
    await writeMarkdownFile(targetLatestPath.absolutePath, input.reportText);
    writtenPaths.push(latestReportPath.relativePath, targetLatestPath.relativePath);
    latestPaths.push(latestReportPath.relativePath, targetLatestPath.relativePath);

    const latestIndexPath = renderReportPath({
      archiveRepoPath,
      template: config.templates.analysisLatestIndexPath,
      context: contextWithReport,
    });
    await writeLatestIndex({
      latestIndexPath,
      analysis,
      targets: analysis.targets,
    });
    writtenPaths.push(latestIndexPath.relativePath);
    latestPaths.push(latestIndexPath.relativePath);

    const targetIndexPath = renderReportPath({
      archiveRepoPath,
      template: config.templates.targetIndexPath,
      context: contextWithReport,
    });
    await writeTargetIndex({
      targetIndexPath,
      analysis,
      target,
      reportRelativePath: reportPath.relativePath,
      targetLatestRelativePath: targetLatestPath.relativePath,
      periodKey: context.period.key,
    });
    writtenPaths.push(targetIndexPath.relativePath);
    latestPaths.push(targetIndexPath.relativePath);
  }

  return {
    status: 'published',
    archiveRepoPath,
    reportPath: reportPath.relativePath,
    latestPaths,
    writtenPaths,
  };
}

export async function publishPortfolioRollupReport(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'rollup' }>;
  readonly reportText: string | undefined;
  readonly updateLatest?: boolean | undefined;
  readonly now?: Date | undefined;
  readonly localTimeZone: string;
}): Promise<PortfolioRollupReportPublication> {
  if (input.reportText === undefined) {
    return {
      status: 'skipped',
      reason: 'no_report',
    };
  }

  const analysis = findById(input.manifest.analyses, input.task.analysisId, 'analysis');
  const target = findById(analysis.targets, input.task.targetId, 'target');
  const reports = materializeReportsConfig({
    manifest: input.manifest,
    analysisId: analysis.id,
  });
  const config = normalizeReportsConfig(reports);
  const archiveRepoPath = resolveFromConfig(input.manifestPath, config.archiveRepoPath);
  const context = publishContext({
    reports: config,
    analysis,
    target,
    task: input.task,
    reportPath: undefined,
    startedAt: (input.now ?? new Date()).toISOString(),
  });
  const reportPath = renderReportPath({
    archiveRepoPath,
    template: config.templates.rollupReportPath,
    context,
  });
  const contextWithReport = {
    ...context,
    report: {
      path: reportPath.relativePath,
    },
  };
  const writtenPaths: string[] = [];

  await writeMarkdownFile(reportPath.absolutePath, input.reportText);
  writtenPaths.push(reportPath.relativePath);

  const latestPaths: string[] = [];
  if (config.latestViews && shouldUpdateLatest(input.task.window, input)) {
    const latestPath = renderReportPath({
      archiveRepoPath,
      template: config.templates.rollupLatestReportPath,
      context: contextWithReport,
    });
    await writeMarkdownFile(latestPath.absolutePath, input.reportText);
    writtenPaths.push(latestPath.relativePath);
    latestPaths.push(latestPath.relativePath);
  }

  return {
    status: 'published',
    archiveRepoPath,
    reportPath: reportPath.relativePath,
    latestPaths,
    writtenPaths,
  };
}

export function normalizeReportsConfig(raw: JsonObject): ReportsConfig {
  const { archiveRepoPath, baseDir, latestViews, templates: rawTemplates, commit: rawCommit } = raw;

  if (typeof archiveRepoPath !== 'string') {
    throw new Error('Portfolio report publishing requires reports.archiveRepoPath');
  }

  const commit = isObject(rawCommit) ? rawCommit : {};
  const { enabled, messageTemplate } = commit;

  return {
    archiveRepoPath,
    baseDir: typeof baseDir === 'string' ? baseDir : 'reports',
    latestViews: latestViews !== false,
    templates: {
      ...DEFAULT_TEMPLATES,
      ...(isObject(rawTemplates) ? stringValues(rawTemplates) : {}),
    },
    commit: {
      enabled: enabled === true,
      messageTemplate:
        typeof messageTemplate === 'string'
          ? messageTemplate
          : 'reports: publish {{analysis.id}} {{period.key}}',
    },
  };
}

function publishContext(input: {
  readonly reports: ReportsConfig;
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'analysis' | 'rollup' }>;
  readonly reportPath: string | undefined;
  readonly startedAt: string;
}): PublishContext {
  const period = periodFields(input.task.window);
  return {
    reports: {
      baseDir: input.reports.baseDir,
    },
    analysis: {
      id: input.analysis.id,
      name: input.analysis.name,
    },
    target: {
      id: input.target.id,
      name: input.target.name,
      status: input.target.status,
    },
    run: {
      id: input.task.type === 'analysis' ? input.task.runId : input.task.rollupId,
    },
    ...(input.task.type === 'rollup' ? { rollup: { id: input.task.rollupId } } : {}),
    period,
    report: {
      path: input.reportPath,
    },
    startedAt: input.startedAt,
  };
}

function periodFields(window: DateRange): PublishContext['period'] {
  const key =
    window.startDate && window.endDate && window.startDate !== window.endDate
      ? `${window.startDate}_to_${window.endDate}`
      : (window.startDate ?? window.endDate ?? localDateForDate(new Date(), 'UTC'));
  return {
    key,
    ...(window.startDate !== undefined ? { startDate: window.startDate } : {}),
    ...(window.endDate !== undefined ? { endDate: window.endDate } : {}),
  };
}

function shouldUpdateLatest(
  window: DateRange,
  input: {
    readonly updateLatest?: boolean | undefined;
    readonly now?: Date | undefined;
    readonly localTimeZone: string;
  },
): boolean {
  if (input.updateLatest === true) {
    return true;
  }

  const today = localDateForDate(input.now ?? new Date(), input.localTimeZone);
  return (window.endDate ?? window.startDate) === today;
}

function renderReportPath(input: {
  readonly archiveRepoPath: string;
  readonly template: string;
  readonly context: PublishContext;
}): { readonly absolutePath: string; readonly relativePath: string } {
  const rendered = Handlebars.compile(input.template, { noEscape: true })(input.context);
  if (path.isAbsolute(rendered)) {
    throw new Error(`Portfolio report template rendered an absolute path: ${rendered}`);
  }

  const normalized = path.normalize(rendered);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Portfolio report template escaped the archive repo: ${rendered}`);
  }

  return {
    absolutePath: path.join(input.archiveRepoPath, normalized),
    relativePath: normalized,
  };
}

async function writeMarkdownFile(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

async function writeLatestIndex(input: {
  readonly latestIndexPath: { readonly absolutePath: string; readonly relativePath: string };
  readonly analysis: PortfolioAnalysis;
  readonly targets: readonly PortfolioTarget[];
}): Promise<void> {
  await mkdir(path.dirname(input.latestIndexPath.absolutePath), { recursive: true });
  const files = await readdir(path.dirname(input.latestIndexPath.absolutePath)).catch(() => []);
  const targetNames = new Map(input.targets.map((target) => [target.id, target.name]));
  const entries = files
    .filter(
      (file) => file.endsWith('.md') && file !== path.basename(input.latestIndexPath.absolutePath),
    )
    .toSorted()
    .map((file) => {
      const targetId = path.basename(file, '.md');
      return `- [${targetNames.get(targetId) ?? targetId}](${file})`;
    });
  const body = [`# Latest ${input.analysis.name}`, '', ...entries, ''].join('\n');
  await writeFile(input.latestIndexPath.absolutePath, body, 'utf8');
}

async function writeTargetIndex(input: {
  readonly targetIndexPath: { readonly absolutePath: string; readonly relativePath: string };
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
  readonly reportRelativePath: string;
  readonly targetLatestRelativePath: string;
  readonly periodKey: string;
}): Promise<void> {
  const indexDir = path.dirname(input.targetIndexPath.relativePath);
  const latestLink = path.relative(indexDir, input.targetLatestRelativePath);
  const reportLink = path.relative(indexDir, input.reportRelativePath);
  const body = [
    `# ${input.target.name}`,
    '',
    `Analysis: ${input.analysis.name}`,
    '',
    `- [Latest](./${latestLink})`,
    `- [${input.periodKey}](./${reportLink})`,
    '',
  ].join('\n');
  await writeMarkdownFile(input.targetIndexPath.absolutePath, body);
}

export async function commitPortfolioPaths(input: {
  readonly archiveRepoPath: string;
  readonly config: ReportsConfig;
  readonly context: JsonObject;
  readonly paths: readonly string[];
  readonly gitRunner: PortfolioGitRunner;
}): Promise<PortfolioGitCommitResult> {
  if (!input.config.commit.enabled) {
    return { status: 'disabled' };
  }

  const uniquePaths = [...new Set(input.paths)].toSorted();
  if (uniquePaths.length === 0) {
    return {
      status: 'no_changes',
      archiveRepoPath: input.archiveRepoPath,
      paths: [],
    };
  }

  const status = await input.gitRunner(input.archiveRepoPath, [
    'status',
    '--porcelain',
    '--',
    ...uniquePaths,
  ]);
  // Only stage/commit paths git reports as changed. Ignored paths (for example
  // maintenance `*.bak` files) are omitted from porcelain status; including them
  // in `git add` fails after staging other files and leaves the commit uncreated.
  const changedPaths = pathsFromPorcelainStatus(status.stdout);
  if (changedPaths.length === 0) {
    return {
      status: 'no_changes',
      archiveRepoPath: input.archiveRepoPath,
      paths: uniquePaths,
    };
  }

  await input.gitRunner(input.archiveRepoPath, ['add', '--', ...changedPaths]);
  const message = Handlebars.compile(input.config.commit.messageTemplate, { noEscape: true })(
    input.context,
  );
  await input.gitRunner(input.archiveRepoPath, ['commit', '-m', message, '--', ...changedPaths]);
  return {
    status: 'committed',
    archiveRepoPath: input.archiveRepoPath,
    message,
    paths: changedPaths,
  };
}

export function pathsFromPorcelainStatus(stdout: string): readonly string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const pathPart = line.slice(3);
    if (pathPart === '') {
      continue;
    }
    const renameSeparator = ' -> ';
    const renameIndex = pathPart.lastIndexOf(renameSeparator);
    const rawPath =
      (line.startsWith('R') || line.startsWith('C')) && renameIndex !== -1
        ? pathPart.slice(renameIndex + renameSeparator.length)
        : pathPart;
    paths.push(unquotePorcelainPath(rawPath));
  }
  return [...new Set(paths)].toSorted();
}

function unquotePorcelainPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }

  return value
    .slice(1, -1)
    .replaceAll('\\\\', '\u0000')
    .replaceAll('\\t', '\t')
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\u0000', '\\');
}

export async function defaultGitRunner(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function stringValues(input: JsonObject): Partial<typeof DEFAULT_TEMPLATES> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      output[key] = value;
    }
  }
  return output as Partial<typeof DEFAULT_TEMPLATES>;
}

function isObject(input: unknown): input is JsonObject {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function findById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string,
  label: string,
): T {
  const value = values.find((item) => item.id === id);
  if (!value) {
    throw new Error(`Unknown ${label}: ${id}`);
  }
  return value;
}
