import { readFile } from 'node:fs/promises';
import type { ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import * as addFormatsModule from 'ajv-formats';
import portfolioSchema from '../../schemas/portfolio.schema.json' with { type: 'json' };
import { validateRawConfig } from '../config/load-config.js';
import type { AppConfig } from '../types.js';
import { hashJson, parseJsonObject } from '../utils/json.js';

const ajv = new Ajv2020({ allErrors: true });
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
addFormats(ajv);

const validatePortfolio = ajv.compile(portfolioSchema);

export type JsonObject = Record<string, unknown>;

export type PortfolioManifest = {
  readonly schemaVersion: 1;
  readonly timezone?: string | undefined;
  readonly defaults?: PortfolioDefaults | undefined;
  readonly analyses: readonly PortfolioAnalysis[];
};

export type PortfolioDefaults = {
  readonly analysisConfig?: JsonObject | undefined;
  readonly matchers?: PortfolioCommonMatchers | undefined;
  readonly state?: JsonObject | undefined;
  readonly reports?: JsonObject | undefined;
  readonly runAndNotifyConfig?: JsonObject | undefined;
};

export type PortfolioCommonMatchers = {
  readonly pre?: readonly JsonObject[] | undefined;
  readonly post?: readonly JsonObject[] | undefined;
};

export type PortfolioAnalysis = {
  readonly id: string;
  readonly name: string;
  readonly defaults?: PortfolioDefaults | undefined;
  readonly runs?: readonly PortfolioRun[] | undefined;
  readonly rollups?: readonly PortfolioRollup[] | undefined;
  readonly maintenance?: readonly PortfolioMaintenance[] | undefined;
  readonly targets: readonly PortfolioTarget[];
};

export type PortfolioTarget = {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'paused' | 'archived';
  readonly startedOn?: string | undefined;
  readonly endedOn?: string | undefined;
  readonly archiveReason?: string | undefined;
  readonly analysisConfig?: JsonObject | undefined;
  readonly runAndNotifyConfig?: JsonObject | undefined;
  readonly runs?: readonly PortfolioTargetRunOverride[] | undefined;
};

export type PortfolioRun = {
  readonly id: string;
  readonly schedule: JsonObject;
  readonly window: JsonObject;
  readonly analysisConfig?: JsonObject | undefined;
  readonly runAndNotifyConfig?: JsonObject | undefined;
};

export type PortfolioRollup = {
  readonly id: string;
  readonly schedule: JsonObject;
  readonly window: JsonObject;
  readonly prompt: string;
  readonly runAndNotifyConfig?: JsonObject | undefined;
};

export type PortfolioMaintenance = {
  readonly id: string;
  readonly kind: 'compact-state';
  readonly schedule: JsonObject;
  readonly keepRuns?: number | undefined;
  readonly backup?: boolean | undefined;
};

export type PortfolioTargetRunOverride = {
  readonly runId: string;
  readonly analysisConfig?: JsonObject | undefined;
  readonly runAndNotifyConfig?: JsonObject | undefined;
};

export type LoadedPortfolio = {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly manifestHash: string;
};

export class PortfolioValidationError extends Error {
  readonly manifestPath: string;
  readonly validationErrors: readonly ErrorObject[];

  constructor(manifestPath: string, validationErrors: readonly ErrorObject[]) {
    super(`Invalid portfolio manifest ${manifestPath}: ${ajv.errorsText([...validationErrors])}`);
    this.name = 'PortfolioValidationError';
    this.manifestPath = manifestPath;
    this.validationErrors = validationErrors;
  }
}

export async function loadPortfolioManifest(manifestPath: string): Promise<LoadedPortfolio> {
  const text = await readFile(manifestPath, 'utf8');
  const raw = parseJsonObject(text, manifestPath);
  const manifest = validateRawPortfolioManifest(raw, manifestPath);
  return {
    manifest,
    manifestPath,
    manifestHash: hashJson(manifest),
  };
}

export function validateRawPortfolioManifest(
  raw: Record<string, unknown>,
  manifestPath: string,
): PortfolioManifest {
  if (!validatePortfolio(raw)) {
    throw new PortfolioValidationError(manifestPath, [...(validatePortfolio.errors ?? [])]);
  }

  const manifest = raw as PortfolioManifest;
  validatePortfolioSemantics(manifest, manifestPath);
  return manifest;
}

export function materializeAnalysisConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly analysisId: string;
  readonly targetId: string;
  readonly runId?: string | undefined;
  readonly configPathForValidation?: string | undefined;
}): AppConfig {
  const analysis = findById(input.manifest.analyses, input.analysisId, 'analysis');
  const target = findById(analysis.targets, input.targetId, 'target');
  const run = input.runId ? findById(analysis.runs ?? [], input.runId, 'run') : undefined;
  const targetRunOverride = input.runId
    ? target.runs?.find((override) => override.runId === input.runId)
    : undefined;
  const merged = deepMergeObjects(
    input.manifest.defaults?.analysisConfig,
    analysis.defaults?.analysisConfig,
    run?.analysisConfig,
    target.analysisConfig,
    targetRunOverride?.analysisConfig,
  );
  const withCommonMatchers = applyCommonMatchers(
    merged,
    deepMergeCommonMatchers(input.manifest.defaults?.matchers, analysis.defaults?.matchers),
  );

  return validateRawConfig(
    withCommonMatchers,
    input.configPathForValidation ?? 'materialized portfolio config',
  );
}

export function materializeRunAndNotifyConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly analysisId: string;
  readonly targetId: string;
  readonly runId?: string | undefined;
  readonly rollupId?: string | undefined;
}): JsonObject {
  const analysis = findById(input.manifest.analyses, input.analysisId, 'analysis');
  const target = findById(analysis.targets, input.targetId, 'target');
  const run = input.runId ? findById(analysis.runs ?? [], input.runId, 'run') : undefined;
  const rollup = input.rollupId
    ? findById(analysis.rollups ?? [], input.rollupId, 'rollup')
    : undefined;
  const targetRunOverride = input.runId
    ? target.runs?.find((override) => override.runId === input.runId)
    : undefined;
  if (rollup) {
    return ensureNotificationName(
      target,
      deepMergeObjects(
        input.manifest.defaults?.runAndNotifyConfig,
        analysis.defaults?.runAndNotifyConfig,
        target.runAndNotifyConfig,
        rollup.runAndNotifyConfig,
      ),
    );
  }
  return ensureNotificationName(
    target,
    deepMergeObjects(
      input.manifest.defaults?.runAndNotifyConfig,
      analysis.defaults?.runAndNotifyConfig,
      run?.runAndNotifyConfig,
      target.runAndNotifyConfig,
      targetRunOverride?.runAndNotifyConfig,
    ),
  );
}

export function materializeStateConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly analysisId: string;
}): JsonObject {
  const analysis = findById(input.manifest.analyses, input.analysisId, 'analysis');
  return deepMergeObjects(input.manifest.defaults?.state, analysis.defaults?.state);
}

export function materializeReportsConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly analysisId: string;
}): JsonObject {
  const analysis = findById(input.manifest.analyses, input.analysisId, 'analysis');
  return deepMergeObjects(input.manifest.defaults?.reports, analysis.defaults?.reports);
}

export function deepMergeObjects(...inputs: readonly (JsonObject | undefined)[]): JsonObject {
  let result: JsonObject = {};
  for (const input of inputs) {
    if (input !== undefined) {
      result = deepMerge(result, input) as JsonObject;
    }
  }
  return result;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: JsonObject = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }

  return override;
}

function deepMergeCommonMatchers(
  ...inputs: readonly (PortfolioCommonMatchers | undefined)[]
): PortfolioCommonMatchers {
  const result: {
    pre: JsonObject[];
    post: JsonObject[];
  } = {
    pre: [],
    post: [],
  };
  for (const input of inputs) {
    result.pre.push(...(input?.pre ?? []));
    result.post.push(...(input?.post ?? []));
  }
  return result;
}

function applyCommonMatchers(
  config: JsonObject,
  commonMatchers: PortfolioCommonMatchers,
): JsonObject {
  if ((commonMatchers.pre?.length ?? 0) === 0 && (commonMatchers.post?.length ?? 0) === 0) {
    return config;
  }
  const { channels } = config as JsonObject & { readonly channels?: unknown };
  if (!Array.isArray(channels)) {
    return config;
  }
  return {
    ...config,
    channels: channels.map((channel) => applyCommonMatchersToChannel(channel, commonMatchers)),
  };
}

function applyCommonMatchersToChannel(
  channel: unknown,
  commonMatchers: PortfolioCommonMatchers,
): unknown {
  if (!isPlainObject(channel)) {
    return channel;
  }
  const { matchers: channelMatchers } = channel as JsonObject & {
    readonly matchers?: unknown;
  };
  const existingMatchers = Array.isArray(channelMatchers) ? channelMatchers : [];
  return {
    ...channel,
    matchers: [...(commonMatchers.pre ?? []), ...existingMatchers, ...(commonMatchers.post ?? [])],
  };
}

function ensureNotificationName(target: PortfolioTarget, config: JsonObject): JsonObject {
  const { name } = config as JsonObject & { readonly name?: unknown };
  return name === undefined ? { ...config, name: target.name } : config;
}

function validatePortfolioSemantics(manifest: PortfolioManifest, manifestPath: string): void {
  const analysisIds = new Set<string>();
  for (const analysis of manifest.analyses) {
    ensureUniqueId(analysis.id, analysisIds, manifestPath, 'analysis');
    validateAnalysisSemantics(analysis, manifestPath);
  }
}

function validateAnalysisSemantics(analysis: PortfolioAnalysis, manifestPath: string): void {
  validateUniqueCollection(analysis.runs ?? [], manifestPath, `analysis ${analysis.id} run`);
  validateUniqueCollection(analysis.rollups ?? [], manifestPath, `analysis ${analysis.id} rollup`);
  validateUniqueCollection(
    analysis.maintenance ?? [],
    manifestPath,
    `analysis ${analysis.id} maintenance`,
  );

  const runIds = new Set((analysis.runs ?? []).map((run) => run.id));
  const targetIds = new Set<string>();
  for (const target of analysis.targets) {
    ensureUniqueId(target.id, targetIds, manifestPath, `analysis ${analysis.id} target`);
    validateTargetSemantics({ analysis, target, manifestPath, runIds });
  }
}

function validateTargetSemantics(input: {
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
  readonly manifestPath: string;
  readonly runIds: ReadonlySet<string>;
}): void {
  if (input.target.status === 'archived' && input.target.endedOn === undefined) {
    throw new Error(
      `Invalid portfolio manifest ${input.manifestPath}: archived target ${input.analysis.id}/${input.target.id} requires endedOn`,
    );
  }

  for (const override of input.target.runs ?? []) {
    if (!input.runIds.has(override.runId)) {
      throw new Error(
        `Invalid portfolio manifest ${input.manifestPath}: target ${input.analysis.id}/${input.target.id} overrides unknown run ${override.runId}`,
      );
    }
  }
}

function validateUniqueCollection(
  values: readonly { readonly id: string }[],
  manifestPath: string,
  label: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    ensureUniqueId(value.id, ids, manifestPath, label);
  }
}

function ensureUniqueId(id: string, ids: Set<string>, manifestPath: string, label: string): void {
  if (ids.has(id)) {
    throw new Error(`Invalid portfolio manifest ${manifestPath}: duplicate ${label} id ${id}`);
  }
  ids.add(id);
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

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
