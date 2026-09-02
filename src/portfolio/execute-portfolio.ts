import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { resolveConfigPaths } from '../config/load-config.js';
import { type DateRange, localDateForDate } from '../date-range.js';
import { type RunOnceResult, runOnce } from '../run-once.js';
import { type CompactStateSummary, compactState, openStateStore } from '../state/state-store.js';
import type { ResolvedConfig } from '../types.js';
import { type UnifiedReportResult, unifiedReport } from '../unified-report.js';
import { hashJson } from '../utils/json.js';
import { resolveFromConfig } from '../utils/paths.js';
import {
  type JsonObject,
  materializeAnalysisConfig,
  materializeReportsConfig,
  materializeStateConfig,
  type PortfolioAnalysis,
  type PortfolioManifest,
  type PortfolioTarget,
} from './load-portfolio.js';
import {
  notifyPortfolioAnalysisReport,
  type PortfolioNotificationResult,
} from './notify-portfolio.js';
import {
  normalizePortfolioConcurrency,
  type PlannedPortfolioTask,
  type PortfolioExecutionPlan,
  type PortfolioPlanOptions,
  planPortfolioDryRun,
} from './plan-portfolio.js';
import {
  commitPortfolioPaths,
  defaultGitRunner,
  normalizeReportsConfig,
  type PortfolioAnalysisReportPublication,
  type PortfolioGitCommitResult,
  type PortfolioGitRunner,
  type PortfolioRollupReportPublication,
  publishPortfolioAnalysisReport,
  publishPortfolioRollupReport,
} from './publish-portfolio.js';

export type RunPortfolioAnalysisOnce = (
  resolved: ResolvedConfig,
  generateTextOverride?: Parameters<typeof runOnce>[1],
  options?: Parameters<typeof runOnce>[2],
) => Promise<RunOnceResult>;

export type RunPortfolioRollupOnce = (
  resolved: ResolvedConfig,
  options: Parameters<typeof unifiedReport>[1],
  generateTextOverride?: Parameters<typeof unifiedReport>[2],
) => Promise<UnifiedReportResult>;

export type PortfolioExecutionResult = {
  readonly plan: PortfolioExecutionPlan;
  readonly taskResults: readonly PortfolioTaskExecutionResult[];
  readonly git: PortfolioGitCommitResult;
  readonly summary: {
    readonly completed: number;
    readonly skipped: number;
    readonly failed: number;
  };
};

export type PortfolioTaskExecutionResult =
  | {
      readonly type: 'analysis';
      readonly analysisId: string;
      readonly targetId: string;
      readonly runId: string;
      readonly status: 'completed';
      readonly runResult: Omit<RunOnceResult, 'reportText'> & {
        readonly hasReportText: boolean;
      };
      readonly statePath: string;
      readonly publication?: PortfolioAnalysisReportPublication | undefined;
      readonly notification?: PortfolioNotificationResult | undefined;
    }
  | {
      readonly type: 'rollup';
      readonly analysisId: string;
      readonly targetId: string;
      readonly rollupId: string;
      readonly status: 'completed';
      readonly rollupResult: {
        readonly modelCalled: boolean;
        readonly hasReportText: boolean;
        readonly sourceOutputCount: number;
      };
      readonly publication?: PortfolioRollupReportPublication | undefined;
      readonly notification?: PortfolioNotificationResult | undefined;
    }
  | {
      readonly type: 'rollup';
      readonly analysisId: string;
      readonly targetId: string;
      readonly rollupId: string;
      readonly status: 'failed';
      readonly error: string;
    }
  | {
      readonly type: 'analysis';
      readonly analysisId: string;
      readonly targetId: string;
      readonly runId: string;
      readonly status: 'failed';
      readonly error: string;
      readonly statePath?: string | undefined;
    }
  | {
      readonly type: 'maintenance';
      readonly analysisId: string;
      readonly targetId: string;
      readonly taskId: string;
      readonly status: 'completed';
      readonly maintenanceKind: 'compact-state';
      readonly statePath: string;
      readonly backupPath: string | null;
      readonly result: CompactStateSummary;
    }
  | {
      readonly type: 'maintenance';
      readonly analysisId: string;
      readonly targetId: string;
      readonly taskId: string;
      readonly status: 'failed';
      readonly error: string;
    };

export async function executePortfolioAnalyses(
  options: PortfolioPlanOptions,
  runAnalysisOnce: RunPortfolioAnalysisOnce = runOnce,
  runRollupOnce: RunPortfolioRollupOnce = unifiedReport,
  gitRunner: PortfolioGitRunner = defaultGitRunner,
): Promise<PortfolioExecutionResult> {
  const plan = planPortfolioDryRun(options);
  const taskResults = await executeTaskLanes({
    options,
    plan,
    concurrency: normalizePortfolioConcurrency(options.concurrency),
    runAnalysisOnce,
    runRollupOnce,
  });
  const git = await commitExecutionChanges({
    options,
    plan,
    taskResults,
    gitRunner,
  });

  return {
    plan,
    taskResults,
    git,
    summary: summarizeResults(taskResults),
  };
}

type PlannedPortfolioTaskEntry = {
  readonly index: number;
  readonly task: PlannedPortfolioTask;
};

type PortfolioTaskExecutionResultEntry = {
  readonly index: number;
  readonly result: PortfolioTaskExecutionResult;
};

async function executeTaskLanes(input: {
  readonly options: PortfolioPlanOptions;
  readonly plan: PortfolioExecutionPlan;
  readonly concurrency: number;
  readonly runAnalysisOnce: RunPortfolioAnalysisOnce;
  readonly runRollupOnce: RunPortfolioRollupOnce;
}): Promise<readonly PortfolioTaskExecutionResult[]> {
  const lanes = groupTaskLanes(input.plan.tasks);
  const laneResults = await mapWithConcurrency(lanes, input.concurrency, async (lane) => {
    const results: PortfolioTaskExecutionResultEntry[] = [];
    for (const entry of lane) {
      results.push({
        index: entry.index,
        result: await executePlannedTask({
          options: input.options,
          plan: input.plan,
          task: entry.task,
          runAnalysisOnce: input.runAnalysisOnce,
          runRollupOnce: input.runRollupOnce,
        }),
      });
    }
    return results;
  });

  return laneResults
    .flat()
    .toSorted((left, right) => left.index - right.index)
    .map((entry) => entry.result);
}

function groupTaskLanes(
  tasks: readonly PlannedPortfolioTask[],
): readonly (readonly PlannedPortfolioTaskEntry[])[] {
  const lanes = new Map<string, PlannedPortfolioTaskEntry[]>();
  tasks.forEach((task, index) => {
    const key = `${task.analysisId}\0${task.targetId}`;
    const lane = lanes.get(key);
    if (lane) {
      lane.push({ index, task });
      return;
    }
    lanes.set(key, [{ index, task }]);
  });
  return [...lanes.values()];
}

async function executePlannedTask(input: {
  readonly options: PortfolioPlanOptions;
  readonly plan: PortfolioExecutionPlan;
  readonly task: PlannedPortfolioTask;
  readonly runAnalysisOnce: RunPortfolioAnalysisOnce;
  readonly runRollupOnce: RunPortfolioRollupOnce;
}): Promise<PortfolioTaskExecutionResult> {
  if (input.task.type === 'maintenance') {
    return executeMaintenanceTask({ options: input.options, task: input.task });
  }

  if (input.task.type === 'analysis') {
    return executeAnalysisTask({
      options: input.options,
      plan: input.plan,
      task: input.task,
      runAnalysisOnce: input.runAnalysisOnce,
    });
  }

  return executeRollupTask({
    options: input.options,
    plan: input.plan,
    task: input.task,
    runRollupOnce: input.runRollupOnce,
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results: Array<R | undefined> = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await mapper(item, index);
        }
      }
    }),
  );

  return results.filter((result): result is R => result !== undefined);
}

async function executeMaintenanceTask(input: {
  readonly options: PortfolioPlanOptions;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'maintenance' }>;
}): Promise<PortfolioTaskExecutionResult> {
  const { options, task } = input;
  try {
    const resolved = await resolvePortfolioTargetConfig({
      manifest: options.manifest,
      manifestPath: options.manifestPath,
      task,
    });
    const store = openStateStore(resolved.config.storage.statePath, resolved.topicId);
    const backupPath = task.backup === false ? null : createStateBackup(store.statePath);
    const result = compactState(store, { keepRuns: task.keepRuns ?? 30 });
    return {
      type: 'maintenance',
      analysisId: task.analysisId,
      targetId: task.targetId,
      taskId: task.maintenanceId,
      status: 'completed',
      maintenanceKind: task.maintenanceKind,
      statePath: store.statePath,
      backupPath,
      result: result.summary,
    };
  } catch (error) {
    return {
      type: 'maintenance',
      analysisId: task.analysisId,
      targetId: task.targetId,
      taskId: task.maintenanceId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeRollupTask(input: {
  readonly options: PortfolioPlanOptions;
  readonly plan: PortfolioExecutionPlan;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'rollup' }>;
  readonly runRollupOnce: RunPortfolioRollupOnce;
}): Promise<PortfolioTaskExecutionResult> {
  const { options, plan, task, runRollupOnce } = input;
  try {
    const resolved = await resolvePortfolioTargetConfig({
      manifest: options.manifest,
      manifestPath: options.manifestPath,
      task,
    });
    const result = await runRollupOnce(resolved, {
      promptPath: resolveFromConfig(options.manifestPath, task.prompt),
      range: task.window,
    });
    const publication =
      options.publish !== false
        ? await publishPortfolioRollupReport({
            manifest: options.manifest,
            manifestPath: options.manifestPath,
            task,
            reportText: result.modelCalled ? result.reportText : undefined,
            updateLatest: options.updateLatest,
            now: options.now,
            localTimeZone: plan.localTimeZone,
          })
        : undefined;
    const notification =
      options.notify !== false
        ? await notifyPortfolioAnalysisReport({
            manifest: options.manifest,
            task,
            publication,
            hasReportText: result.modelCalled && result.reportText !== undefined,
          })
        : undefined;

    return {
      type: 'rollup',
      analysisId: task.analysisId,
      targetId: task.targetId,
      rollupId: task.rollupId,
      status: 'completed',
      rollupResult: {
        modelCalled: result.modelCalled,
        hasReportText: result.modelCalled && result.reportText !== undefined,
        sourceOutputCount: result.state.sourceOutputs.length,
      },
      ...(publication !== undefined ? { publication } : {}),
      ...(notification !== undefined ? { notification } : {}),
    };
  } catch (error) {
    return {
      type: 'rollup',
      analysisId: task.analysisId,
      targetId: task.targetId,
      rollupId: task.rollupId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeAnalysisTask(input: {
  readonly options: PortfolioPlanOptions;
  readonly plan: PortfolioExecutionPlan;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'analysis' }>;
  readonly runAnalysisOnce: RunPortfolioAnalysisOnce;
}): Promise<PortfolioTaskExecutionResult> {
  const { options, plan, task, runAnalysisOnce } = input;
  let statePath: string | undefined;
  try {
    const resolved = await resolvePortfolioTaskConfig({
      manifest: options.manifest,
      manifestPath: options.manifestPath,
      task,
    });
    statePath = resolved.config.storage.statePath;
    const result = await runAnalysisOnce(resolved, undefined, {
      dateRange: task.window,
    });
    const publication =
      options.publish !== false
        ? await publishPortfolioAnalysisReport({
            manifest: options.manifest,
            manifestPath: options.manifestPath,
            task,
            reportText: result.reportText,
            updateLatest: options.updateLatest,
            now: options.now,
            localTimeZone: plan.localTimeZone,
          })
        : undefined;
    const notification =
      options.notify !== false
        ? await notifyPortfolioAnalysisReport({
            manifest: options.manifest,
            task,
            publication,
            hasReportText: result.reportText !== undefined,
          })
        : undefined;

    return {
      type: 'analysis',
      analysisId: task.analysisId,
      targetId: task.targetId,
      runId: task.runId,
      status: 'completed',
      statePath,
      runResult: {
        runId: result.runId,
        inputMessageCount: result.inputMessageCount,
        matchedMessageCount: result.matchedMessageCount,
        evidenceMessageCount: result.evidenceMessageCount,
        modelCalled: result.modelCalled,
        executionMode: result.executionMode,
        scanStartCursor: result.scanStartCursor,
        scanEndCursor: result.scanEndCursor,
        hasReportText: result.reportText !== undefined,
      },
      ...(publication !== undefined ? { publication } : {}),
      ...(notification !== undefined ? { notification } : {}),
    };
  } catch (error) {
    return {
      type: 'analysis',
      analysisId: task.analysisId,
      targetId: task.targetId,
      runId: task.runId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      ...(statePath !== undefined ? { statePath } : {}),
    };
  }
}

async function commitExecutionChanges(input: {
  readonly options: PortfolioPlanOptions;
  readonly plan: PortfolioExecutionPlan;
  readonly taskResults: readonly PortfolioTaskExecutionResult[];
  readonly gitRunner: PortfolioGitRunner;
}): Promise<PortfolioGitCommitResult> {
  const settings = executionCommitSettings(input.options, input.plan);
  if (settings === undefined) {
    return { status: 'disabled' };
  }

  const paths = touchedCommitPaths({
    archiveRepoPath: settings.archiveRepoPath,
    taskResults: input.taskResults,
  });
  try {
    return await commitPortfolioPaths({
      archiveRepoPath: settings.archiveRepoPath,
      config: settings.config,
      context: executionCommitContext(input.plan, input.taskResults, settings.config),
      paths,
      gitRunner: input.gitRunner,
    });
  } catch (error) {
    return {
      status: 'failed',
      archiveRepoPath: settings.archiveRepoPath,
      error: error instanceof Error ? error.message : String(error),
      paths,
    };
  }
}

function executionCommitSettings(
  options: PortfolioPlanOptions,
  plan: PortfolioExecutionPlan,
):
  | {
      readonly archiveRepoPath: string;
      readonly config: ReturnType<typeof normalizeReportsConfig>;
    }
  | undefined {
  let settings:
    | {
        readonly archiveRepoPath: string;
        readonly config: ReturnType<typeof normalizeReportsConfig>;
      }
    | undefined;

  for (const analysisId of new Set(plan.tasks.map((task) => task.analysisId))) {
    const reports = materializeReportsConfig({
      manifest: options.manifest,
      analysisId,
    });
    if (!isCommitEnabled(reports)) {
      continue;
    }
    const config = normalizeReportsConfig(reports);

    const archiveRepoPath = resolveFromConfig(options.manifestPath, config.archiveRepoPath);
    if (settings !== undefined && settings.archiveRepoPath !== archiveRepoPath) {
      throw new Error(
        `run-portfolio can only create one git commit per execution, but selected analyses use multiple report archive repos: ${settings.archiveRepoPath} and ${archiveRepoPath}`,
      );
    }
    settings = { archiveRepoPath, config };
  }

  return settings;
}

function isCommitEnabled(reports: JsonObject): boolean {
  const { commit } = reports as { readonly commit?: unknown };
  return (
    typeof commit === 'object' &&
    commit !== null &&
    !Array.isArray(commit) &&
    (commit as { readonly enabled?: unknown }).enabled === true
  );
}

function touchedCommitPaths(input: {
  readonly archiveRepoPath: string;
  readonly taskResults: readonly PortfolioTaskExecutionResult[];
}): readonly string[] {
  return [
    ...new Set(
      input.taskResults.flatMap((result) => [
        ...publishedReportCommitPaths(result, input.archiveRepoPath),
        ...stateCommitPaths(result, input.archiveRepoPath),
      ]),
    ),
  ].toSorted();
}

function publishedReportCommitPaths(
  result: PortfolioTaskExecutionResult,
  archiveRepoPath: string,
): readonly string[] {
  if (
    (result.type !== 'analysis' && result.type !== 'rollup') ||
    result.status !== 'completed' ||
    result.publication?.status !== 'published' ||
    result.publication.archiveRepoPath !== archiveRepoPath
  ) {
    return [];
  }

  return result.publication.writtenPaths ?? [];
}

function stateCommitPaths(
  result: PortfolioTaskExecutionResult,
  archiveRepoPath: string,
): readonly string[] {
  if (result.type === 'analysis') {
    return relativePathsInArchive(archiveRepoPath, [result.statePath]);
  }

  if (result.type !== 'maintenance' || result.status !== 'completed') {
    return [];
  }

  return relativePathsInArchive(archiveRepoPath, [
    result.statePath,
    ...(result.backupPath === null ? [] : [result.backupPath]),
  ]);
}

function relativePathsInArchive(
  archiveRepoPath: string,
  filePaths: readonly (string | undefined)[],
): readonly string[] {
  return filePaths.flatMap((filePath) => {
    if (filePath === undefined) {
      return [];
    }
    const relativePath = relativePathInArchive(archiveRepoPath, filePath);
    return relativePath === undefined ? [] : [relativePath];
  });
}

function relativePathInArchive(archiveRepoPath: string, filePath: string): string | undefined {
  const relativePath = path.relative(archiveRepoPath, filePath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(path.sep).join(path.posix.sep);
}

function executionCommitContext(
  plan: PortfolioExecutionPlan,
  results: readonly PortfolioTaskExecutionResult[],
  config: ReturnType<typeof normalizeReportsConfig>,
): JsonObject {
  const completedTasks = results.filter((result) => result.status === 'completed');
  const failedTasks = results.filter((result) => result.status === 'failed');
  const analysisIds = unique(plan.tasks.map((task) => task.analysisId));
  const analysisNames = unique(plan.tasks.map((task) => task.analysisName));
  const targetIds = unique(plan.tasks.map((task) => task.targetId));
  const targetNames = unique(plan.tasks.map((task) => task.targetName));
  const runIds = unique(
    plan.tasks.flatMap((task) => {
      if (task.type === 'analysis') {
        return [task.runId];
      }
      if (task.type === 'rollup') {
        return [task.rollupId];
      }
      return [task.maintenanceId];
    }),
  );
  const periodKeys = unique(
    plan.tasks.flatMap((task) => ('window' in task ? [periodKey(task.window)] : [])),
  );

  return {
    reports: {
      baseDir: config.baseDir,
    },
    analysis: {
      id: singleOrMultiple(analysisIds),
      name: singleOrMultiple(analysisNames),
      ids: analysisIds,
      names: analysisNames,
    },
    target: {
      id: singleOrMultiple(targetIds),
      name: singleOrMultiple(targetNames),
      ids: targetIds,
      names: targetNames,
    },
    run: {
      id: singleOrMultiple(runIds),
      ids: runIds,
    },
    period: {
      key: singleOrMultiple(periodKeys),
      keys: periodKeys,
    },
    execution: {
      manifestPath: plan.manifestPath,
      manifestHash: plan.manifestHash,
      generatedAt: plan.generatedAt,
      completed: completedTasks.length,
      failed: failedTasks.length,
      total: results.length,
      analysisIds,
      targetIds,
      runIds,
      periodKeys,
    },
    startedAt: plan.generatedAt,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].toSorted();
}

function singleOrMultiple(values: readonly string[]): string {
  if (values.length === 0) {
    return '';
  }
  if (values.length === 1) {
    return values[0] ?? '';
  }
  return 'multiple';
}

export async function resolvePortfolioTaskConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'analysis' }>;
}): Promise<ResolvedConfig> {
  return resolvePortfolioTargetConfig({
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    task: input.task,
    runId: input.task.runId,
  });
}

async function resolvePortfolioTargetConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly task: Extract<
    PlannedPortfolioTask,
    { readonly type: 'analysis' | 'rollup' | 'maintenance' }
  >;
  readonly runId?: string | undefined;
}): Promise<ResolvedConfig> {
  const analysis = findById(input.manifest.analyses, input.task.analysisId, 'analysis');
  const target = findById(analysis.targets, input.task.targetId, 'target');
  const state = materializeStateConfig({
    manifest: input.manifest,
    analysisId: analysis.id,
  });
  const rawConfig = materializeAnalysisConfig({
    manifest: input.manifest,
    analysisId: analysis.id,
    targetId: target.id,
    runId: input.runId,
  });
  const rawConfigWithState = {
    ...rawConfig,
    storage: {
      ...rawConfig.storage,
      statePath:
        rawConfig.storage?.statePath ??
        renderStatePath({
          manifestPath: input.manifestPath,
          state,
          analysis,
          target,
          window: 'window' in input.task ? input.task.window : undefined,
        }),
    },
  };

  return {
    config: await resolveConfigPaths(rawConfigWithState, input.manifestPath),
    configPath: input.manifestPath,
    configHash: hashJson(rawConfigWithState),
    topicId: `${analysis.id}-${target.id}`,
  };
}

function renderStatePath(input: {
  readonly manifestPath: string;
  readonly state: JsonObject;
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
  readonly window?: DateRange | undefined;
}): string {
  const { pathTemplate: statePathTemplate } = input.state;
  const template =
    typeof statePathTemplate === 'string'
      ? statePathTemplate
      : 'state/{{analysis.id}}/{{target.id}}.json';
  const rendered = Handlebars.compile(template, { noEscape: true })({
    analysis: {
      id: input.analysis.id,
      name: input.analysis.name,
    },
    target: {
      id: input.target.id,
      name: input.target.name,
      status: input.target.status,
    },
    period: {
      key: input.window ? periodKey(input.window) : localDateForDate(new Date(), 'UTC'),
    },
  });
  return resolveFromConfig(input.manifestPath, rendered);
}

function periodKey(window: DateRange): string {
  if (window.startDate && window.endDate && window.startDate !== window.endDate) {
    return `${window.startDate}_to_${window.endDate}`;
  }

  return window.startDate ?? window.endDate ?? localDateForDate(new Date(), 'UTC');
}

function createStateBackup(statePath: string): string | null {
  if (!existsSync(statePath)) {
    return null;
  }

  const backupPath = `${statePath}.${new Date().toISOString().replaceAll(/[:.]/g, '-')}.bak`;
  copyFileSync(statePath, backupPath);
  return backupPath;
}

function summarizeResults(results: readonly PortfolioTaskExecutionResult[]) {
  return {
    completed: results.filter((result) => result.status === 'completed').length,
    skipped: 0,
    failed: results.filter((result) => result.status === 'failed').length,
  };
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
