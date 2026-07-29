import { logMessageText, type MessageLogContext } from '../log-context.js';
import { logger } from '../logger.js';
import { dedupeEvidence, messageKey } from '../matching/dedupe.js';
import {
  readNearbyMessages,
  readThreadMessages,
  type SlacrawlDatabase,
} from '../slacrawl/slacrawl-db.js';
import { findSyntheticRelatedMessagesWithProviders } from '../synthetic/synthetic-thread.js';
import type { AppConfig, EvidenceMessage, MatchResult, SlackMessage } from '../types.js';

const defaultMaxMessages = 100;
const defaultNearbyMessagesBeforeMinutes = 5;
const defaultNearbyMessagesAfterMinutes = 60;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Expansion order is explicit by requirement and easier to verify in one function.
export async function expandEvidence(
  source: SlacrawlDatabase,
  matches: readonly MatchResult[],
  config: AppConfig,
  logContext?: MessageLogContext,
): Promise<readonly EvidenceMessage[]> {
  const evidence: EvidenceMessage[] = [];
  const context = config.context ?? {};
  const maxMessages = context.maxMessages ?? defaultMaxMessages;
  let threadMessageCount = 0;
  let nearbyMessageCount = 0;
  let syntheticRelatedMessageCount = 0;

  for (const match of matches) {
    evidence.push({ ...match.message, source: 'match' });
    logger.debug(
      {
        workspaceId: logContext?.workspaceId,
        channelId: match.message.channelId,
        userId: match.message.userId,
        ts: match.message.ts,
        matcherId: match.matcherId,
        matcherType: match.matcherType,
        text: logMessageText(match.message, logContext),
      },
      'expanding evidence for match',
    );
  }

  for (const match of matches) {
    if (context.includeRealThread ?? true) {
      const threadMessages = readThreadMessages(source, match.message);
      threadMessageCount += threadMessages.length;
      for (const message of threadMessages) {
        evidence.push({ ...message, source: 'thread' });
      }
    }

    const nearby = limitNearbyMessages(
      readNearbyMessages(source, match.message, {
        beforeMinutes: context.nearbyMessagesBeforeMinutes ?? defaultNearbyMessagesBeforeMinutes,
        afterMinutes: context.nearbyMessagesAfterMinutes ?? defaultNearbyMessagesAfterMinutes,
      }),
      match.message,
      maxMessages,
    );
    nearbyMessageCount += nearby.length;
    for (const message of nearby) {
      evidence.push({ ...message, source: 'nearby' });
    }

    if (context.syntheticThreads?.enabled !== false) {
      const syntheticCandidates = nearby.filter(
        (message) => !wouldAlreadyMatchChannel(match, message),
      );
      const relations = await findSyntheticRelatedMessagesWithProviders(
        match.message,
        syntheticCandidates,
        context.syntheticThreads ?? {},
        config.scoredMatcherDefaults,
        logContext,
      );
      syntheticRelatedMessageCount += relations.length;
      for (const relation of relations) {
        evidence.push({ ...relation.message, source: 'synthetic_related' });
      }
    }
  }

  const deduped = dedupeEvidence(evidence);
  logger.info(
    {
      workspaceId: logContext?.workspaceId,
      matchCount: matches.length,
      rawEvidenceMessageCount: evidence.length,
      dedupedEvidenceMessageCount: deduped.length,
      selectedEvidenceMessageCount: deduped.length,
      threadMessageCount,
      nearbyMessageCount,
      syntheticRelatedMessageCount,
      maxNearbyMessagesPerMatch: maxMessages,
    },
    'evidence expansion completed',
  );

  return deduped;
}

function limitNearbyMessages(
  messages: readonly SlackMessage[],
  anchor: SlackMessage,
  maxMessages: number,
): readonly SlackMessage[] {
  if (maxMessages < 1) {
    return [];
  }

  const limited: SlackMessage[] = [];
  let nearbyMessageCount = 0;
  for (const message of messages) {
    if (messageKey(message) === messageKey(anchor)) {
      limited.push(message);
      continue;
    }

    if (nearbyMessageCount >= maxMessages) {
      continue;
    }

    limited.push(message);
    nearbyMessageCount += 1;
  }

  return limited;
}

function wouldAlreadyMatchChannel(match: MatchResult, message: SlackMessage): boolean {
  if (match.matcherType !== 'channel' || match.message.channelId !== message.channelId) {
    return false;
  }

  const configuredUsers = match.channel.users ?? [];
  if (configuredUsers.length === 0) {
    return true;
  }

  return configuredUsers.some((user) => user.id === message.userId);
}
