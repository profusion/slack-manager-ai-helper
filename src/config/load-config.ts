import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import * as addFormatsModule from 'ajv-formats';
import configSchema from '../../schemas/config.schema.json' with { type: 'json' };
import { isDefaultPromptReference } from '../llm/default-prompts.js';
import { defaultModelRetries } from '../llm/model-config.js';
import { logger } from '../logger.js';
import type {
  AnalysisModelConfig,
  AppConfig,
  ChannelConfig,
  ResolvedAppConfig,
  ResolvedConfig,
} from '../types.js';
import { hashJson, parseJsonObject } from '../utils/json.js';
import {
  defaultStatePath,
  expandHome,
  resolveFromConfig,
  topicIdFromConfigPath,
} from '../utils/paths.js';

const ajv = new Ajv2020({ allErrors: true });
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
addFormats(ajv);

const validateConfig = ajv.compile(configSchema);
const execFileAsync = promisify(execFile);

export class ConfigValidationError extends Error {
  readonly configPath: string;
  readonly validationErrors: readonly ErrorObject[];

  constructor(configPath: string, validationErrors: readonly ErrorObject[]) {
    super(`Invalid config ${configPath}: ${ajv.errorsText([...validationErrors])}`);
    this.name = 'ConfigValidationError';
    this.configPath = configPath;
    this.validationErrors = validationErrors;
  }
}

export class ConfigSemanticsError extends Error {
  readonly configPath: string;

  constructor(configPath: string, message: string) {
    super(`Invalid config ${configPath}: ${message}`);
    this.name = 'ConfigSemanticsError';
    this.configPath = configPath;
  }
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const text = await readFile(configPath, 'utf8');
  const raw = parseJsonObject(text, configPath);

  const config = validateRawConfig(raw, configPath);
  return {
    config: await resolveConfigPaths(config, configPath),
    configPath,
    configHash: hashJson(config),
    topicId: topicIdFromConfigPath(configPath),
  };
}

export function validateRawConfig(raw: Record<string, unknown>, configPath: string): AppConfig {
  if (!validateConfig(raw)) {
    throw new ConfigValidationError(configPath, [...(validateConfig.errors ?? [])]);
  }

  return expandAlsoChannels(raw as AppConfig, configPath);
}

export function expandAlsoChannels(config: AppConfig, configPath: string): AppConfig {
  const channels = config.channels;
  if (channels === undefined || channels.length === 0) {
    return config;
  }

  const seenIds = new Set<string>();
  return {
    ...config,
    channels: channels.flatMap((channel) => expandChannelEntry(channel, seenIds, configPath)),
  };
}

function expandChannelEntry(
  channel: ChannelConfig,
  seenIds: Set<string>,
  configPath: string,
): readonly ChannelConfig[] {
  const primary = channelWithoutAlsoChannels(channel);
  registerExpandedChannelId(primary.id, seenIds, configPath);
  const also = (channel.alsoChannels ?? []).map((entry) => {
    registerExpandedChannelId(entry.id, seenIds, configPath);
    return inheritChannelSettings(entry, primary);
  });
  return [primary, ...also];
}

function channelWithoutAlsoChannels(channel: ChannelConfig): ChannelConfig {
  return {
    id: channel.id,
    ...optionalChannelFields(channel),
  };
}

function inheritChannelSettings(
  also: NonNullable<ChannelConfig['alsoChannels']>[number],
  primary: ChannelConfig,
): ChannelConfig {
  return {
    id: also.id,
    ...(also.name !== undefined ? { name: also.name } : {}),
    ...optionalInheritedKind(also.kind, primary.kind),
    ...(primary.users !== undefined ? { users: primary.users } : {}),
    ...(primary.matchers !== undefined ? { matchers: primary.matchers } : {}),
  };
}

function optionalChannelFields(
  channel: Pick<ChannelConfig, 'name' | 'kind' | 'users' | 'matchers'>,
): Omit<ChannelConfig, 'id' | 'alsoChannels'> {
  return {
    ...(channel.name !== undefined ? { name: channel.name } : {}),
    ...(channel.kind !== undefined ? { kind: channel.kind } : {}),
    ...(channel.users !== undefined ? { users: channel.users } : {}),
    ...(channel.matchers !== undefined ? { matchers: channel.matchers } : {}),
  };
}

function optionalInheritedKind(
  alsoKind: ChannelConfig['kind'],
  primaryKind: ChannelConfig['kind'],
): Pick<ChannelConfig, 'kind'> {
  const kind = alsoKind ?? primaryKind;
  return kind === undefined ? {} : { kind };
}

function registerExpandedChannelId(
  channelId: string,
  seenIds: Set<string>,
  configPath: string,
): void {
  if (seenIds.has(channelId)) {
    throw new ConfigSemanticsError(
      configPath,
      `duplicate channel id ${channelId} after expanding alsoChannels`,
    );
  }
  seenIds.add(channelId);
}

export async function resolveConfigPaths(
  config: AppConfig,
  configPath: string,
): Promise<ResolvedAppConfig> {
  const slacrawlDatabasePath = config.storage?.slacrawlDatabasePath
    ? resolveFromConfig(configPath, config.storage.slacrawlDatabasePath)
    : await readDefaultSlacrawlDatabasePath();
  const channels = config.channels ?? [];

  if (channels.length === 0 && (config.globalMatchers ?? []).length === 0) {
    logger.warn(
      { configPath },
      'config has no channels or globalMatchers; no Slack messages can match',
    );
  }

  return {
    ...config,
    channels,
    context: config.context ?? {},
    model: resolveAnalysisModel(config.model),
    storage: {
      slacrawlDatabasePath,
      statePath: config.storage?.statePath
        ? resolveFromConfig(configPath, config.storage.statePath)
        : defaultStatePath(configPath),
    },
    prompts: normalizePromptPaths(config.prompts).map((promptReference) =>
      isDefaultPromptReference(promptReference)
        ? promptReference
        : resolveFromConfig(configPath, promptReference),
    ),
  };
}

function resolveAnalysisModel(model: AnalysisModelConfig): AnalysisModelConfig {
  return {
    ...model,
    retries: model.retries ?? defaultModelRetries,
    minReportWords: model.minReportWords ?? 25,
    ...(model.fallback === undefined ? {} : { fallback: resolveAnalysisModel(model.fallback) }),
  };
}

function normalizePromptPaths(prompts: AppConfig['prompts']): readonly string[] {
  return typeof prompts === 'string' ? [prompts] : prompts;
}

export async function readDefaultSlacrawlDatabasePath(): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync('slacrawl', ['metadata', '--json'], {
      encoding: 'utf8',
    });
    stdout = typeof result === 'string' ? result : result.stdout;
  } catch (error) {
    throw new Error(
      `Unable to read default slacrawl database path from "slacrawl metadata --json": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const metadata: unknown = JSON.parse(stdout);
  const defaultDatabase = readDefaultDatabasePath(metadata);
  if (!defaultDatabase) {
    throw new Error('slacrawl metadata --json did not include paths.default_database');
  }

  return expandHome(defaultDatabase);
}

function readDefaultDatabasePath(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const paths = (metadata as { readonly paths?: unknown }).paths;
  if (!paths || typeof paths !== 'object') {
    return null;
  }

  const defaultDatabase = (paths as { readonly default_database?: unknown }).default_database;
  return typeof defaultDatabase === 'string' && defaultDatabase.length > 0 ? defaultDatabase : null;
}
