import type { ChannelConfig, EvidenceMessage } from '../types.js';

type EvidenceReferenceMessage = Pick<
  EvidenceMessage,
  'channelId' | 'ts' | 'threadTs' | 'messageId' | 'userId'
> & {
  readonly runId?: string | undefined;
  readonly id?: string | undefined;
};

export function formatSlackHttpLink(
  evidence: EvidenceReferenceMessage,
  workspaceUrl: string,
): string {
  const normalizedWorkspaceUrl = workspaceUrl.replace(/\/+$/u, '');
  const messageUrl = `${normalizedWorkspaceUrl}/archives/${evidence.channelId}/p${evidence.ts.replace('.', '')}`;
  if (!evidence.threadTs || evidence.threadTs === evidence.ts) {
    return messageUrl;
  }
  return `${messageUrl}?${new URLSearchParams({ thread_ts: evidence.threadTs }).toString()}`;
}

export function canonicalizeSlackEvidenceLinks(
  text: string,
  evidence: readonly EvidenceReferenceMessage[],
  workspaceUrl: string,
): string {
  const canonicalLinksByMessageUrl = new Map<string, string>();
  for (const message of evidence) {
    const canonicalLink = formatSlackHttpLink(message, workspaceUrl);
    canonicalLinksByMessageUrl.set(canonicalLink.split('?')[0] ?? canonicalLink, canonicalLink);
  }

  const normalizedWorkspaceUrl = workspaceUrl.replace(/\/+$/u, '');
  const escapedWorkspaceUrl = escapeRegExp(normalizedWorkspaceUrl);
  const slackPermalinkPattern = new RegExp(
    `${escapedWorkspaceUrl}/archives/[^\\s/\\])>"']+/p\\d+(?:\\?thread_ts=\\d+(?:\\.\\d+)?(?:&cid=[A-Z0-9]+)?)?`,
    'gu',
  );

  return text.replace(slackPermalinkPattern, (link) => {
    const messageUrl = link.split('?')[0] ?? link;
    return canonicalLinksByMessageUrl.get(messageUrl) ?? link;
  });
}

export function formatSlackReference(
  evidence: EvidenceReferenceMessage,
  channel: ChannelConfig | undefined,
): string {
  const parts = [
    'slack-reference',
    `channel=${evidence.channelId}`,
    `ts=${evidence.ts}`,
    ...(evidence.threadTs ? [`thread_ts=${evidence.threadTs}`] : []),
    ...(evidence.messageId ? [`message_id=${evidence.messageId}`] : []),
    ...(evidence.userId ? [`user=${evidence.userId}`] : []),
    ...(evidence.runId ? [`run=${evidence.runId}`] : []),
    ...(evidence.id ? [`evidence=${evidence.id}`] : []),
  ];
  const label = channel?.name ? `${evidence.channelId} (${channel.name})` : evidence.channelId;
  return `${label} ${parts.join(' ')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
