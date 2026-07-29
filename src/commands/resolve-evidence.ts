import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig } from '../config/load-config.js';
import { formatSlackHttpLink, formatSlackReference } from '../slack/evidence-reference.js';
import {
  type EvidenceRecord,
  flattenEvidenceMessages,
  openStateStore,
  type StateStore,
} from '../state/state-store.js';
import type { ChannelConfig } from '../types.js';
import { type ConfigArgv, withConfigOption } from './shared.js';

type ResolveEvidenceOutput = 'link' | 'json';

type ResolveEvidenceArgv = ConfigArgv & {
  readonly id: string;
  readonly output: ResolveEvidenceOutput;
};

type EvidenceReference = {
  readonly resolvedBy: 'evidenceId' | 'messageId';
  readonly evidenceId: string;
  readonly topicId: string;
  readonly runId: string;
  readonly channelId: string;
  readonly channelName?: string | undefined;
  readonly channelKind?: ChannelConfig['kind'] | undefined;
  readonly ts: string;
  readonly threadTs?: string | undefined;
  readonly messageId?: string | undefined;
  readonly userId?: string | undefined;
  readonly source: EvidenceRecord['source'];
  readonly text: string;
  readonly statePath: string;
  readonly slackReference: string;
  readonly slackHttpLink: string;
};

export const resolveEvidenceCommand: CommandModule<object, ResolveEvidenceArgv> = {
  command: 'resolve-evidence',
  describe: 'resolve persisted evidence to a Slack message reference',
  builder: (argv) =>
    withConfigOption(argv)
      .option('id', {
        type: 'string',
        demandOption: true,
        describe: 'Evidence id to resolve, either run-id:index or a unique messageId',
      })
      .option('output', {
        choices: ['link', 'json'] as const,
        default: 'link' as const,
        describe: 'Output format',
      }) as Argv<ResolveEvidenceArgv>,
  handler: async (argv) => {
    const resolved = await loadConfig(argv.config);
    const resolvedRecord = resolveEvidenceFromState({
      configPath: resolved.configPath,
      primaryStatePath: resolved.config.storage.statePath,
      topicId: resolved.topicId,
      id: argv.id,
    });

    const reference = buildEvidenceReference(
      resolvedRecord.evidence,
      resolved.config.channels.find((channel) => channel.id === resolvedRecord.evidence.channelId),
      resolvedRecord.resolvedBy,
      resolvedRecord.statePath,
      resolved.config.workspaceUrl,
    );

    if (argv.output === 'json') {
      console.log(JSON.stringify(reference, null, 2));
      return;
    }

    console.log(reference.slackHttpLink);
  },
};

function buildEvidenceReference(
  evidence: EvidenceRecord,
  channel: ChannelConfig | undefined,
  resolvedBy: EvidenceReference['resolvedBy'],
  statePath: string,
  workspaceUrl: string,
): EvidenceReference {
  return {
    resolvedBy,
    evidenceId: evidence.id,
    topicId: evidence.topicId,
    runId: evidence.runId,
    channelId: evidence.channelId,
    ...(channel?.name ? { channelName: channel.name } : {}),
    ...(channel?.kind ? { channelKind: channel.kind } : {}),
    ts: evidence.ts,
    ...(evidence.threadTs ? { threadTs: evidence.threadTs } : {}),
    ...(evidence.messageId ? { messageId: evidence.messageId } : {}),
    ...(evidence.userId ? { userId: evidence.userId } : {}),
    source: evidence.source,
    text: evidence.text,
    statePath,
    slackHttpLink: formatSlackHttpLink(evidence, workspaceUrl),
    slackReference: formatSlackReference(evidence, channel),
  };
}

function resolveEvidenceFromState(input: {
  readonly configPath: string;
  readonly primaryStatePath: string;
  readonly topicId: string;
  readonly id: string;
}): {
  readonly evidence: EvidenceRecord;
  readonly resolvedBy: EvidenceReference['resolvedBy'];
  readonly statePath: string;
} {
  const stores = candidateStatePaths(input).map((statePath) => ({
    statePath,
    store: openExistingStateStore(statePath, input.topicId),
  }));
  const searchedStatePaths: string[] = [];

  for (const { statePath, store } of stores) {
    if (!store) {
      continue;
    }

    searchedStatePaths.push(statePath);
    const resolved = findEvidenceRecord(store, input.id);
    if (resolved.kind === 'found') {
      return {
        evidence: resolved.evidence,
        resolvedBy: resolved.resolvedBy,
        statePath,
      };
    }

    if (resolved.kind === 'ambiguous') {
      throw new Error(
        `Evidence message id is ambiguous: ${input.id} matched ${resolved.count} evidence records in ${statePath}`,
      );
    }
  }

  const suffix =
    searchedStatePaths.length > 0 ? ` Searched state files: ${searchedStatePaths.join(', ')}` : '';
  throw new Error(`Evidence id or message id not found: ${input.id}.${suffix}`);
}

function candidateStatePaths(input: {
  readonly configPath: string;
  readonly primaryStatePath: string;
  readonly topicId: string;
}): readonly string[] {
  const configAdjacentStatePath = path.resolve(
    path.dirname(input.configPath),
    `state-${input.topicId}.json`,
  );
  return [...new Set([input.primaryStatePath, configAdjacentStatePath])];
}

function openExistingStateStore(statePath: string, topicId: string): StateStore | null {
  return existsSync(statePath) ? openStateStore(statePath, topicId) : null;
}

function findEvidenceRecord(
  store: Pick<StateStore, 'state'>,
  id: string,
):
  | {
      readonly kind: 'found';
      readonly evidence: EvidenceRecord;
      readonly resolvedBy: EvidenceReference['resolvedBy'];
    }
  | { readonly kind: 'ambiguous'; readonly count: number }
  | { readonly kind: 'missing' } {
  const evidenceMessages = flattenEvidenceMessages(store.state);
  const evidenceIdMatch = evidenceMessages.find((message) => message.id === id);
  if (evidenceIdMatch) {
    return { kind: 'found', evidence: evidenceIdMatch, resolvedBy: 'evidenceId' };
  }

  const messageIdMatches = evidenceMessages.filter((message) => message.messageId === id);
  const [messageIdMatch] = messageIdMatches;
  if (messageIdMatches.length === 1 && messageIdMatch) {
    return { kind: 'found', evidence: messageIdMatch, resolvedBy: 'messageId' };
  }

  if (messageIdMatches.length > 1) {
    return { kind: 'ambiguous', count: messageIdMatches.length };
  }

  return { kind: 'missing' };
}
