import { logMessageText, type MessageLogContext } from '../log-context.js';
import { logger } from '../logger.js';
import { mentionsUser } from '../matching/matchers.js';
import {
  classifyWithProvider,
  cosineSimilarity,
  embedText,
  mergeClassifierConfig,
  mergeEmbeddingsConfig,
} from '../scoring/providers.js';
import { classifyScore } from '../scoring/ranges.js';
import type {
  ClassifierConfig,
  EmbeddingsConfig,
  ProviderScoringConfig,
  ScoreThresholds,
  SlackMessage,
  SyntheticRelation,
  SyntheticThreadsConfig,
} from '../types.js';

const defaultWeights = {
  semanticSimilarityWeight: 0,
  lexicalOverlapWeight: 0.55,
  sameAuthorOrMentionWeight: 0.2,
  temporalProximityWeight: 0.2,
  channelTopicMatchWeight: 0.05,
};
const defaultCandidateWindowMinutes = 60;

export function classifySyntheticScore(
  score: number,
  config: { readonly thresholds?: ScoreThresholds | undefined } | undefined,
): 'unrelated' | 'ambiguous' | 'related' {
  return classifyScore(score, config);
}

export function findSyntheticRelatedMessages(
  anchor: SlackMessage,
  candidates: readonly SlackMessage[],
  config: SyntheticThreadsConfig | undefined,
): readonly SyntheticRelation[] {
  if (config?.enabled === false || !isTopLevelSlackMessage(anchor)) {
    return [];
  }

  const related: SyntheticRelation[] = [];
  for (const candidate of candidates) {
    if (!isSyntheticCandidate(anchor, candidate)) {
      continue;
    }

    const score = scoreCandidate(anchor, candidate, config);
    if (classifySyntheticScore(score, config) === 'related') {
      related.push({
        message: candidate,
        score,
        reason: 'deterministic lexical, author, mention, keyword, and temporal features',
        method: 'heuristic',
      });
    }
  }

  return related.sort((left, right) => right.score - left.score);
}

export async function findSyntheticRelatedMessagesWithProviders(
  anchor: SlackMessage,
  candidates: readonly SlackMessage[],
  config: SyntheticThreadsConfig | undefined,
  defaults: ProviderScoringConfig | undefined,
  logContext?: SyntheticLogContext,
): Promise<readonly SyntheticRelation[]> {
  if (config?.enabled === false || !isTopLevelSlackMessage(anchor)) {
    return [];
  }

  const syntheticConfig = config ?? {};
  const embeddings = mergeEmbeddingsConfig(defaults?.embeddings, syntheticConfig.embeddings);
  const classifier = mergeClassifierConfig(defaults?.classifier, syntheticConfig.classifier);
  const related: SyntheticRelation[] = [];
  for (const candidate of candidates) {
    const relation = await syntheticRelationWithProviders(
      anchor,
      candidate,
      syntheticConfig,
      embeddings,
      classifier,
      logContext,
    );
    if (relation) {
      related.push(relation);
    }
  }

  return related.sort((left, right) => right.score - left.score);
}

async function syntheticRelationWithProviders(
  anchor: SlackMessage,
  candidate: SlackMessage,
  config: SyntheticThreadsConfig,
  embeddings: EmbeddingsConfig | undefined,
  classifier: ClassifierConfig | undefined,
  logContext: SyntheticLogContext | undefined,
): Promise<SyntheticRelation | null> {
  if (!isSyntheticCandidate(anchor, candidate)) {
    return null;
  }

  const score = await scoreCandidateWithProviders(anchor, candidate, config, embeddings);
  const range = classifySyntheticScore(score, config);
  const classifierEnabled =
    classifier?.enabled && (classifier.useForRanges ?? ['ambiguous']).includes(range);
  const finalRange = classifierEnabled
    ? await classifyWithProvider(syntheticThreadPrompt(anchor, candidate, score, range), classifier)
    : range;
  logger.debug(
    {
      workspaceId: logContext?.workspaceId,
      channelId: anchor.channelId,
      anchorUserId: anchor.userId,
      candidateUserId: candidate.userId,
      anchorTs: anchor.ts,
      candidateTs: candidate.ts,
      anchorText: logMessageText(anchor, logContext),
      candidateText: logMessageText(candidate, logContext),
      score,
      range,
      finalRange,
      thresholds: config.thresholds,
      embeddings: providerLogContext(embeddings),
      classifier: providerLogContext(classifier),
    },
    'synthetic thread candidate scored',
  );

  if (finalRange !== 'related') {
    return null;
  }

  return {
    message: candidate,
    score,
    reason: syntheticRelationReason(classifierEnabled, embeddings),
    method: classifierEnabled ? 'classifier' : embeddings?.enabled ? 'embedding' : 'heuristic',
  };
}

type SyntheticLogContext = MessageLogContext;

export function isTopLevelSlackMessage(message: SlackMessage): boolean {
  return !message.threadTs || message.threadTs === message.ts;
}

function isSyntheticCandidate(anchor: SlackMessage, candidate: SlackMessage): boolean {
  if (candidate.ts === anchor.ts && candidate.channelId === anchor.channelId) {
    return false;
  }

  return isTopLevelSlackMessage(candidate);
}

function syntheticRelationReason(
  classifierEnabled: boolean | undefined,
  embeddings: EmbeddingsConfig | undefined,
): string {
  if (classifierEnabled) {
    return 'classifier-assisted synthetic relation';
  }

  return embeddings?.enabled
    ? 'embedding-assisted synthetic relation'
    : 'deterministic lexical, author, mention, keyword, and temporal features';
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

export function scoreCandidate(
  anchor: SlackMessage,
  candidate: SlackMessage,
  config: SyntheticThreadsConfig | undefined,
): number {
  const weights = { ...defaultWeights, ...config?.scoring };
  const lexical = lexicalOverlap(anchor.text, candidate.text);
  const sameAuthorOrMention =
    anchor.userId && candidate.userId && anchor.userId === candidate.userId
      ? 1
      : anchor.userId && mentionsUser(candidate.text, anchor.userId)
        ? 1
        : 0;
  const temporal = temporalProximity(
    anchor.ts,
    candidate.ts,
    config?.candidateWindowMinutes ?? defaultCandidateWindowMinutes,
  );
  const keyword = containsAny(candidate.text, config?.heuristics?.keywords ?? []) ? 1 : 0;
  const replyMarker = containsAny(candidate.text, config?.heuristics?.messageHasReplyMarkers ?? [])
    ? 1
    : 0;
  const channelTopic = Math.max(keyword, replyMarker);

  return clamp(
    lexical * weights.lexicalOverlapWeight +
      sameAuthorOrMention * weights.sameAuthorOrMentionWeight +
      temporal * weights.temporalProximityWeight +
      channelTopic * weights.channelTopicMatchWeight,
  );
}

export async function scoreCandidateWithProviders(
  anchor: SlackMessage,
  candidate: SlackMessage,
  config: SyntheticThreadsConfig | undefined,
  embeddings: ReturnType<typeof mergeEmbeddingsConfig>,
): Promise<number> {
  const weights = { ...defaultWeights, ...config?.scoring };
  const heuristicScore = scoreCandidate(anchor, candidate, {
    ...config,
    scoring: {
      ...config?.scoring,
      semanticSimilarityWeight: 0,
    },
  });
  const semanticWeight = weights.semanticSimilarityWeight ?? 0;
  if (!embeddings?.enabled || semanticWeight <= 0) {
    return heuristicScore;
  }

  const [anchorEmbedding, candidateEmbedding] = await Promise.all([
    embedText(anchor.text, embeddings),
    embedText(candidate.text, embeddings),
  ]);

  return clamp(
    heuristicScore + cosineSimilarity(anchorEmbedding, candidateEmbedding) * semanticWeight,
  );
}

function syntheticThreadPrompt(
  anchor: SlackMessage,
  candidate: SlackMessage,
  score: number,
  range: string,
): string {
  return [
    'Classify whether the candidate Slack message belongs to the same discussion as the anchor.',
    'Return exactly one word: related, ambiguous, or unrelated.',
    '',
    `Heuristic score: ${score.toFixed(4)}`,
    `Heuristic range: ${range}`,
    `Anchor: ${anchor.text}`,
    `Candidate: ${candidate.text}`,
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

function temporalProximity(leftTs: string, rightTs: string, windowMinutes: number): number {
  const left = Number(leftTs);
  const right = Number(rightTs);
  if (!Number.isFinite(left) || !Number.isFinite(right) || windowMinutes <= 0) {
    return 0;
  }

  const distanceSeconds = Math.abs(left - right);
  return clamp(1 - distanceSeconds / (windowMinutes * 60));
}

function containsAny(text: string, needles: readonly string[]): boolean {
  const source = text.toLowerCase();
  return needles.some((needle) => source.includes(needle.toLowerCase()));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
