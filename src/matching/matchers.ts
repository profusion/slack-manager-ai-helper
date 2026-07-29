import { logMessageText, type MessageLogContext } from '../log-context.js';
import { logger } from '../logger.js';
import {
  classifyWithProvider,
  cosineSimilarity,
  embedText,
  mergeClassifierConfig,
  mergeEmbeddingsConfig,
} from '../scoring/providers.js';
import { classifyScore } from '../scoring/ranges.js';
import type {
  AppConfig,
  ChannelConfig,
  ConfiguredUser,
  MatchDiagnostic,
  MatcherConfig,
  MatchResult,
  PositiveMatcherConfig,
  SlackMessage,
} from '../types.js';

const defaultScoredMatcherWeights = {
  semanticSimilarityWeight: 0,
  questionSimilarityWeight: 0.15,
  keywordWeight: 0.45,
  phraseWeight: 0.3,
  patternWeight: 0.1,
};

export function findMatches(
  messages: readonly SlackMessage[],
  config: AppConfig,
  logContext?: MatchingLogContext,
): Promise<readonly MatchResult[]> {
  return findMatchesWithProviders(messages, config, logContext);
}

export async function findMatchesWithProviders(
  messages: readonly SlackMessage[],
  config: AppConfig,
  logContext?: MatchingLogContext,
): Promise<readonly MatchResult[]> {
  return (await findMatchesDetailed(messages, config, logContext)).matches;
}

export type MatchDetails = {
  readonly matches: readonly MatchResult[];
  readonly diagnostics: readonly MatchDiagnostic[];
};

export async function findMatchesDetailed(
  messages: readonly SlackMessage[],
  config: AppConfig,
  logContext?: MatchingLogContext,
): Promise<MatchDetails> {
  const configuredChannels = config.channels ?? [];
  const globalMatchers = config.globalMatchers ?? [];
  const channelsById = new Map(configuredChannels.map((channel) => [channel.id, channel]));
  const results: MatchResult[] = [];
  const diagnostics: MatchDiagnostic[] = [];
  let skippedWithoutChannel = 0;
  let skippedByUserFilter = 0;
  let skippedByExcludeMatcher = 0;
  let matcherEvaluations = 0;

  for (const message of messages) {
    const result = await evaluateMessageForMatch({
      message,
      channelsById,
      globalMatchers,
      config,
      logContext,
    });
    diagnostics.push(result.diagnostic);
    matcherEvaluations += result.evaluations;
    if (result.match) {
      results.push(result.match);
    }
    if (!result.diagnostic.matched) {
      skippedWithoutChannel += skipCount(result.diagnostic, 'unconfigured_channel');
      skippedByUserFilter += skipCount(result.diagnostic, 'user_filter');
      skippedByExcludeMatcher += skipCount(result.diagnostic, 'exclude_matcher');
    }
  }

  logger.info(
    {
      workspaceId: logContext?.workspaceId,
      inputMessageCount: messages.length,
      matchedMessageCount: results.length,
      skippedWithoutChannel,
      skippedByUserFilter,
      skippedByExcludeMatcher,
      matcherEvaluations,
    },
    'matching completed',
  );

  return {
    matches: results,
    diagnostics,
  };
}

function skipCount(
  diagnostic: Extract<MatchDiagnostic, { readonly matched: false }>,
  reason: Extract<MatchDiagnostic, { readonly matched: false }>['reason'],
): number {
  return diagnostic.reason === reason ? 1 : 0;
}

async function evaluateMessageForMatch(input: {
  readonly message: SlackMessage;
  readonly channelsById: ReadonlyMap<string, ChannelConfig>;
  readonly globalMatchers: readonly MatcherConfig[];
  readonly config: AppConfig;
  readonly logContext?: MatchingLogContext | undefined;
}): Promise<{
  readonly match?: MatchResult | undefined;
  readonly diagnostic: MatchDiagnostic;
  readonly evaluations: number;
}> {
  const { message, channelsById, globalMatchers, config, logContext } = input;
  const configuredChannel = channelsById.get(message.channelId);
  const channel =
    configuredChannel ??
    (globalMatchers.length > 0 ? fallbackChannelForGlobalMatchers(message.channelId) : undefined);
  if (!channel) {
    logger.debug(
      {
        workspaceId: logContext?.workspaceId,
        channelId: message.channelId,
        userId: message.userId,
        ts: message.ts,
        text: logMessageText(message, logContext),
      },
      'message skipped because channel is not configured',
    );
    return {
      diagnostic: {
        message,
        matched: false,
        reason: 'unconfigured_channel',
        evaluatedMatcherCount: 0,
      },
      evaluations: 0,
    };
  }

  if (!messageBelongsToConfiguredUsers(message, channel)) {
    logger.debug(
      {
        workspaceId: logContext?.workspaceId,
        channelId: message.channelId,
        userId: message.userId,
        ts: message.ts,
        text: logMessageText(message, logContext),
        configuredUserIds: channel.users?.map((user) => user.id) ?? [],
      },
      'message skipped by configured user filter',
    );
    return {
      diagnostic: {
        message,
        matched: false,
        channel,
        reason: 'user_filter',
        evaluatedMatcherCount: 0,
      },
      evaluations: 0,
    };
  }

  const matchers = [...globalMatchers, ...(channel.matchers ?? [])];
  const excludeResult = await evaluateExcludeMatchers(message, matchers, config, logContext);
  if (excludeResult.excluded) {
    return {
      diagnostic: {
        message,
        matched: false,
        channel,
        reason: 'exclude_matcher',
        matcherId: excludeResult.matcher?.id,
        matcherType: excludeResult.matcher?.type,
        evaluatedMatcherCount: excludeResult.evaluations,
      },
      evaluations: excludeResult.evaluations,
    };
  }

  if (configuredChannel && !hasPositiveMatchers(matchers)) {
    const match = {
      message,
      channel,
      matcherId: 'channel',
      matcherType: 'channel' as const,
    };
    logger.debug(
      {
        workspaceId: logContext?.workspaceId,
        channelId: message.channelId,
        userId: message.userId,
        ts: message.ts,
        matcherId: match.matcherId,
        matcherType: match.matcherType,
        text: logMessageText(message, logContext),
      },
      'message matched by configured channel',
    );
    return {
      match,
      diagnostic: {
        ...match,
        matched: true,
        evaluatedMatcherCount: excludeResult.evaluations,
      },
      evaluations: excludeResult.evaluations,
    };
  }

  const positiveResult = await findFirstPositiveMatch(message, matchers, config, logContext);
  const evaluations = excludeResult.evaluations + positiveResult.evaluations;
  if (positiveResult.matcher) {
    const match = {
      message,
      channel,
      matcherId: positiveResult.matcher.id,
      matcherType: positiveResult.matcher.type,
    };
    return {
      match,
      diagnostic: {
        ...match,
        matched: true,
        evaluatedMatcherCount: evaluations,
      },
      evaluations,
    };
  }

  return {
    diagnostic: {
      message,
      matched: false,
      channel,
      reason: 'no_positive_match',
      evaluatedMatcherCount: evaluations,
    },
    evaluations,
  };
}

async function evaluateExcludeMatchers(
  message: SlackMessage,
  matchers: readonly MatcherConfig[],
  config: Pick<AppConfig, 'scoredMatcherDefaults'>,
  logContext?: MatchingLogContext,
): Promise<{
  readonly excluded: boolean;
  readonly matcher?: Extract<MatcherConfig, { readonly type: 'exclude' }> | undefined;
  readonly evaluations: number;
}> {
  let evaluations = 0;
  for (const matcher of matchers.filter(isExcludeMatcher)) {
    evaluations += 1;
    const matched = await positiveMatchesWithProviders(
      message,
      matcher.matcher,
      config,
      logContext,
    );
    logger.debug(
      {
        workspaceId: logContext?.workspaceId,
        channelId: message.channelId,
        userId: message.userId,
        ts: message.ts,
        matcherId: matcher.id,
        matcherType: matcher.type,
        matched,
        text: logMessageText(message, logContext),
      },
      'exclude matcher evaluated',
    );
    if (matched) {
      logger.debug(
        {
          workspaceId: logContext?.workspaceId,
          channelId: message.channelId,
          userId: message.userId,
          ts: message.ts,
          matcherId: matcher.id,
          matcherType: matcher.type,
          text: logMessageText(message, logContext),
        },
        'message skipped by exclude matcher',
      );
      return { excluded: true, matcher, evaluations };
    }
  }

  return { excluded: false, evaluations };
}

async function findFirstPositiveMatch(
  message: SlackMessage,
  matchers: readonly MatcherConfig[],
  config: Pick<AppConfig, 'scoredMatcherDefaults'>,
  logContext?: MatchingLogContext,
): Promise<{
  readonly matcher: PositiveMatcherConfig | undefined;
  readonly evaluations: number;
}> {
  let evaluations = 0;
  for (const matcher of matchers.filter(isPositiveMatcher)) {
    evaluations += 1;
    const matched = await matchesWithProviders(message, matcher, config, logContext);
    logger.debug(
      {
        workspaceId: logContext?.workspaceId,
        channelId: message.channelId,
        userId: message.userId,
        ts: message.ts,
        matcherId: matcher.id,
        matcherType: matcher.type,
        matched,
        text: logMessageText(message, logContext),
      },
      'matcher evaluated',
    );
    if (matched) {
      logger.debug(
        {
          workspaceId: logContext?.workspaceId,
          channelId: message.channelId,
          userId: message.userId,
          ts: message.ts,
          matcherId: matcher.id,
          matcherType: matcher.type,
          text: logMessageText(message, logContext),
        },
        'message matched',
      );
      return { matcher, evaluations };
    }
  }

  return { matcher: undefined, evaluations };
}

function fallbackChannelForGlobalMatchers(channelId: string): ChannelConfig {
  return {
    id: channelId,
    kind: 'unknown',
  };
}

function hasPositiveMatchers(matchers: readonly MatcherConfig[]): boolean {
  return matchers.some(isPositiveMatcher);
}

function messageBelongsToConfiguredUsers(message: SlackMessage, channel: ChannelConfig): boolean {
  const configuredUsers = channel.users ?? [];
  if (configuredUsers.length === 0) {
    return true;
  }

  return Boolean(message.userId && configuredUsers.some((user) => user.id === message.userId));
}

function isExcludeMatcher(
  matcher: MatcherConfig,
): matcher is Extract<MatcherConfig, { readonly type: 'exclude' }> {
  return matcher.type === 'exclude';
}

function isPositiveMatcher(matcher: MatcherConfig): matcher is PositiveMatcherConfig {
  return matcher.type !== 'exclude';
}

export function matches(message: SlackMessage, matcher: MatcherConfig): boolean {
  if (matcher.type === 'exclude') {
    return matches(message, matcher.matcher);
  }

  if (matcher.type === 'regex') {
    const flags = matcher.flags ?? 'iu';
    return new RegExp(matcher.pattern, flags).test(message.text);
  }

  if (matcher.type === 'text') {
    const source = (matcher.caseInsensitive ?? true) ? message.text.toLowerCase() : message.text;
    return matcher.terms.some((term) => {
      const needle = (matcher.caseInsensitive ?? true) ? term.toLowerCase() : term;
      return source.includes(needle);
    });
  }

  if (matcher.type === 'mention') {
    return mentionsUser(message.text, matcher.userId);
  }

  if (matcher.type === 'and') {
    return matcher.matchers.every((nestedMatcher) => matches(message, nestedMatcher));
  }

  if (matcher.type === 'or') {
    return matcher.matchers.some((nestedMatcher) => matches(message, nestedMatcher));
  }

  return classifyScore(scoreScoredMatcher(message, matcher), matcher) === 'related';
}

export async function matchesWithProviders(
  message: SlackMessage,
  matcher: MatcherConfig,
  config: Pick<AppConfig, 'scoredMatcherDefaults'>,
  logContext?: MatchingLogContext,
): Promise<boolean> {
  if (matcher.type === 'exclude') {
    return positiveMatchesWithProviders(message, matcher.matcher, config, logContext);
  }

  return positiveMatchesWithProviders(message, matcher, config, logContext);
}

async function positiveMatchesWithProviders(
  message: SlackMessage,
  matcher: PositiveMatcherConfig,
  config: Pick<AppConfig, 'scoredMatcherDefaults'>,
  logContext?: MatchingLogContext,
): Promise<boolean> {
  if (matcher.type === 'and') {
    return allPositiveMatchersMatch(message, matcher.matchers, config, logContext);
  }

  if (matcher.type === 'or') {
    return anyPositiveMatcherMatches(message, matcher.matchers, config, logContext);
  }

  if (matcher.type !== 'scored') {
    return matches(message, matcher);
  }

  const embeddings = mergeEmbeddingsConfig(
    config.scoredMatcherDefaults?.embeddings,
    matcher.embeddings,
  );
  const classifier = mergeClassifierConfig(
    config.scoredMatcherDefaults?.classifier,
    matcher.classifier,
  );
  const score = await scoreScoredMatcherWithProviders(message, matcher, embeddings);
  const range = classifyScore(score, matcher);
  const scoringLogContext = {
    channelId: message.channelId,
    workspaceId: logContext?.workspaceId,
    userId: message.userId,
    ts: message.ts,
    matcherId: matcher.id,
    matcherType: matcher.type,
    score,
    range,
    text: logMessageText(message, logContext),
    thresholds: matcher.thresholds,
    embeddings: providerLogContext(embeddings),
    classifier: providerLogContext(classifier),
  };

  if (classifier?.enabled && (classifier.useForRanges ?? ['ambiguous']).includes(range)) {
    const classifierRange = await classifyWithProvider(
      scoredMatcherPrompt(message, matcher, score, range),
      classifier,
    );
    logger.info(
      { ...scoringLogContext, classifierRange, matched: classifierRange === 'related' },
      'scored matcher classifier evaluated',
    );
    return classifierRange === 'related';
  }

  logger.debug({ ...scoringLogContext, matched: range === 'related' }, 'scored matcher evaluated');
  return range === 'related';
}

async function allPositiveMatchersMatch(
  message: SlackMessage,
  matchers: readonly PositiveMatcherConfig[],
  config: Pick<AppConfig, 'scoredMatcherDefaults'>,
  logContext?: MatchingLogContext,
): Promise<boolean> {
  for (const matcher of matchers) {
    if (!(await positiveMatchesWithProviders(message, matcher, config, logContext))) {
      return false;
    }
  }
  return true;
}

async function anyPositiveMatcherMatches(
  message: SlackMessage,
  matchers: readonly PositiveMatcherConfig[],
  config: Pick<AppConfig, 'scoredMatcherDefaults'>,
  logContext?: MatchingLogContext,
): Promise<boolean> {
  for (const matcher of matchers) {
    if (await positiveMatchesWithProviders(message, matcher, config, logContext)) {
      return true;
    }
  }
  return false;
}

type MatchingLogContext = MessageLogContext;

export function mentionsUser(text: string, userId: string): boolean {
  return (
    text.includes(`<@${userId}>`) || new RegExp(`(^|\\s)@${escapeRegex(userId)}(\\s|$)`).test(text)
  );
}

export function allConfiguredUsers(channels: readonly ChannelConfig[]): readonly ConfiguredUser[] {
  const users = new Map<string, ConfiguredUser>();
  for (const channel of channels) {
    for (const user of channel.users ?? []) {
      users.set(user.id, user);
    }
  }
  return [...users.values()];
}

export function scoreScoredMatcher(
  message: SlackMessage,
  matcher: Extract<MatcherConfig, { readonly type: 'scored' }>,
): number {
  const weights = { ...defaultScoredMatcherWeights, ...matcher.scoring };
  const questionSimilarity = lexicalOverlap(message.text, matcher.question);
  const keyword = containsAny(message.text, matcher.heuristics?.keywords ?? []) ? 1 : 0;
  const phrase = containsAny(message.text, matcher.heuristics?.phrases ?? []) ? 1 : 0;
  const pattern = matchesAnyPattern(message.text, matcher.heuristics?.patterns ?? []) ? 1 : 0;

  return clamp(
    questionSimilarity * (weights.questionSimilarityWeight ?? 0) +
      keyword * (weights.keywordWeight ?? 0) +
      phrase * (weights.phraseWeight ?? 0) +
      pattern * (weights.patternWeight ?? 0),
  );
}

export async function scoreScoredMatcherWithProviders(
  message: SlackMessage,
  matcher: Extract<MatcherConfig, { readonly type: 'scored' }>,
  embeddings: ReturnType<typeof mergeEmbeddingsConfig>,
): Promise<number> {
  const weights = { ...defaultScoredMatcherWeights, ...matcher.scoring };
  const heuristicScore = scoreScoredMatcher(message, matcher);
  const semanticWeight = weights.semanticSimilarityWeight ?? 0;
  if (!embeddings?.enabled || semanticWeight <= 0) {
    return heuristicScore;
  }

  const questionEmbedding = await embedText(matcher.question, embeddings);
  const messageEmbedding = await embedText(message.text, embeddings);

  return clamp(
    heuristicScore + cosineSimilarity(questionEmbedding, messageEmbedding) * semanticWeight,
  );
}

function scoredMatcherPrompt(
  message: SlackMessage,
  matcher: Extract<MatcherConfig, { readonly type: 'scored' }>,
  score: number,
  range: string,
): string {
  return [
    'Classify whether this Slack message satisfies the matcher question.',
    'Return exactly one word: related, ambiguous, or unrelated.',
    '',
    `Question: ${matcher.question}`,
    `Heuristic score: ${score.toFixed(4)}`,
    `Heuristic range: ${range}`,
    `Message: ${message.text}`,
  ].join('\n');
}

function lexicalOverlap(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length > 2),
  );
}

function containsAny(text: string, needles: readonly string[]): boolean {
  const source = text.toLowerCase();
  return needles.some((needle) => source.includes(needle.toLowerCase()));
}

function matchesAnyPattern(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'iu').test(text));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function providerLogContext(
  config:
    | {
        readonly enabled?: boolean | undefined;
        readonly provider?: string | undefined;
        readonly model?: string | undefined;
        readonly baseUrl?: string | undefined;
        readonly timeoutMs?: number | undefined;
        readonly useForRanges?: readonly string[] | undefined;
      }
    | undefined,
): object | undefined {
  if (!config) {
    return undefined;
  }

  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    useForRanges: config.useForRanges,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
