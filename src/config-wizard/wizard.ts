import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkbox,
  confirm,
  editor,
  input,
  number as numberPrompt,
  search,
  select,
} from '@inquirer/prompts';
import chalk from 'chalk';
import { loadConfig, validateRawConfig } from '../config/load-config.js';
import { type DateRange, hasDateRange, localDateForSlackTs } from '../date-range.js';
import { type GenerateModelText, generateModelText } from '../llm/generate.js';
import { extractReportSection } from '../llm/markdown-schema.js';
import { compilePrompts } from '../llm/prompt.js';
import { matchesWithProviders, scoreScoredMatcher } from '../matching/matchers.js';
import { type PreparedAnalysisRuntime, prepareAnalysisRuntime } from '../runtime/analysis.js';
import {
  channelLabel,
  readSlacrawlDirectory,
  type SlacrawlChannelInfo,
  type SlacrawlDirectory,
  type SlacrawlUserInfo,
  userLabel,
} from '../slacrawl/directory.js';
import { openSlacrawlDatabase, readLatestCursor } from '../slacrawl/slacrawl-db.js';
import { classifySyntheticScore, scoreCandidate } from '../synthetic/synthetic-thread.js';
import type {
  AppConfig,
  ChannelConfig,
  ClassifierConfig,
  ConfiguredUser,
  EmbeddingsConfig,
  MatcherConfig,
  PositiveMatcherConfig,
  ResolvedConfig,
} from '../types.js';
import { parseJsonObject } from '../utils/json.js';
import { resolveLocalTimeZone } from '../utils/local-time.js';
import { resolveFromConfig, topicIdFromConfigPath } from '../utils/paths.js';
import { formatMatchPreview, renderMarkdownReport } from './preview.js';
import { schemaDescription } from './schema-help.js';
import { suggestScoredMatcher } from './suggestions.js';

export type CreateConfigOptions = {
  readonly reference: string;
  readonly output?: string | undefined;
  readonly dateRange?: DateRange | undefined;
};

export type EditConfigOptions = {
  readonly config: string;
  readonly reference?: string | undefined;
  readonly dateRange?: DateRange | undefined;
  readonly now?: Date | undefined;
};

export type PromptApi = {
  readonly input: typeof input;
  readonly confirm: typeof confirm;
  readonly select: typeof select;
  readonly checkbox: typeof checkbox;
  readonly editor: typeof editor;
  readonly number: typeof numberPrompt;
  readonly search: typeof search;
};

export type CreateConfigResult = {
  readonly outputPath: string;
  readonly config: AppConfig;
  readonly previewRan: boolean;
  readonly dryRunCalledModel: boolean;
};

export type EditConfigResult = CreateConfigResult & {
  readonly backupPath: string;
};

const defaultPrompts: PromptApi = {
  input,
  confirm,
  select,
  checkbox,
  editor,
  number: numberPrompt,
  search,
};

type DryRunReportDecision = 'called_model' | 'skip' | 'edit';

export async function runCreateConfigWizard(
  options: CreateConfigOptions,
  prompts: PromptApi = defaultPrompts,
  generateText: GenerateModelText = generateModelText,
): Promise<CreateConfigResult> {
  const referenceText = await readFile(options.reference, 'utf8');
  const referenceConfig = validateRawConfig(
    parseJsonObject(referenceText, options.reference),
    options.reference,
  );
  const referenceResolved = await loadConfig(options.reference);
  const outputPath = await resolveOutputPath(options, prompts);
  const directory = readDirectory(referenceResolved, referenceConfig.channels ?? []);
  const outputDir = path.dirname(outputPath);

  const promptsConfig = await promptForPrompts(
    referenceConfig,
    options.reference,
    outputDir,
    prompts,
  );
  const model = await promptForModel(referenceConfig, prompts);
  let previewRan = false;
  let dryRunCalledModel = false;
  let configReference = referenceConfig;

  while (true) {
    const channels = await promptForChannels(configReference, directory, prompts, generateText);
    const context = await promptForContext(configReference, prompts, generateText);
    const config: AppConfig = stripUndefined({
      workspaceUrl: referenceConfig.workspaceUrl,
      storage: rebaseStoragePaths(referenceConfig.storage, options.reference, outputDir),
      prompts: promptsConfig,
      model,
      channels: channels.length > 0 ? channels : undefined,
      globalMatchers:
        referenceConfig.globalMatchers && referenceConfig.globalMatchers.length > 0
          ? referenceConfig.globalMatchers
          : undefined,
      scoredMatcherDefaults: referenceConfig.scoredMatcherDefaults,
      redaction: referenceConfig.redaction,
      context,
    }) as AppConfig;

    validateRawConfig(config as unknown as Record<string, unknown>, outputPath);
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    if (
      !(await prompts.confirm({
        message: 'Test the final configuration on real messages?',
        default: true,
      }))
    ) {
      return {
        outputPath,
        config,
        previewRan,
        dryRunCalledModel,
      };
    }

    const resolved = await loadConfig(outputPath);
    const previewDateRange = await resolvePreviewDateRange(options.dateRange, resolved, prompts);
    if (!previewDateRange) {
      return {
        outputPath,
        config,
        previewRan,
        dryRunCalledModel,
      };
    }

    previewRan = true;
    const prepared = await prepareAnalysisRuntime(resolved, { dateRange: previewDateRange });
    process.stdout.write(formatMatchPreview(prepared));
    const dryRunDecision = await maybeDryRunReport(resolved, prepared, prompts, generateText);
    if (dryRunDecision === 'called_model') {
      dryRunCalledModel = true;
    }
    if (dryRunDecision !== 'edit') {
      return {
        outputPath,
        config,
        previewRan,
        dryRunCalledModel,
      };
    }

    configReference = config;
    process.stdout.write('Returning to channel and context editing.\n');
  }
}

export async function runEditConfigWizard(
  options: EditConfigOptions,
  prompts: PromptApi = defaultPrompts,
  generateText: GenerateModelText = generateModelText,
): Promise<EditConfigResult> {
  const configPath = path.resolve(options.config);
  const referencePath = path.resolve(options.reference ?? options.config);
  const configText = await readFile(configPath, 'utf8');
  const currentConfig = validateRawConfig(parseJsonObject(configText, configPath), configPath);
  const referenceText = await readFile(referencePath, 'utf8');
  const referenceConfig = validateRawConfig(
    parseJsonObject(referenceText, referencePath),
    referencePath,
  );
  const currentResolved = await loadConfig(configPath);
  const directory = readDirectory(currentResolved, [
    ...(referenceConfig.channels ?? []),
    ...(currentConfig.channels ?? []),
  ]);
  let previewRan = false;
  let dryRunCalledModel = false;
  let configReference = currentConfig;

  while (true) {
    const model = await promptForModel(configReference, prompts);
    const scoredMatcherDefaults = await promptForProviderScoringDefaults(
      configReference.scoredMatcherDefaults,
      prompts,
      'scored matcher defaults',
    );
    const channels = await promptForChannels(
      configReference,
      directory,
      prompts,
      generateText,
      referenceConfig,
    );
    const context = await promptForContext(configReference, prompts, generateText);
    const config: AppConfig = stripUndefined({
      ...currentConfig,
      model,
      channels: channels.length > 0 ? channels : undefined,
      scoredMatcherDefaults,
      context,
    }) as AppConfig;

    validateRawConfig(config as unknown as Record<string, unknown>, configPath);
    const backupPath = `${configPath}.${timestampForBackup(options.now ?? new Date())}.bak`;
    await copyFile(configPath, backupPath);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    if (
      !(await prompts.confirm({
        message: 'Test the final configuration on real messages?',
        default: true,
      }))
    ) {
      return { outputPath: configPath, config, backupPath, previewRan, dryRunCalledModel };
    }

    const resolved = await loadConfig(configPath);
    const previewDateRange = await resolvePreviewDateRange(options.dateRange, resolved, prompts);
    if (!previewDateRange) {
      return { outputPath: configPath, config, backupPath, previewRan, dryRunCalledModel };
    }

    previewRan = true;
    const prepared = await prepareAnalysisRuntime(resolved, { dateRange: previewDateRange });
    process.stdout.write(formatMatchPreview(prepared));
    const dryRunDecision = await maybeDryRunReport(resolved, prepared, prompts, generateText);
    if (dryRunDecision === 'called_model') {
      dryRunCalledModel = true;
    }
    if (dryRunDecision !== 'edit') {
      return { outputPath: configPath, config, backupPath, previewRan, dryRunCalledModel };
    }

    configReference = config;
    process.stdout.write('Returning to channel and context editing.\n');
  }
}

async function resolvePreviewDateRange(
  dateRange: DateRange | undefined,
  resolved: ResolvedConfig,
  prompts: PromptApi,
): Promise<DateRange | undefined> {
  if (hasDateRange(dateRange)) {
    return dateRange;
  }

  const fallback = defaultPreviewDateRange(resolved, 2);
  const confirmed = await prompts.confirm({
    message: `No date range was provided. Test only the last 2 local days (${fallback.startDate} through ${fallback.endDate})?`,
    default: true,
  });
  return confirmed ? fallback : undefined;
}

function defaultPreviewDateRange(resolved: ResolvedConfig, days: number): DateRange {
  const localTimeZone = resolveLocalTimeZone();
  const latestCursor = readLatestConfiguredCursor(resolved);
  const endDate = latestCursor
    ? localDateForSlackTs(latestCursor, localTimeZone)
    : localDateForSlackTs(String(Date.now() / 1000), localTimeZone);
  return {
    startDate: shiftIsoDate(endDate, -(days - 1)),
    endDate,
  };
}

function readLatestConfiguredCursor(resolved: ResolvedConfig): string | null {
  const source = openSlacrawlDatabase(resolved.config.storage.slacrawlDatabasePath);
  try {
    return readLatestCursor(
      source,
      resolved.config.channels.map((channel) => channel.id),
    );
  } finally {
    source.close();
  }
}

function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  if (!year || !month || !day) {
    throw new Error(`Cannot shift invalid date: ${date}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

async function resolveOutputPath(
  options: CreateConfigOptions,
  prompts: PromptApi,
): Promise<string> {
  if (options.output) {
    return path.resolve(options.output);
  }

  const defaultName = `${topicIdFromConfigPath(options.reference)}-copy-config.json`;
  const answer = await prompts.input({
    message: 'Output config path',
    default: defaultName,
    validate: (value) => (value.trim().length > 0 ? true : 'Enter an output path.'),
  });
  return path.resolve(answer);
}

export function readDirectory(
  referenceResolved: ResolvedConfig,
  referenceChannels: readonly ChannelConfig[],
): SlacrawlDirectory {
  try {
    return readSlacrawlDirectory(
      referenceResolved.config.storage.slacrawlDatabasePath,
      referenceChannels,
    );
  } catch (error) {
    process.stderr.write(
      chalk.yellow(
        `Unable to inspect slacrawl directory; using reference config only: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      ),
    );
    return {
      channels: referenceChannels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        source: 'reference',
      })),
      users: referenceChannels.flatMap((channel) =>
        (channel.users ?? []).map((user) => ({
          id: user.id,
          name: user.name,
          source: 'reference' as const,
        })),
      ),
      channelUserIds: new Map(
        referenceChannels.map((channel) => [
          channel.id,
          (channel.users ?? []).map((user) => user.id),
        ]),
      ),
    };
  }
}

async function promptForPrompts(
  referenceConfig: AppConfig,
  referencePath: string,
  outputDir: string,
  prompts: PromptApi,
): Promise<AppConfig['prompts']> {
  const references = normalizePrompts(referenceConfig.prompts);
  const selected: string[] = [];
  for (const promptReference of references) {
    if (isBuiltInPrompt(promptReference)) {
      selected.push(promptReference);
      continue;
    }

    const action = await prompts.select({
      message: `Prompt ${promptReference}`,
      default: 'reference',
      choices: [
        { name: 'Reference original path', value: 'reference' },
        { name: 'Copy beside output config', value: 'copy' },
        { name: 'Copy and edit', value: 'edit' },
      ],
    });
    if (action === 'reference') {
      selected.push(rebaseConfigPath(promptReference, referencePath, outputDir));
      continue;
    }

    const sourcePath = resolveFromConfig(referencePath, promptReference);
    const targetRelative = await prompts.input({
      message: 'Copied prompt path relative to output config',
      default: promptReference,
    });
    const targetPath = path.resolve(outputDir, targetRelative);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const content = await readFile(sourcePath, 'utf8');
    const finalContent =
      action === 'edit'
        ? await prompts.editor({ message: `Edit copy of ${promptReference}`, default: content })
        : content;
    await writeFile(targetPath, finalContent, 'utf8');
    selected.push(targetRelative);
  }

  return selected.length === 1 ? (selected[0] ?? references[0] ?? '') : selected;
}

function rebaseStoragePaths(
  storage: AppConfig['storage'],
  referencePath: string,
  outputDir: string,
): AppConfig['storage'] {
  if (!storage) {
    return undefined;
  }

  return {
    ...(storage.slacrawlDatabasePath
      ? {
          slacrawlDatabasePath: rebaseConfigPath(
            storage.slacrawlDatabasePath,
            referencePath,
            outputDir,
          ),
        }
      : {}),
    ...(storage.statePath
      ? { statePath: rebaseConfigPath(storage.statePath, referencePath, outputDir) }
      : {}),
  };
}

function rebaseConfigPath(input: string, referencePath: string, outputDir: string): string {
  if (path.isAbsolute(input) || input === '~' || input.startsWith('~/')) {
    return input;
  }

  const absolute = resolveFromConfig(referencePath, input);
  const relative = path.relative(outputDir, absolute);
  return relative.length > 0 ? relative : path.basename(absolute);
}

export async function promptForModel(
  referenceConfig: AppConfig,
  prompts: PromptApi,
): Promise<AppConfig['model']> {
  if (await prompts.confirm({ message: 'Keep reference model settings?', default: true })) {
    return referenceConfig.model;
  }

  return {
    provider: await prompts.input({
      message: 'Model provider',
      default: referenceConfig.model.provider,
    }),
    model: await prompts.input({ message: 'Model name', default: referenceConfig.model.model }),
    ...(referenceConfig.model.baseUrl === undefined
      ? {}
      : {
          baseUrl: await prompts.input({
            message: 'Provider base URL',
            default: referenceConfig.model.baseUrl,
          }),
        }),
    ...(referenceConfig.model.temperature === undefined
      ? {}
      : {
          temperature: await prompts.number({
            message: 'Temperature',
            default: referenceConfig.model.temperature,
            min: 0,
          }),
        }),
    ...(referenceConfig.model.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: referenceConfig.model.reasoningEffort }),
    ...(referenceConfig.model.maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: await prompts.number({
            message: 'Max output tokens',
            default: referenceConfig.model.maxOutputTokens,
            min: 1,
          }),
        }),
    ...(referenceConfig.model.openrouter === undefined
      ? {}
      : { openrouter: referenceConfig.model.openrouter }),
    ...(referenceConfig.model.failOnInvalidOutput === undefined
      ? {}
      : { failOnInvalidOutput: referenceConfig.model.failOnInvalidOutput }),
  };
}

export async function promptForChannels(
  referenceConfig: AppConfig,
  directory: SlacrawlDirectory,
  prompts: PromptApi,
  generateText: GenerateModelText,
  copySourceConfig: AppConfig = referenceConfig,
): Promise<readonly ChannelConfig[]> {
  const referenceChannelsById = new Map(
    (copySourceConfig.channels ?? []).map((channel) => [channel.id, channel]),
  );
  const currentChannelsById = new Map(
    (referenceConfig.channels ?? []).map((channel) => [channel.id, channel]),
  );
  const referenceRoles = rolesFromChannels([
    ...(copySourceConfig.channels ?? []),
    ...(referenceConfig.channels ?? []),
  ]);
  const selected = new Map(currentChannelsById);
  if (!(await prompts.confirm({ message: 'Start from reference channels?', default: true }))) {
    selected.clear();
  }

  while (await prompts.confirm({ message: 'Add another channel?', default: selected.size === 0 })) {
    const channelConfig = await promptForChannelConfig({
      referenceConfig,
      directory,
      prompts,
      generateText,
      referenceRoles,
      selected,
      referenceChannelsById,
      copySourceChannels: copySourceConfig.channels ?? [],
    });
    selected.set(channelConfig.id, channelConfig);
  }

  await removeSelectedChannels(selected, prompts);
  return [...selected.values()];
}

async function promptForChannelConfig(input: {
  readonly referenceConfig: AppConfig;
  readonly directory: SlacrawlDirectory;
  readonly prompts: PromptApi;
  readonly generateText: GenerateModelText;
  readonly referenceRoles: Set<string>;
  readonly selected: ReadonlyMap<string, ChannelConfig>;
  readonly referenceChannelsById: ReadonlyMap<string, ChannelConfig>;
  readonly copySourceChannels: readonly ChannelConfig[];
}): Promise<ChannelConfig> {
  const channel = await searchChoice(
    input.prompts,
    'Search channel',
    input.directory.channels,
    channelLabel,
  );
  const currentChannel = input.selected.get(channel.id) ?? { id: channel.id };
  const referenceChannel = input.referenceChannelsById.get(channel.id);
  const users = await promptForUsers(
    currentChannel,
    input.referenceRoles,
    input.directory,
    channel,
    input.prompts,
  );
  const matchers = await promptForMatchers(
    input.referenceConfig,
    referenceChannel?.matchers ??
      copyableReferenceMatchers(input.copySourceChannels, channel.id) ??
      currentChannel.matchers ??
      [],
    input.directory,
    channel,
    input.prompts,
    input.generateText,
  );
  return {
    id: channel.id,
    ...(channel.name ? { name: channel.name } : {}),
    ...(channel.kind ? { kind: channel.kind } : {}),
    ...(users.length > 0 ? { users } : {}),
    ...(matchers.length > 0 ? { matchers } : {}),
  };
}

async function removeSelectedChannels(
  selected: Map<string, ChannelConfig>,
  prompts: PromptApi,
): Promise<void> {
  const removeIds = await prompts.checkbox({
    message: 'Remove selected channels? Keep all unselected to proceed to the next step.',
    choices: [...selected.values()].map((channel) => ({
      name: channel.name ? `${channel.name} (${channel.id})` : channel.id,
      value: channel.id,
      checked: false,
    })),
  });
  for (const id of removeIds) {
    selected.delete(id);
  }
}

function copyableReferenceMatchers(
  channels: readonly ChannelConfig[],
  currentChannelId: string,
): readonly MatcherConfig[] | undefined {
  const matchers = channels
    .filter((channel) => channel.id !== currentChannelId)
    .flatMap((channel) => channel.matchers ?? []);
  return matchers.length > 0 ? matchers : undefined;
}

function rolesFromChannels(channels: readonly ChannelConfig[]): Set<string> {
  return new Set(
    channels.flatMap((channel) =>
      (channel.users ?? [])
        .map((user) => user.role)
        .filter((role): role is string => role !== undefined),
    ),
  );
}

async function promptForUsers(
  referenceChannel: ChannelConfig,
  referenceRoles: Set<string>,
  directory: SlacrawlDirectory,
  channel: SlacrawlChannelInfo,
  prompts: PromptApi,
): Promise<readonly ConfiguredUser[]> {
  const selected = new Map((referenceChannel.users ?? []).map((user) => [user.id, user]));
  const knownRoles = new Set([
    ...referenceRoles,
    ...[...selected.values()].map((user) => user.role).filter((role) => role !== undefined),
  ]);

  while (
    await prompts.confirm({
      message: `Add user filter for ${channelPromptLabel(channel)}?`,
      default: true,
    })
  ) {
    const channelId = channel.id;
    const allowedIds = new Set(directory.channelUserIds.get(channelId) ?? []);
    const choices =
      allowedIds.size > 0
        ? directory.users.filter((user) => allowedIds.has(user.id))
        : directory.users;
    const selectableUsers = choices.filter((user) => !selected.has(user.id));
    if (selectableUsers.length === 0) {
      process.stdout.write(
        chalk.dim(`No more users available for ${channelPromptLabel(channel)}.\n`),
      );
      break;
    }
    const user = await searchOptionalChoice(
      prompts,
      `Search user for ${channelPromptLabel(channel)}`,
      selectableUsers,
      userLabel,
      'Cancel adding user filter',
    );
    if (!user) {
      break;
    }
    const role = await promptForRole(prompts, knownRoles, user);
    if (role) {
      knownRoles.add(role);
    }
    selected.set(user.id, {
      id: user.id,
      ...(user.name ? { name: user.name } : {}),
      ...(role ? { role } : {}),
    });
  }

  return [...selected.values()];
}

async function promptForRole(
  prompts: PromptApi,
  knownRoles: Set<string>,
  user: SlacrawlUserInfo,
): Promise<string | undefined> {
  const choices = [
    ...[...knownRoles].toSorted().map((role) => ({ name: role, value: role })),
    { name: 'No role', value: '' },
    { name: 'Add new role', value: '__new__' },
  ];
  const role = await prompts.select({ message: `Role for ${userPromptLabel(user)}`, choices });
  if (role === '__new__') {
    const added = await prompts.input({ message: 'New role label' });
    return added.trim() || undefined;
  }
  return role || undefined;
}

export async function promptForMatchers(
  config: AppConfig,
  referenceMatchers: readonly MatcherConfig[],
  directory: SlacrawlDirectory,
  channel: SlacrawlChannelInfo,
  prompts: PromptApi,
  generateText: GenerateModelText,
): Promise<readonly MatcherConfig[]> {
  const copiedMatchers = await promptForReferenceMatchers(referenceMatchers, channel, prompts);
  const matchers = [...copiedMatchers];
  while (
    await prompts.confirm({
      message: `Add matcher for ${channelPromptLabel(channel)}?`,
      default: matchers.length === 0,
    })
  ) {
    const matcher = await promptForMatcher(config, directory, channel, prompts, generateText);
    if (!matcher) {
      break;
    }
    matchers.push(matcher);
  }
  return matchers;
}

async function promptForReferenceMatchers(
  referenceMatchers: readonly MatcherConfig[],
  channel: SlacrawlChannelInfo,
  prompts: PromptApi,
): Promise<readonly MatcherConfig[]> {
  if (referenceMatchers.length === 0) {
    return [];
  }

  const selected = await prompts.checkbox({
    message: `Copy matchers from reference for ${channelPromptLabel(channel)}`,
    choices: referenceMatchers.map((matcher, index) => ({
      name: matcherSummary(matcher),
      value: index,
      checked: true,
    })),
  });
  return selected.map((index) => structuredClone(readMatcherAt(referenceMatchers, index)));
}

function readMatcherAt(matchers: readonly MatcherConfig[], index: number): MatcherConfig {
  const matcher = matchers[index];
  if (!matcher) {
    throw new Error(`Reference matcher index ${index} is no longer available`);
  }
  return matcher;
}

export async function promptForMatcher(
  config: AppConfig,
  directory: SlacrawlDirectory,
  channel: SlacrawlChannelInfo,
  prompts: PromptApi,
  generateText: GenerateModelText,
  options: { readonly allowExclude: boolean } = { allowExclude: true },
): Promise<MatcherConfig | undefined> {
  const type = await prompts.select({
    message: 'Matcher type',
    choices: [
      { name: 'Text terms', value: 'text' },
      { name: 'Regular expression', value: 'regex' },
      { name: 'Mention', value: 'mention' },
      { name: 'Scored', value: 'scored' },
      ...(options.allowExclude ? [{ name: 'Exclude wrapper', value: 'exclude' }] : []),
      { name: 'Cancel adding matcher', value: 'cancel' },
    ],
  });
  if (type === 'cancel') {
    return undefined;
  }
  const id = await prompts.input({
    message: 'Matcher id',
    validate: (value) => (value.trim().length > 0 ? true : 'Enter a matcher id.'),
  });

  if (type === 'exclude') {
    process.stdout.write(
      'Select the matcher that should suppress messages. When this child matcher matches, the message is excluded from anchor matches and model evidence.\n',
    );
    const matcher = await promptForMatcher(config, directory, channel, prompts, generateText, {
      allowExclude: false,
    });
    if (!matcher) {
      return undefined;
    }
    return {
      id,
      type: 'exclude',
      matcher: assertPositiveMatcher(matcher),
    };
  }
  if (type === 'regex') {
    return promptForRegexMatcher(id, prompts);
  }
  if (type === 'text') {
    return promptForTextMatcher(id, prompts);
  }
  if (type === 'mention') {
    const channelId = channel.id;
    const allowedIds = new Set(directory.channelUserIds.get(channelId) ?? []);
    const users =
      allowedIds.size > 0
        ? directory.users.filter((user) => allowedIds.has(user.id))
        : directory.users;
    const user = await searchChoice(
      prompts,
      `Mentioned user in ${channelPromptLabel(channel)}`,
      users,
      userLabel,
    );
    return { id, type, userId: user.id };
  }

  return promptForScoredMatcher(id, config, prompts, generateText);
}

function assertPositiveMatcher(matcher: MatcherConfig): PositiveMatcherConfig {
  if (matcher.type === 'exclude') {
    throw new Error('Nested exclude matchers are not supported');
  }
  return matcher;
}

async function promptForRegexMatcher(
  id: string,
  prompts: PromptApi,
): Promise<PositiveMatcherConfig> {
  let pattern = '';
  let flags = 'iu';
  while (true) {
    const matcher = {
      id,
      type: 'regex',
      pattern: await prompts.input({ message: 'JavaScript RegExp pattern', default: pattern }),
      flags: await prompts.input({ message: 'RegExp flags', default: flags }),
    } satisfies PositiveMatcherConfig;
    if (await reviewTextMatcher(matcher, prompts)) {
      return matcher;
    }
    pattern = matcher.pattern;
    flags = matcher.flags ?? 'iu';
  }
}

async function promptForTextMatcher(
  id: string,
  prompts: PromptApi,
): Promise<PositiveMatcherConfig> {
  let terms: readonly string[] = [];
  while (true) {
    const matcher = {
      id,
      type: 'text',
      terms: splitLines(
        await prompts.editor({ message: 'Text terms, one per line', default: terms.join('\n') }),
      ),
    } satisfies PositiveMatcherConfig;
    if (await reviewTextMatcher(matcher, prompts)) {
      return matcher;
    }
    terms = matcher.terms;
  }
}

async function promptForScoredMatcher(
  id: string,
  config: AppConfig,
  prompts: PromptApi,
  generateText: GenerateModelText,
): Promise<Extract<PositiveMatcherConfig, { readonly type: 'scored' }>> {
  let question = '';
  let keywords: readonly string[] = [];
  let phrases: readonly string[] = [];
  let patterns: readonly string[] = [];
  if (
    await prompts.confirm({
      message: 'Use the main model to propose scored matcher heuristics?',
      default: false,
    })
  ) {
    const relevantSamples = splitLines(
      await prompts.editor({ message: 'Relevant sample messages, one per line', default: '' }),
    );
    const irrelevantSamples = splitLines(
      await prompts.editor({ message: 'Irrelevant sample messages, one per line', default: '' }),
    );
    if (
      await prompts.confirm({
        message: 'Send these samples to the configured main model for suggestions?',
        default: false,
      })
    ) {
      const suggestion = await suggestScoredMatcher(
        config,
        { relevantSamples, irrelevantSamples },
        generateText,
      );
      question = suggestion.question;
      keywords = suggestion.keywords;
      phrases = suggestion.phrases;
      patterns = suggestion.patterns;
    }
  }

  while (true) {
    const baseMatcher = {
      id,
      type: 'scored',
      question: await prompts.input({ message: 'Question', default: question }),
      heuristics: {
        keywords: splitLines(
          await prompts.editor({ message: 'Keywords, one per line', default: keywords.join('\n') }),
        ),
        phrases: splitLines(
          await prompts.editor({ message: 'Phrases, one per line', default: phrases.join('\n') }),
        ),
        patterns: splitLines(
          await prompts.editor({
            message: 'Regex patterns, one per line',
            default: patterns.join('\n'),
          }),
        ),
      },
    } satisfies Extract<PositiveMatcherConfig, { readonly type: 'scored' }>;
    const providerOverrides = await promptForProviderScoringDefaults(
      {
        embeddings: undefined,
        classifier: undefined,
      },
      prompts,
      `provider overrides for scored matcher ${id}`,
    );
    const matcher = stripUndefined({
      ...baseMatcher,
      embeddings: providerOverrides?.embeddings,
      classifier: providerOverrides?.classifier,
    }) as Extract<PositiveMatcherConfig, { readonly type: 'scored' }>;
    if (await reviewScoredMatcher(matcher, config, prompts)) {
      return matcher;
    }
    question = matcher.question;
    keywords = baseMatcher.heuristics.keywords;
    phrases = baseMatcher.heuristics.phrases;
    patterns = baseMatcher.heuristics.patterns;
  }
}

export async function promptForProviderScoringDefaults(
  current: AppConfig['scoredMatcherDefaults'],
  prompts: PromptApi,
  label: string,
): Promise<AppConfig['scoredMatcherDefaults']> {
  const embeddings = await promptForEmbeddingsConfig(current?.embeddings, prompts, label);
  const classifier = await promptForClassifierConfig(current?.classifier, prompts, label);
  return stripUndefined({ embeddings, classifier }) as AppConfig['scoredMatcherDefaults'];
}

async function promptForEmbeddingsConfig(
  current: EmbeddingsConfig | undefined,
  prompts: PromptApi,
  label: string,
): Promise<EmbeddingsConfig | undefined> {
  if (
    !(await prompts.confirm({
      message: `Customize embeddings for ${label}?`,
      default: current !== undefined,
    }))
  ) {
    return current;
  }
  return stripUndefined({
    enabled: await prompts.confirm({
      message: 'Enable embeddings?',
      default: current?.enabled ?? true,
    }),
    provider: blankToUndefined(
      await prompts.input({
        message: 'Embeddings provider',
        default: current?.provider ?? 'ollama',
      }),
    ),
    model: blankToUndefined(
      await prompts.input({
        message: 'Embeddings model',
        default: current?.model ?? 'nomic-embed-text',
      }),
    ),
    baseUrl: blankToUndefined(
      await prompts.input({ message: 'Embeddings base URL', default: current?.baseUrl ?? '' }),
    ),
    timeoutMs: await prompts.number({
      message: 'Embeddings timeoutMs',
      default: current?.timeoutMs,
      min: 1,
    }),
  }) as EmbeddingsConfig;
}

async function promptForClassifierConfig(
  current: ClassifierConfig | undefined,
  prompts: PromptApi,
  label: string,
): Promise<ClassifierConfig | undefined> {
  if (
    !(await prompts.confirm({
      message: `Customize classifier for ${label}?`,
      default: current !== undefined,
    }))
  ) {
    return current;
  }
  return stripUndefined({
    enabled: await prompts.confirm({
      message: 'Enable classifier?',
      default: current?.enabled ?? true,
    }),
    provider: blankToUndefined(
      await prompts.input({
        message: 'Classifier provider',
        default: current?.provider ?? 'ollama',
      }),
    ),
    model: blankToUndefined(
      await prompts.input({ message: 'Classifier model', default: current?.model ?? 'qwen3:0.6b' }),
    ),
    baseUrl: blankToUndefined(
      await prompts.input({ message: 'Classifier base URL', default: current?.baseUrl ?? '' }),
    ),
    timeoutMs: await prompts.number({
      message: 'Classifier timeoutMs',
      default: current?.timeoutMs,
      min: 1,
    }),
    maxInputMessages: await prompts.number({
      message: 'Classifier max input messages',
      default: current?.maxInputMessages,
      min: 1,
    }),
  }) as ClassifierConfig;
}

async function reviewTextMatcher(
  matcher: PositiveMatcherConfig,
  prompts: PromptApi,
): Promise<boolean> {
  if (
    !(await prompts.confirm({ message: 'Try this matcher on pasted messages?', default: true }))
  ) {
    return true;
  }

  const samples = splitLines(
    await prompts.editor({ message: 'Paste sample messages, one per line' }),
  );
  for (const sample of samples) {
    const matched = await matchesWithProviders(
      { channelId: 'sample', ts: '0', text: sample },
      matcher,
      {},
    );
    process.stdout.write(
      `${matched ? chalk.green('MATCH') : chalk.dim('MISS')} ${highlightSample(sample, matcher)}\n`,
    );
  }
  process.stdout.write(`Final decision: ${matcher.id}\n`);
  return prompts.confirm({
    message: 'Is this matcher OK?',
    default: true,
  });
}

async function reviewScoredMatcher(
  matcher: Extract<PositiveMatcherConfig, { readonly type: 'scored' }>,
  config: AppConfig,
  prompts: PromptApi,
): Promise<boolean> {
  if (
    !(await prompts.confirm({
      message: 'Try this scored matcher on pasted messages?',
      default: true,
    }))
  ) {
    return true;
  }

  const samples = splitLines(
    await prompts.editor({ message: 'Paste sample messages, one per line' }),
  );
  for (const sample of samples) {
    const message = { channelId: 'sample', ts: '0', text: sample };
    const score = scoreScoredMatcher(message, matcher);
    const matched = await matchesWithProviders(message, matcher, config);
    process.stdout.write(
      `${matched ? chalk.green('MATCH') : chalk.dim('MISS')} score=${score.toFixed(3)} ${sample}\n`,
    );
  }
  return prompts.confirm({
    message: 'Is this matcher OK?',
    default: true,
  });
}

async function promptForContext(
  referenceConfig: AppConfig,
  prompts: PromptApi,
  generateText: GenerateModelText,
): Promise<AppConfig['context']> {
  const referenceContext = referenceConfig.context ?? {};
  if (
    !(await prompts.confirm({
      message: 'Customize advanced context and synthetic-thread settings?',
      default: false,
    }))
  ) {
    return referenceConfig.context;
  }

  process.stdout.write(`${schemaDescription(['context', 'maxMessages']) ?? ''}\n`);
  const maxMessages = await prompts.number({
    message: 'Maximum evidence messages',
    default: referenceContext.maxMessages ?? 100,
    min: 1,
  });
  const syntheticThreads = referenceContext.syntheticThreads;
  if (
    await prompts.confirm({ message: 'Try synthetic-thread scoring with samples?', default: false })
  ) {
    const anchor = await prompts.input({ message: 'Anchor message sample' });
    const candidate = await prompts.input({ message: 'Candidate message sample' });
    const score = scoreCandidate(
      { channelId: 'sample', ts: '1000', text: anchor },
      { channelId: 'sample', ts: '1020', text: candidate },
      syntheticThreads,
    );
    process.stdout.write(
      `Synthetic score=${score.toFixed(3)} range=${classifySyntheticScore(score, syntheticThreads)}\n`,
    );
  }
  if (
    await prompts.confirm({
      message: 'Use the main model to suggest synthetic-thread heuristics from samples?',
      default: false,
    })
  ) {
    const samples = await prompts.editor({ message: 'Synthetic-thread sample notes' });
    if (
      await prompts.confirm({
        message: 'Send these samples to the configured main model?',
        default: false,
      })
    ) {
      const output = await generateText({
        config: referenceConfig,
        system:
          'Suggest concise synthetic-thread keywords and reply-marker phrases. Return plain text.',
        prompt: samples,
      });
      process.stdout.write(`${output.text}\n`);
    }
  }

  return stripUndefined({
    ...referenceContext,
    maxMessages,
  }) as AppConfig['context'];
}

async function maybeDryRunReport(
  resolved: ResolvedConfig,
  prepared: Awaited<ReturnType<typeof prepareAnalysisRuntime>>,
  prompts: PromptApi,
  generateText: GenerateModelText,
): Promise<DryRunReportDecision> {
  if (prepared.reason) {
    const continueWithoutReport = await prompts.confirm({
      message: `No test report can be generated because preview found ${formatPreviewReason(
        prepared.reason,
      )}. Continue without a test report?`,
      default: true,
    });
    return continueWithoutReport ? 'skip' : 'edit';
  }

  if (
    !(await prompts.confirm({ message: 'Dry-run analysis model and show report?', default: false }))
  ) {
    return 'skip';
  }

  const { buildRunState } = await import('../state/build-state.js');
  const state = buildRunState({
    runId: 'dry-run',
    config: resolved.config,
    topicId: resolved.topicId,
    generatedAt: new Date().toISOString(),
    previousCursor: prepared.scanStartCursor,
    currentMaxCursor: prepared.scanEndCursor,
    matches: prepared.matches,
    evidence: prepared.evidence,
    previousMemory: prepared.previousMemory,
    localTimeZone: prepared.localTimeZone,
    workspaceId: prepared.workspaceId,
    knownUsers: prepared.knownUsers,
  });
  const compiled = await compilePrompts(resolved.config, state);
  const output = await generateText({
    config: resolved.config,
    system: compiled.system,
    prompt: compiled.prompt,
  });
  const report = extractReportSection(output.text) ?? output.text;
  process.stdout.write(renderMarkdownReport(report));
  return 'called_model';
}

function formatPreviewReason(reason: NonNullable<PreparedAnalysisRuntime['reason']>): string {
  if (reason === 'no_matches') {
    return 'no matched messages';
  }
  return 'no evidence messages in the selected date range';
}

async function searchChoice<T>(
  prompts: PromptApi,
  message: string,
  choices: readonly T[],
  label: (choice: T) => string,
): Promise<T> {
  return prompts.search({
    message,
    source: (term) => {
      const needle = term?.toLowerCase().trim() ?? '';
      return choices
        .filter((choice) => needle.length === 0 || label(choice).toLowerCase().includes(needle))
        .map((choice) => ({ name: label(choice), value: choice }));
    },
  });
}

async function searchOptionalChoice<T>(
  prompts: PromptApi,
  message: string,
  choices: readonly T[],
  label: (choice: T) => string,
  cancelLabel: string,
): Promise<T | undefined> {
  return prompts.search({
    message,
    source: (term) => {
      const needle = term?.toLowerCase().trim() ?? '';
      const found = choices
        .filter((choice) => needle.length === 0 || label(choice).toLowerCase().includes(needle))
        .map((choice) => ({ name: label(choice), value: choice }));
      return [...found, { name: cancelLabel, value: undefined }];
    },
  });
}

function normalizePrompts(prompts: AppConfig['prompts']): readonly string[] {
  return typeof prompts === 'string' ? [prompts] : prompts;
}

function isBuiltInPrompt(promptReference: string): boolean {
  return promptReference.startsWith('@') && promptReference.endsWith('@');
}

function matcherSummary(matcher: MatcherConfig): string {
  if (matcher.type === 'regex') {
    return `${matcher.id}: regex /${matcher.pattern}/${matcher.flags ?? 'iu'}`;
  }
  if (matcher.type === 'text') {
    return `${matcher.id}: text ${matcher.terms.join(', ')}`;
  }
  if (matcher.type === 'mention') {
    return `${matcher.id}: mention ${matcher.userId}`;
  }
  if (matcher.type === 'scored') {
    return `${matcher.id}: scored ${matcher.question}`;
  }
  if (matcher.type === 'exclude') {
    return `${matcher.id}: exclude ${matcherSummary(matcher.matcher)}`;
  }
  return `${matcher.id}: ${matcher.type}`;
}

function timestampForBackup(now: Date): string {
  return now
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
}

function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function channelPromptLabel(channel: SlacrawlChannelInfo): string {
  return `channel ${channel.name ? `${channel.id} (#${channel.name})` : channel.id}`;
}

function userPromptLabel(user: SlacrawlUserInfo): string {
  return `user ${user.name ? `${user.id} (${user.name})` : user.id}`;
}

function splitLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function highlightSample(sample: string, matcher: PositiveMatcherConfig): string {
  if (matcher.type === 'regex') {
    return sample.replace(
      new RegExp(matcher.pattern, withGlobalFlag(matcher.flags ?? 'iu')),
      (match) => chalk.inverse(match),
    );
  }
  if (matcher.type === 'text') {
    let highlighted = sample;
    for (const term of matcher.terms) {
      highlighted = highlighted.replaceAll(new RegExp(escapeRegex(term), 'giu'), (match) =>
        chalk.inverse(match),
      );
    }
    return highlighted;
  }
  return sample;
}

function withGlobalFlag(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  if (value && typeof value === 'object') {
    const stripped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        stripped[key] = stripUndefined(child);
      }
    }
    return stripped;
  }
  return value;
}
