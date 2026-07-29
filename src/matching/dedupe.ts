import type { EvidenceMessage, SlackMessage } from '../types.js';

export function messageKey(message: SlackMessage): string {
  return message.messageId ?? `${message.channelId}:${message.ts}`;
}

export function dedupeEvidence(messages: readonly EvidenceMessage[]): readonly EvidenceMessage[] {
  const indexesByKey = new Map<string, number>();
  const result: EvidenceMessage[] = [];

  for (const message of messages) {
    const key = messageKey(message);
    const existingIndex = indexesByKey.get(key);
    if (existingIndex !== undefined) {
      if (message.source === 'match' && result[existingIndex]?.source !== 'match') {
        result[existingIndex] = { ...message, source: 'match' };
      }
      continue;
    }

    indexesByKey.set(key, result.length);
    result.push(message);
  }

  return result;
}
