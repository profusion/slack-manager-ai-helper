import { Ajv2020 } from 'ajv/dist/2020.js';
import stateSchema from '../../schemas/state.schema.json' with { type: 'json' };
import { allConfiguredUsers } from '../matching/matchers.js';
import { formatSlackHttpLink } from '../slack/evidence-reference.js';
import type {
  AppConfig,
  ChannelConfig,
  EvidenceMessage,
  KnownUser,
  MatchResult,
  RunState,
} from '../types.js';
import { formatDateStringForLlm } from '../utils/local-time.js';

const ajv = new Ajv2020({ allErrors: true });
const validateState = ajv.compile(stateSchema);

export function buildRunState(input: {
  readonly runId: string;
  readonly config: AppConfig;
  readonly topicId: string;
  readonly generatedAt: string;
  readonly previousCursor: string | null;
  readonly currentMaxCursor: string | null;
  readonly matches: readonly MatchResult[];
  readonly evidence: readonly EvidenceMessage[];
  readonly previousMemory: string | null;
  readonly localTimeZone: string;
  readonly workspaceId: string | null;
  readonly knownUsers?: readonly KnownUser[] | undefined;
}): RunState {
  const configuredChannels = input.config.channels ?? [];
  const configuredUsers = allConfiguredUsers(configuredChannels);
  const knownUsersById = knownUsersForTimeline(configuredUsers, input.knownUsers ?? []);
  const channelsById = new Map(
    channelsForState(configuredChannels, input.matches).map((channel) => [channel.id, channel]),
  );

  return validateRunState({
    topicId: input.topicId,
    generatedAt: formatDateStringForLlm(input.generatedAt, input.localTimeZone),
    users: configuredUsers,
    timeline: buildTimeline(
      input.evidence,
      channelsById,
      configuredUsers,
      knownUsersById,
      input.localTimeZone,
      input.config.workspaceUrl,
    ),
    previousMemory: {
      content: input.previousMemory,
    },
  });
}

function channelsForState(
  configuredChannels: readonly ChannelConfig[],
  matches: readonly MatchResult[],
): readonly ChannelConfig[] {
  if (configuredChannels.length > 0) {
    return configuredChannels;
  }

  const channelsById = new Map<string, ChannelConfig>();
  for (const match of matches) {
    channelsById.set(match.channel.id, match.channel);
  }

  return [...channelsById.values()];
}

function buildTimeline(
  evidence: readonly EvidenceMessage[],
  channelsById: ReadonlyMap<string, ChannelConfig>,
  configuredUsers: readonly TimelineUser[],
  knownUsersById: ReadonlyMap<string, TimelineUser>,
  localTimeZone: string,
  workspaceUrl: string,
): RunState['timeline'] {
  const days = new Map<string, MutableTimelineDay>();
  const configuredChannelIds = new Set(channelsById.keys());
  const threadAuthorsByDay = new Map<string, Map<string, string>>();

  for (const message of evidence) {
    const local = localMessageTime(message.ts, localTimeZone);
    if (message.userId && isTopLevelMessage(message)) {
      getOrInsert(threadAuthorsByDay, local.date, () => new Map()).set(message.ts, message.userId);
    }
    const day = getOrInsert(days, local.date, () => ({
      date: local.date,
      dayOfWeek: local.dayOfWeek,
      users: new Map(),
      channels: new Map(),
    }));
    const href = formatSlackHttpLink(message, workspaceUrl);
    recordDailyUserActivity(day.users, message, local.time, href, configuredChannelIds);
    const channelConfig = channelsById.get(message.channelId);
    const channel = getOrInsert(day.channels, message.channelId, () => ({
      id: message.channelId,
      ...(channelConfig?.name ? { name: channelConfig.name } : {}),
      kind: channelConfig?.kind ?? 'unknown',
      threads: new Map(),
    }));
    const threadKey = message.threadTs ?? message.ts;
    const thread = getOrInsert(channel.threads, threadKey, () => ({
      messages: [] as MutableTimelineThread['messages'],
    }));
    thread.messages.push(
      formatTimelineMessage(message, local.time, href, knownUsersById.get(message.userId ?? '')),
    );
  }

  return [...days.values()]
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({
      date: day.date,
      dayOfWeek: day.dayOfWeek,
      users: formatDailyUsers(
        configuredUsers,
        day.users,
        threadAuthorsByDay.get(day.date) ?? new Map(),
      ),
      channels: [...day.channels.values()]
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((channel) => ({
          id: channel.id,
          ...(channel.name ? { name: channel.name } : {}),
          kind: channel.kind,
          threads: [...channel.threads.values()].map((thread) => ({
            messages: thread.messages.toSorted((left, right) =>
              left.time.localeCompare(right.time),
            ),
          })),
        })),
    }));
}

function recordDailyUserActivity(
  users: Map<string, MutableDailyUserActivity>,
  message: EvidenceMessage,
  time: string,
  href: string,
  configuredChannelIds: ReadonlySet<string>,
): void {
  if (!message.userId) {
    return;
  }

  const activity = getOrInsert(users, message.userId, () => ({
    firstMessageAt: time,
    channelMessages: 0,
    threadKeys: [],
    totalMessages: 0,
    authoredTopLevelMessages: [],
    authoredReplies: [],
    ownedEvidence: [],
  }));

  if (time < activity.firstMessageAt) {
    activity.firstMessageAt = time;
  }
  if (configuredChannelIds.has(message.channelId) && isTopLevelMessage(message)) {
    activity.channelMessages += 1;
  }
  if (message.threadTs && message.threadTs !== message.ts) {
    activity.threadKeys.push(message.threadTs);
  }
  if (isTopLevelMessage(message)) {
    activity.authoredTopLevelMessages.push(href);
  } else {
    activity.authoredReplies.push(href);
  }
  if (evidenceScope(message) === 'owned') {
    activity.ownedEvidence.push(href);
  }
  activity.totalMessages += 1;
}

function formatDailyUsers(
  configuredUsers: readonly TimelineUser[],
  dayUsers: ReadonlyMap<string, MutableDailyUserActivity>,
  threadAuthors: ReadonlyMap<string, string>,
): RunState['timeline'][number]['users'] {
  return configuredUsers.map((user) => {
    const activity = dayUsers.get(user.id);
    if (!activity) {
      return {
        id: user.id,
        ...(user.name ? { name: user.name } : {}),
        ...(user.role ? { role: user.role } : {}),
        status: 'absent',
      };
    }

    return {
      id: user.id,
      ...(user.name ? { name: user.name } : {}),
      ...(user.role ? { role: user.role } : {}),
      status: 'present',
      firstMessageAt: activity.firstMessageAt,
      channelMessages: activity.channelMessages,
      repliesToOthers: countRepliesToOthers(user.id, activity.threadKeys, threadAuthors),
      totalMessages: activity.totalMessages,
      authoredTopLevelMessages: activity.authoredTopLevelMessages,
      authoredReplies: activity.authoredReplies,
      ownedEvidence: activity.ownedEvidence,
    };
  });
}

function countRepliesToOthers(
  userId: string,
  threadKeys: readonly string[],
  threadAuthors: ReadonlyMap<string, string>,
): number {
  let count = 0;
  for (const threadKey of threadKeys) {
    const threadAuthor = threadAuthors.get(threadKey);
    if (threadAuthor && threadAuthor !== userId) {
      count += 1;
    }
  }

  return count;
}

function formatTimelineMessage(
  message: EvidenceMessage,
  time: string,
  href: string,
  user: TimelineUser | undefined,
): RunState['timeline'][number]['channels'][number]['threads'][number]['messages'][number] {
  return {
    time,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.userId ? { userId: message.userId } : {}),
    ...(user?.name ? { userName: user.name } : {}),
    ...(user?.role ? { userRole: user.role } : {}),
    ...(user?.externalAuthor ? { externalAuthor: true as const } : {}),
    evidenceScope: evidenceScope(message),
    ...(message.source === 'match' ? { anchor: true } : {}),
    href,
    text: message.text,
  };
}

function evidenceScope(message: EvidenceMessage): 'owned' | 'context' {
  return message.source === 'match' || message.source === 'thread' ? 'owned' : 'context';
}

function isTopLevelMessage(message: EvidenceMessage): boolean {
  return !message.threadTs || message.threadTs === message.ts;
}

function knownUsersForTimeline(
  configuredUsers: readonly TimelineUser[],
  knownUsers: readonly KnownUser[],
): Map<string, TimelineUser> {
  const users = new Map<string, TimelineUser>();
  for (const user of knownUsers) {
    users.set(user.id, { ...user, externalAuthor: true });
  }
  for (const user of configuredUsers) {
    users.set(user.id, { ...user, externalAuthor: false });
  }
  return users;
}

function getOrInsert<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const value = create();
  map.set(key, value);
  return value;
}

function localMessageTime(
  ts: string,
  timeZone: string,
): { readonly date: string; readonly dayOfWeek: string; readonly time: string } {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    throw new Error(`Cannot build timeline from non-numeric Slack timestamp: ${ts}`);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(seconds * 1000));

  const year = readPart(parts, 'year');
  const month = readPart(parts, 'month');
  const day = readPart(parts, 'day');
  return {
    date: `${year}-${month}-${day}`,
    dayOfWeek: readPart(parts, 'weekday'),
    time: `${readPart(parts, 'hour')}:${readPart(parts, 'minute')}`,
  };
}

function readPart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Unable to format local timeline part "${type}"`);
  }

  return value;
}

function validateRunState(state: RunState): RunState {
  const jsonState = JSON.parse(JSON.stringify(state)) as RunState;
  if (!validateState(jsonState)) {
    throw new Error(`Invalid run state: ${ajv.errorsText(validateState.errors)}`);
  }

  return jsonState;
}

type MutableTimelineDay = {
  readonly date: string;
  readonly dayOfWeek: string;
  readonly users: Map<string, MutableDailyUserActivity>;
  readonly channels: Map<string, MutableTimelineChannel>;
};

type MutableDailyUserActivity = {
  firstMessageAt: string;
  channelMessages: number;
  readonly threadKeys: string[];
  totalMessages: number;
  readonly authoredTopLevelMessages: string[];
  readonly authoredReplies: string[];
  readonly ownedEvidence: string[];
};

type MutableTimelineChannel = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly kind: 'channel' | 'dm' | 'mpim' | 'unknown';
  readonly threads: Map<string, MutableTimelineThread>;
};

type MutableTimelineThread = {
  readonly messages: {
    readonly time: string;
    readonly messageId?: string | undefined;
    readonly userId?: string | undefined;
    readonly userName?: string | undefined;
    readonly userRole?: string | undefined;
    readonly externalAuthor?: true | undefined;
    readonly evidenceScope: 'owned' | 'context';
    readonly anchor?: true | undefined;
    readonly href: string;
    readonly text: string;
  }[];
};

type TimelineUser = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly role?: string | undefined;
  readonly externalAuthor?: boolean | undefined;
};
