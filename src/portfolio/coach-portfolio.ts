import { readFile } from 'node:fs/promises';
import { type GenerateModelText, generateModelText } from '../llm/generate.js';
import { stripJsonSchemaFencedBlocks } from '../llm/markdown-schema.js';
import { analysisModelChain, retryCountForModel } from '../llm/model-config.js';
import { readPrompt } from '../llm/prompt.js';
import { openStateStore, saveCoaching } from '../state/state-store.js';
import type { AnalysisModelConfig, ConfiguredUser, ResolvedConfig } from '../types.js';
import { resolveFromConfig } from '../utils/paths.js';
import {
  type JsonObject,
  materializeRunAndNotifyConfig,
  type PortfolioCoachConfig,
  type PortfolioManifest,
  type PortfolioTarget,
} from './load-portfolio.js';
import { notifyCoachDm, type PortfolioCommandRunner } from './notify-portfolio.js';
import type { PlannedPortfolioTask } from './plan-portfolio.js';

type AnalysisTask = Extract<PlannedPortfolioTask, { readonly type: 'analysis' }>;

export type CoachingResult = {
  readonly date: string;
  readonly userId: string;
  readonly status: 'delivered' | 'skipped' | 'failed';
  readonly reason?: 'report_match' | 'no_coaching_needed' | undefined;
  readonly error?: string | undefined;
  readonly persistenceError?: string | undefined;
};

export async function coachPortfolioAnalysis(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly task: AnalysisTask;
  readonly resolved: ResolvedConfig;
  readonly runId: string;
  readonly reportText: string | undefined;
  readonly notify: boolean;
  readonly generateText?: GenerateModelText | undefined;
  readonly commandRunner?: PortfolioCommandRunner | undefined;
  readonly command?: string | undefined;
}): Promise<readonly CoachingResult[]> {
  if (!input.reportText) return [];
  const target = input.manifest.analyses
    .find((analysis) => analysis.id === input.task.analysisId)
    ?.targets.find((item) => item.id === input.task.targetId);
  if (!target) throw new Error(`Unknown portfolio target: ${input.task.targetId}`);
  const targetCoaching = resolveTargetCoaching(target.coach, input.manifest.coach);
  const enabledUsers = collectEnabledCoachUsers(input.resolved, targetCoaching.defaultEnabled);
  if (enabledUsers.length === 0) return [];
  const coach = input.manifest.coach;
  if (!coach?.prompt || !coach.model)
    throw new Error('Enabled portfolio coach requires root coach.prompt and coach.model');

  const excerpts = userReviewExcerpts(input.reportText, enabledUsers);
  const skipWhenReportMatches =
    targetCoaching.skipPattern === undefined ? undefined : new RegExp(targetCoaching.skipPattern);
  const dates = [...input.reportText.matchAll(/^# Date:\s*(\d{4}-\d{2}-\d{2})\b/gm)]
    .map((match) => match[1])
    .filter((date): date is string => date !== undefined);
  if (dates.length === 0) throw new Error('Coach report has no dated review sections');
  const found = new Set(excerpts.map((excerpt) => `${excerpt.date}\0${excerpt.userId}`));
  const missing: CoachingResult[] = [...new Set(dates)].flatMap((date) =>
    enabledUsers
      .filter((user) => !found.has(`${date}\0${user.id}`))
      .map((user) => ({
        date,
        userId: user.id,
        status: 'failed' as const,
        error: 'No review section matches this configured Slack user and date',
      })),
  );
  const sourcePrompts = await Promise.all(
    input.resolved.config.prompts.map((reference) => readPrompt(reference)),
  );
  const dailyInstructions = sourcePrompts
    .map((source) => stripJsonSchemaFencedBlocks(source))
    .join('\n\n');
  const coachInstructions = await readFile(
    resolveFromConfig(input.manifestPath, coach.prompt),
    'utf8',
  );
  const store = openStateStore(input.resolved.config.storage.statePath, input.resolved.topicId);
  const run = store.state.runs.find((item) => item.id === input.runId);
  const patternsByUser = userRecurrencePatterns(
    run?.modelOutputs.map((output) => output.outputJson) ?? [],
  );
  const notification = materializeRunAndNotifyConfig({
    manifest: input.manifest,
    analysisId: input.task.analysisId,
    targetId: input.task.targetId,
    runId: input.task.runId,
  });
  const results: CoachingResult[] = [...missing];
  const context: CoachRunContext = {
    config: input.resolved,
    model: coach.model,
    generateText: input.generateText ?? generateModelText,
    system: coachInstructions,
    dailyInstructions,
    patternsByUser,
    statePath: store.statePath,
    topicId: input.resolved.topicId,
    runId: input.runId,
    notify: input.notify,
    notification,
    commandRunner: input.commandRunner,
    command: input.command,
  };
  for (const excerpt of excerpts) {
    if (skipWhenReportMatches?.test(excerpt.markdown)) {
      results.push({
        date: excerpt.date,
        userId: excerpt.userId,
        status: 'skipped',
        reason: 'report_match',
      });
      continue;
    }
    results.push(await coachExcerpt(excerpt, context));
  }
  return results;
}

function collectEnabledCoachUsers(
  resolved: ResolvedConfig,
  defaultEnabled: boolean,
): ConfiguredUser[] {
  const users = new Map<string, ConfiguredUser>();
  for (const channel of resolved.config.channels) {
    for (const user of channel.users ?? []) {
      const previous = users.get(user.id);
      if (previous?.coach != null && user.coach != null && previous.coach !== user.coach) {
        throw new Error(`Conflicting coach overrides for user ${user.id}`);
      }
      users.set(user.id, { ...previous, ...user, coach: user.coach ?? previous?.coach });
    }
  }
  return [...users.values()].filter((user) => user.coach ?? defaultEnabled);
}

function resolveTargetCoaching(
  targetCoach: PortfolioTarget['coach'],
  rootCoach: PortfolioCoachConfig | undefined,
): { readonly defaultEnabled: boolean; readonly skipPattern: string | undefined } {
  const targetEnabled =
    targetCoach && typeof targetCoach === 'object'
      ? targetCoach.enabled
      : typeof targetCoach === 'boolean'
        ? targetCoach
        : undefined;
  const targetPattern =
    targetCoach && typeof targetCoach === 'object' ? targetCoach.skipWhenReportMatches : undefined;
  const pattern =
    targetPattern === false ? undefined : (targetPattern ?? rootCoach?.skipWhenReportMatches);
  return {
    defaultEnabled: targetEnabled ?? rootCoach?.enabled ?? false,
    skipPattern: pattern == null ? undefined : pattern,
  };
}

type CoachRunContext = {
  readonly config: ResolvedConfig;
  readonly model: AnalysisModelConfig;
  readonly generateText: GenerateModelText;
  readonly system: string;
  readonly dailyInstructions: string;
  readonly patternsByUser: ReadonlyMap<string, JsonObject>;
  readonly statePath: string;
  readonly topicId: string;
  readonly runId: string;
  readonly notify: boolean;
  readonly notification: JsonObject;
  readonly commandRunner: PortfolioCommandRunner | undefined;
  readonly command: string | undefined;
};

async function coachExcerpt(
  excerpt: ReviewExcerpt,
  context: CoachRunContext,
): Promise<CoachingResult> {
  try {
    const generated = await generateCoachText({
      config: context.config,
      model: context.model,
      generateText: context.generateText,
      system: context.system,
      prompt: [
        '# Daily review instructions used to produce the review',
        context.dailyInstructions,
        '# User and date',
        JSON.stringify({ userId: excerpt.userId, date: excerpt.date }),
        '# Review excerpt for this user only',
        excerpt.markdown,
        '# Recurrence patterns JSON',
        JSON.stringify(context.patternsByUser.get(excerpt.userId) ?? {}),
      ].join('\n\n'),
    });
    const { text } = generated;
    if (text === 'NO_COACHING_NEEDED') {
      return {
        date: excerpt.date,
        userId: excerpt.userId,
        status: 'skipped',
        reason: 'no_coaching_needed',
      };
    }
    const createdAt = new Date().toISOString();
    const currentStore = saveCoaching(
      openStateStore(context.statePath, context.topicId),
      context.runId,
      {
        date: excerpt.date,
        userId: excerpt.userId,
        text,
        modelProvider: generated.model.provider,
        modelName: generated.model.model,
        createdAt,
        delivery: 'pending',
      },
    );
    let status: CoachingResult['status'] = 'skipped';
    let error: string | undefined;
    if (context.notify) {
      try {
        status = await notifyCoachDm({
          userId: excerpt.userId,
          text,
          notification: context.notification,
          commandRunner: context.commandRunner,
          command: context.command,
        });
      } catch (cause) {
        status = 'failed';
        error = errorMessage(cause);
      }
    }
    let persistenceError: string | undefined;
    try {
      saveCoaching(currentStore, context.runId, {
        date: excerpt.date,
        userId: excerpt.userId,
        text,
        modelProvider: generated.model.provider,
        modelName: generated.model.model,
        createdAt: new Date().toISOString(),
        delivery: status,
        ...(error === undefined ? {} : { deliveryError: error }),
      });
    } catch (cause) {
      persistenceError = errorMessage(cause);
    }
    return {
      date: excerpt.date,
      userId: excerpt.userId,
      status,
      ...(error === undefined ? {} : { error }),
      ...(persistenceError === undefined ? {} : { persistenceError }),
    };
  } catch (cause) {
    return {
      date: excerpt.date,
      userId: excerpt.userId,
      status: 'failed',
      error: errorMessage(cause),
    };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

type ReviewExcerpt = { readonly date: string; readonly userId: string; readonly markdown: string };

async function generateCoachText(input: {
  readonly config: ResolvedConfig;
  readonly model: AnalysisModelConfig;
  readonly generateText: GenerateModelText;
  readonly system: string;
  readonly prompt: string;
}): Promise<{ readonly text: string; readonly model: AnalysisModelConfig }> {
  let lastError: unknown;
  for (const model of analysisModelChain(input.model)) {
    for (let attempt = 0; attempt <= retryCountForModel(model); attempt += 1) {
      try {
        const result = await input.generateText({
          config: { ...input.config.config, model },
          system: input.system,
          prompt: input.prompt,
        });
        const text = result.text.trim();
        if (!text) throw new Error('Coach model returned empty text');
        return { text, model };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Markdown headings form one date/user section state machine.
export function userReviewExcerpts(
  report: string,
  users: readonly ConfiguredUser[],
): readonly ReviewExcerpt[] {
  const byId = new Map(users.map((user) => [user.id, user]));
  const byName = new Map<string, string[]>();
  for (const user of users) {
    if (user.name) {
      const key = user.role ? `${user.name} (${user.role})` : user.name;
      byName.set(key, [...(byName.get(key) ?? []), user.id]);
    }
  }
  const lines = report.split(/\r?\n/);
  const excerpts: ReviewExcerpt[] = [];
  let date: string | undefined;
  let heading: string | undefined;
  let section: string[] = [];
  const flush = (): void => {
    if (!date || !heading) return;
    const id = /\[([UW][A-Z0-9_]+)\]\s*$/.exec(heading)?.[1];
    const label = heading.replace(/\s*\[[UW][A-Z0-9_]+\]\s*$/, '').trim();
    const matches = byName.get(label) ?? [];
    const configured = id ? byId.get(id) : undefined;
    const userId =
      configured && (!configured.name || (id !== undefined && matches.includes(id)))
        ? id
        : undefined;
    if (userId)
      excerpts.push({
        date,
        userId,
        markdown: [`## User: ${heading}`, ...section].join('\n').trim(),
      });
  };
  for (const line of lines) {
    const dateMatch = /^# Date:\s*(\d{4}-\d{2}-\d{2})\b/.exec(line);
    const userMatch = /^## User:\s*(.+?)\s*$/.exec(line);
    if (dateMatch) {
      flush();
      heading = undefined;
      section = [];
      date = dateMatch[1];
    } else if (userMatch) {
      flush();
      heading = userMatch[1];
      section = [];
    } else if (/^#{1,2}\s/.test(line)) {
      flush();
      heading = undefined;
      section = [];
    } else if (heading) section.push(line);
  }
  flush();
  const perUserDay = new Map<string, ReviewExcerpt>();
  for (const excerpt of excerpts) {
    const key = `${excerpt.date}\0${excerpt.userId}`;
    const previous = perUserDay.get(key);
    perUserDay.set(
      key,
      previous ? { ...excerpt, markdown: `${previous.markdown}\n\n${excerpt.markdown}` } : excerpt,
    );
  }
  return [...perUserDay.values()];
}

function userRecurrencePatterns(outputs: readonly unknown[]): ReadonlyMap<string, JsonObject> {
  const patterns = new Map<string, JsonObject>();
  for (const output of outputs.flatMap(memoryDocuments)) {
    for (const memory of Array.isArray(output.users) ? output.users : []) {
      if (!isObject(memory) || !isObject(memory.user) || typeof memory.user.id !== 'string')
        continue;
      const previous = patterns.get(memory.user.id);
      patterns.set(
        memory.user.id,
        Object.fromEntries(
          [
            'planning_patterns',
            'collaboration_patterns',
            'positive_patterns',
            'coaching_opportunities',
          ].map((key) => [
            key,
            [
              ...(Array.isArray(previous?.[key]) ? previous[key] : []),
              ...(Array.isArray(memory[key]) ? memory[key] : []),
            ],
          ]),
        ),
      );
    }
  }
  return patterns;
}

function memoryDocuments(value: unknown): readonly CoachObject[] {
  if (!isObject(value)) return [];
  if (Array.isArray(value.users)) return [value];
  if (!Array.isArray(value.segments)) return [];
  return value.segments.flatMap((segment) => {
    if (!isObject(segment) || typeof segment.content !== 'string') return [];
    try {
      const parsed: unknown = JSON.parse(segment.content);
      return memoryDocuments(parsed);
    } catch {
      return [];
    }
  });
}

type CoachObject = JsonObject & {
  readonly users?: unknown;
  readonly user?: unknown;
  readonly id?: unknown;
  readonly planning_patterns?: unknown;
  readonly collaboration_patterns?: unknown;
  readonly positive_patterns?: unknown;
  readonly coaching_opportunities?: unknown;
  readonly segments?: unknown;
  readonly content?: unknown;
};

function isObject(value: unknown): value is CoachObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
