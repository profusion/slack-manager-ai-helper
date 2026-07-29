import { type DateRange, localDateForDate, normalizeDateRange } from '../date-range.js';
import { hashJson } from '../utils/json.js';
import { resolveLocalTimeZone } from '../utils/local-time.js';
import {
  type JsonObject,
  materializeAnalysisConfig,
  materializeRunAndNotifyConfig,
  type PortfolioAnalysis,
  type PortfolioMaintenance,
  type PortfolioManifest,
  type PortfolioTarget,
} from './load-portfolio.js';

export type PortfolioPlanOptions = {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly analysisIds?: readonly string[] | undefined;
  readonly targetIds?: readonly string[] | undefined;
  readonly due?: boolean | undefined;
  readonly includePaused?: boolean | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly date?: string | undefined;
  readonly window?: string | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly now?: Date | undefined;
  readonly localTimeZone?: string | undefined;
  readonly notify?: boolean | undefined;
  readonly publish?: boolean | undefined;
  readonly updateLatest?: boolean | undefined;
  readonly concurrency?: number | undefined;
};

export type PortfolioExecutionPlan = {
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly generatedAt: string;
  readonly localTimeZone: string;
  readonly mode: 'dry-run';
  readonly selection: {
    readonly due: boolean;
    readonly analyses: readonly string[];
    readonly targets: readonly string[];
    readonly includePaused: boolean;
    readonly includeArchived: boolean;
    readonly notify: boolean;
    readonly publish: boolean;
    readonly updateLatest: boolean;
    readonly concurrency: number;
  };
  readonly tasks: readonly PlannedPortfolioTask[];
  readonly skippedTargets: readonly SkippedPortfolioTarget[];
};

export type PlannedPortfolioTask =
  | {
      readonly type: 'analysis';
      readonly analysisId: string;
      readonly analysisName: string;
      readonly targetId: string;
      readonly targetName: string;
      readonly targetStatus: PortfolioTarget['status'];
      readonly runId: string;
      readonly schedule: JsonObject;
      readonly window: DateRange;
      readonly analysisConfigHash: string;
      readonly runAndNotifyConfigHash: string;
    }
  | {
      readonly type: 'rollup';
      readonly analysisId: string;
      readonly analysisName: string;
      readonly targetId: string;
      readonly targetName: string;
      readonly targetStatus: PortfolioTarget['status'];
      readonly rollupId: string;
      readonly prompt: string;
      readonly schedule: JsonObject;
      readonly window: DateRange;
      readonly runAndNotifyConfigHash: string;
    }
  | {
      readonly type: 'maintenance';
      readonly analysisId: string;
      readonly analysisName: string;
      readonly targetId: string;
      readonly targetName: string;
      readonly targetStatus: PortfolioTarget['status'];
      readonly maintenanceId: string;
      readonly maintenanceKind: PortfolioMaintenance['kind'];
      readonly schedule: JsonObject;
      readonly keepRuns?: number | undefined;
      readonly backup?: boolean | undefined;
    };

export type SkippedPortfolioTarget = {
  readonly analysisId: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly status: PortfolioTarget['status'];
  readonly reason: 'paused' | 'archived' | 'target_filter';
};

type PlannerContext = {
  readonly now: Date;
  readonly localTimeZone: string;
  readonly applyScheduleFilter: boolean;
  readonly applyTimeCheck: boolean;
  readonly scheduleDate: string | undefined;
  readonly cliWindow: DateRange | undefined;
};

type ScheduleLike = JsonObject & {
  readonly kind?: unknown;
  readonly time?: unknown;
  readonly weekdays?: unknown;
};

type WindowLike = JsonObject & {
  readonly date?: unknown;
  readonly name?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
};

export function planPortfolioDryRun(options: PortfolioPlanOptions): PortfolioExecutionPlan {
  const now = options.now ?? new Date();
  const localTimeZone =
    options.localTimeZone ?? options.manifest.timezone ?? resolveLocalTimeZone();
  const cliWindow = resolveCliWindow(options, localTimeZone);
  const scheduleDate = resolveScheduleReferenceDate(options, localTimeZone, now);
  const context: PlannerContext = {
    now,
    localTimeZone,
    applyScheduleFilter: options.due === true || scheduleDate !== undefined,
    applyTimeCheck: options.due === true && scheduleDate === undefined,
    scheduleDate,
    cliWindow,
  };
  const analysisFilter = new Set(options.analysisIds ?? []);
  const targetFilter = new Set(options.targetIds ?? []);
  const selectedAnalyses = filterAnalyses(options.manifest.analyses, analysisFilter);
  const tasks: PlannedPortfolioTask[] = [];
  const skippedTargets: SkippedPortfolioTarget[] = [];

  for (const analysis of selectedAnalyses) {
    const selectedTargets = selectTargets({
      analysis,
      targetFilter,
      includePaused: options.includePaused === true,
      includeArchived: options.includeArchived === true,
      skippedTargets,
    });
    for (const target of selectedTargets) {
      tasks.push(...planAnalysisTasks(options.manifest, analysis, target, context));
      tasks.push(...planRollupTasks(options.manifest, analysis, target, context));
      tasks.push(...planMaintenanceTasks(analysis, target, context));
    }
  }

  return {
    manifestPath: options.manifestPath,
    manifestHash: options.manifestHash,
    generatedAt: now.toISOString(),
    localTimeZone,
    mode: 'dry-run',
    selection: {
      due: options.due === true,
      analyses: [...analysisFilter].toSorted(),
      targets: [...targetFilter].toSorted(),
      includePaused: options.includePaused === true,
      includeArchived: options.includeArchived === true,
      notify: options.notify !== false,
      publish: options.publish !== false,
      updateLatest: options.updateLatest === true,
      concurrency: normalizePortfolioConcurrency(options.concurrency),
    },
    tasks,
    skippedTargets,
  };
}

export function normalizePortfolioConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Portfolio concurrency must be a positive integer: ${value}`);
  }
  return value;
}

function filterAnalyses(
  analyses: readonly PortfolioAnalysis[],
  analysisFilter: ReadonlySet<string>,
): readonly PortfolioAnalysis[] {
  if (analysisFilter.size === 0) {
    return analyses;
  }
  return analyses.filter((analysis) => analysisFilter.has(analysis.id));
}

function selectTargets(input: {
  readonly analysis: PortfolioAnalysis;
  readonly targetFilter: ReadonlySet<string>;
  readonly includePaused: boolean;
  readonly includeArchived: boolean;
  readonly skippedTargets: SkippedPortfolioTarget[];
}): readonly PortfolioTarget[] {
  return input.analysis.targets.filter((target) => {
    if (input.targetFilter.size > 0 && !input.targetFilter.has(target.id)) {
      input.skippedTargets.push(skippedTarget(input.analysis, target, 'target_filter'));
      return false;
    }

    if (target.status === 'paused' && input.targetFilter.size === 0 && !input.includePaused) {
      input.skippedTargets.push(skippedTarget(input.analysis, target, 'paused'));
      return false;
    }

    if (target.status === 'archived' && !input.includeArchived) {
      input.skippedTargets.push(skippedTarget(input.analysis, target, 'archived'));
      return false;
    }

    return true;
  });
}

function planAnalysisTasks(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  target: PortfolioTarget,
  context: PlannerContext,
): readonly PlannedPortfolioTask[] {
  return (analysis.runs ?? [])
    .filter((run) => shouldPlanSchedule(run.schedule, context))
    .map((run) => {
      const analysisConfig = materializeAnalysisConfig({
        manifest,
        analysisId: analysis.id,
        targetId: target.id,
        runId: run.id,
      });
      const runAndNotifyConfig = materializeRunAndNotifyConfig({
        manifest,
        analysisId: analysis.id,
        targetId: target.id,
        runId: run.id,
      });
      return {
        type: 'analysis',
        analysisId: analysis.id,
        analysisName: analysis.name,
        targetId: target.id,
        targetName: target.name,
        targetStatus: target.status,
        runId: run.id,
        schedule: run.schedule,
        window: context.cliWindow ?? resolveManifestWindow(run.window, context),
        analysisConfigHash: hashJson(analysisConfig),
        runAndNotifyConfigHash: hashJson(runAndNotifyConfig),
      };
    });
}

function planRollupTasks(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  target: PortfolioTarget,
  context: PlannerContext,
): readonly PlannedPortfolioTask[] {
  return (analysis.rollups ?? [])
    .filter((rollup) => shouldPlanSchedule(rollup.schedule, context))
    .map((rollup) => {
      const runAndNotifyConfig = materializeRunAndNotifyConfig({
        manifest,
        analysisId: analysis.id,
        targetId: target.id,
      });
      return {
        type: 'rollup',
        analysisId: analysis.id,
        analysisName: analysis.name,
        targetId: target.id,
        targetName: target.name,
        targetStatus: target.status,
        rollupId: rollup.id,
        prompt: rollup.prompt,
        schedule: rollup.schedule,
        window: context.cliWindow ?? resolveManifestWindow(rollup.window, context),
        runAndNotifyConfigHash: hashJson(runAndNotifyConfig),
      };
    });
}

function planMaintenanceTasks(
  analysis: PortfolioAnalysis,
  target: PortfolioTarget,
  context: PlannerContext,
): readonly PlannedPortfolioTask[] {
  return (analysis.maintenance ?? [])
    .filter((maintenance) => shouldPlanSchedule(maintenance.schedule, context))
    .map((maintenance) => ({
      type: 'maintenance',
      analysisId: analysis.id,
      analysisName: analysis.name,
      targetId: target.id,
      targetName: target.name,
      targetStatus: target.status,
      maintenanceId: maintenance.id,
      maintenanceKind: maintenance.kind,
      schedule: maintenance.schedule,
      ...(maintenance.keepRuns !== undefined ? { keepRuns: maintenance.keepRuns } : {}),
      ...(maintenance.backup !== undefined ? { backup: maintenance.backup } : {}),
    }));
}

function shouldPlanSchedule(schedule: ScheduleLike, context: PlannerContext): boolean {
  if (!context.applyScheduleFilter) {
    return true;
  }

  const kind = schedule.kind;
  if (kind === 'manual') {
    return false;
  }

  if (context.applyTimeCheck && !isDueByTime(schedule, context)) {
    return false;
  }

  if (kind === 'daily') {
    return true;
  }

  const scheduleDay = context.scheduleDate ?? localDateForDate(context.now, context.localTimeZone);
  if (kind === 'workdays' || kind === 'every-n-workdays') {
    return isWorkday(scheduleDay);
  }

  if (kind === 'weekdays') {
    const weekdays = schedule.weekdays;
    return Array.isArray(weekdays) && weekdays.includes(weekdayNameForDate(scheduleDay));
  }

  return false;
}

function resolveScheduleReferenceDate(
  options: PortfolioPlanOptions,
  localTimeZone: string,
  now: Date,
): string | undefined {
  if (options.date === undefined) {
    return undefined;
  }

  const range = normalizeDateRange({ date: options.date }, localTimeZone, now);
  if (!range.startDate || range.startDate !== range.endDate) {
    throw new Error('--date must resolve to one local day for portfolio schedule filtering');
  }
  return range.startDate;
}

function isDueByTime(schedule: ScheduleLike, context: PlannerContext): boolean {
  const time = schedule.time;
  if (typeof time !== 'string') {
    return true;
  }
  return localTime(context.now, context.localTimeZone) >= time;
}

function resolveCliWindow(
  options: PortfolioPlanOptions,
  localTimeZone: string,
): DateRange | undefined {
  const range = normalizeDateRange(
    {
      date: options.date,
      window: options.window,
      startDate: options.startDate,
      endDate: options.endDate,
    },
    localTimeZone,
    options.now,
  );
  return range.startDate || range.endDate ? range : undefined;
}

function resolveManifestWindow(window: WindowLike, context: PlannerContext): DateRange {
  return normalizeDateRange(
    {
      date: typeof window.date === 'string' ? window.date : undefined,
      window: typeof window.name === 'string' ? window.name : undefined,
      startDate: typeof window.startDate === 'string' ? window.startDate : undefined,
      endDate: typeof window.endDate === 'string' ? window.endDate : undefined,
    },
    context.localTimeZone,
    context.now,
  );
}

function skippedTarget(
  analysis: PortfolioAnalysis,
  target: PortfolioTarget,
  reason: SkippedPortfolioTarget['reason'],
): SkippedPortfolioTarget {
  return {
    analysisId: analysis.id,
    targetId: target.id,
    targetName: target.name,
    status: target.status,
    reason,
  };
}

function localTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return `${readDatePart(parts, 'hour')}:${readDatePart(parts, 'minute')}`;
}

const weekdayNames = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

function weekdayNameForDate(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekdayNames[day] ?? 'sunday';
}

function isWorkday(date: string): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function readDatePart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Unable to format local date part "${type}"`);
  }
  return value;
}
