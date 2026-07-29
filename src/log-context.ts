import type { SlackMessage } from './types.js';

const defaultTextLimit = 500;

export type MessageLogContext = {
  readonly workspaceId?: string | null | undefined;
  readonly textLimit?: number | undefined;
};

export function logMessageText(
  message: SlackMessage,
  context: MessageLogContext | undefined,
): string {
  return truncate(message.text, context?.textLimit ?? defaultTextLimit);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit))}...`;
}
