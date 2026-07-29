import type { DatabaseSync } from 'node:sqlite';
import type { ChannelConfig, ConfiguredUser } from '../types.js';
import { openSlacrawlDatabase, type SlacrawlDatabase } from './slacrawl-db.js';

export type SlacrawlChannelInfo = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly kind?: ChannelConfig['kind'] | undefined;
  readonly isPrivate?: boolean | undefined;
  readonly source: 'metadata' | 'messages' | 'reference';
};

export type SlacrawlUserInfo = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly source: 'metadata' | 'messages' | 'reference';
};

export type SlacrawlDirectory = {
  readonly channels: readonly SlacrawlChannelInfo[];
  readonly users: readonly SlacrawlUserInfo[];
  readonly channelUserIds: ReadonlyMap<string, readonly string[]>;
};

type DirectoryTable = {
  readonly table: string;
  readonly columns: readonly string[];
};

export function readSlacrawlDirectory(
  databasePath: string,
  referenceChannels: readonly ChannelConfig[],
): SlacrawlDirectory {
  const source = openSlacrawlDatabase(databasePath);
  try {
    return readSlacrawlDirectoryFromSource(source, referenceChannels);
  } finally {
    source.close();
  }
}

export function readSlacrawlDirectoryFromSource(
  source: SlacrawlDatabase,
  referenceChannels: readonly ChannelConfig[],
): SlacrawlDirectory {
  const tables = listDirectoryTables(source.db);
  const channels = mergeChannels(
    readMetadataChannels(source.db, tables),
    readMessageChannels(source),
    referenceChannels,
  );
  const users = mergeUsers(
    readMetadataUsers(source.db, tables),
    readMessageUsers(source),
    referenceChannels.flatMap((channel) => channel.users ?? []),
  );
  const channelUserIds = readChannelMemberships(source.db, tables);
  return {
    channels,
    users,
    channelUserIds: channelUserIds.size > 0 ? channelUserIds : readMessageChannelUsers(source),
  };
}

function listDirectoryTables(db: DatabaseSync): readonly DirectoryTable[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as readonly { readonly name: unknown }[];
  return rows.map((row) => {
    const table = String(row.name);
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all() as unknown as readonly { readonly name: unknown }[];
    return {
      table,
      columns: columns.map((column) => String(column.name)),
    };
  });
}

function readMetadataChannels(
  db: DatabaseSync,
  tables: readonly DirectoryTable[],
): readonly SlacrawlChannelInfo[] {
  const table = tables.find((candidate) => /channel|conversation/i.test(candidate.table));
  if (!table) {
    return [];
  }

  const idColumn = pick(table.columns, ['id', 'channel_id', 'conversation_id', 'cid']);
  if (!idColumn) {
    return [];
  }

  const nameColumn = pick(table.columns, ['name', 'channel_name', 'display_name']);
  const kindColumn = pick(table.columns, ['kind', 'type', 'conversation_type']);
  const privateColumn = pick(table.columns, ['is_private', 'private']);
  const rows = db
    .prepare(
      `SELECT * FROM ${quoteIdentifier(table.table)} WHERE ${quoteIdentifier(idColumn)} IS NOT NULL`,
    )
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row[idColumn]),
    ...(stringValue(row, nameColumn) ? { name: stringValue(row, nameColumn) } : {}),
    ...(kindValue(row, kindColumn) ? { kind: kindValue(row, kindColumn) } : {}),
    ...(booleanValue(row, privateColumn) === undefined
      ? {}
      : { isPrivate: booleanValue(row, privateColumn) }),
    source: 'metadata',
  }));
}

function readMessageChannels(source: SlacrawlDatabase): readonly SlacrawlChannelInfo[] {
  const channelField = source.schema.fields.channelId;
  const rows = source.db
    .prepare(
      `SELECT DISTINCT ${quoteIdentifier(channelField)} AS id FROM ${quoteIdentifier(
        source.schema.messageTable,
      )} WHERE ${quoteIdentifier(channelField)} IS NOT NULL ORDER BY ${quoteIdentifier(channelField)}`,
    )
    .all() as unknown as readonly { readonly id: unknown }[];
  return rows.map((row) => ({ id: String(row.id), source: 'messages' }));
}

function getFieldFromOneOfColumns<F extends string>(
  field: F,
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<never, never> | Record<F, string> {
  for (const col of columns) {
    const value = stringValue(row, col)?.trim();
    if (value) {
      return { [field]: value };
    }
  }
  return {};
}

function readMetadataUsers(
  db: DatabaseSync,
  tables: readonly DirectoryTable[],
): readonly SlacrawlUserInfo[] {
  const table = tables.find((candidate) => /user|member/i.test(candidate.table));
  if (!table) {
    return [];
  }

  const idColumn = pick(table.columns, ['id', 'user_id', 'uid']);
  if (!idColumn) {
    return [];
  }

  const nameColumns = ['real_name', 'name', 'display_name', 'username', 'user_name'];

  const rows = db
    .prepare(
      `SELECT * FROM ${quoteIdentifier(table.table)} WHERE ${quoteIdentifier(idColumn)} IS NOT NULL`,
    )
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row[idColumn]),
    ...getFieldFromOneOfColumns('name', row, nameColumns),
    source: 'metadata',
  }));
}

function readMessageUsers(source: SlacrawlDatabase): readonly SlacrawlUserInfo[] {
  const userField = source.schema.fields.userId;
  if (!userField) {
    return [];
  }

  const rows = source.db
    .prepare(
      `SELECT DISTINCT ${quoteIdentifier(userField)} AS id FROM ${quoteIdentifier(
        source.schema.messageTable,
      )} WHERE ${quoteIdentifier(userField)} IS NOT NULL ORDER BY ${quoteIdentifier(userField)}`,
    )
    .all() as unknown as readonly { readonly id: unknown }[];
  return rows.map((row) => ({ id: String(row.id), source: 'messages' }));
}

function readChannelMemberships(
  db: DatabaseSync,
  tables: readonly DirectoryTable[],
): ReadonlyMap<string, readonly string[]> {
  const table = tables.find(
    (candidate) =>
      /member|membership|channel_user|conversation_user/i.test(candidate.table) &&
      pick(candidate.columns, ['channel_id', 'conversation_id', 'cid']) &&
      pick(candidate.columns, ['user_id', 'uid']),
  );
  if (!table) {
    return new Map();
  }

  const channelColumn = pick(table.columns, ['channel_id', 'conversation_id', 'cid']);
  const userColumn = pick(table.columns, ['user_id', 'uid']);
  if (!channelColumn || !userColumn) {
    return new Map();
  }

  const rows = db
    .prepare(
      `SELECT ${quoteIdentifier(channelColumn)} AS channelId, ${quoteIdentifier(
        userColumn,
      )} AS userId FROM ${quoteIdentifier(table.table)}
       WHERE ${quoteIdentifier(channelColumn)} IS NOT NULL AND ${quoteIdentifier(userColumn)} IS NOT NULL`,
    )
    .all() as unknown as readonly { readonly channelId: unknown; readonly userId: unknown }[];
  return groupUserIdsByChannel(rows);
}

function readMessageChannelUsers(source: SlacrawlDatabase): ReadonlyMap<string, readonly string[]> {
  const userField = source.schema.fields.userId;
  if (!userField) {
    return new Map();
  }

  const rows = source.db
    .prepare(
      `SELECT DISTINCT ${quoteIdentifier(source.schema.fields.channelId)} AS channelId,
              ${quoteIdentifier(userField)} AS userId
       FROM ${quoteIdentifier(source.schema.messageTable)}
       WHERE ${quoteIdentifier(source.schema.fields.channelId)} IS NOT NULL
         AND ${quoteIdentifier(userField)} IS NOT NULL`,
    )
    .all() as unknown as readonly { readonly channelId: unknown; readonly userId: unknown }[];
  return groupUserIdsByChannel(rows);
}

function groupUserIdsByChannel(
  rows: readonly { readonly channelId: unknown; readonly userId: unknown }[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const channelId = String(row.channelId);
    const userId = String(row.userId);
    const users = grouped.get(channelId) ?? new Set<string>();
    users.add(userId);
    grouped.set(channelId, users);
  }
  return new Map([...grouped].map(([channelId, userIds]) => [channelId, [...userIds].sort()]));
}

function mergeChannels(
  metadata: readonly SlacrawlChannelInfo[],
  messageChannels: readonly SlacrawlChannelInfo[],
  referenceChannels: readonly ChannelConfig[],
): readonly SlacrawlChannelInfo[] {
  const merged = new Map<string, SlacrawlChannelInfo>();
  for (const channel of messageChannels) {
    merged.set(channel.id, channel);
  }
  for (const channel of metadata) {
    merged.set(channel.id, { ...merged.get(channel.id), ...channel });
  }
  for (const channel of referenceChannels) {
    merged.set(channel.id, {
      ...merged.get(channel.id),
      id: channel.id,
      ...(channel.name ? { name: channel.name } : {}),
      ...(channel.kind ? { kind: channel.kind } : {}),
      source: merged.get(channel.id)?.source ?? 'reference',
    });
  }
  return [...merged.values()].toSorted((left, right) =>
    channelLabel(left).localeCompare(channelLabel(right)),
  );
}

function mergeUsers(
  metadata: readonly SlacrawlUserInfo[],
  messageUsers: readonly SlacrawlUserInfo[],
  referenceUsers: readonly ConfiguredUser[],
): readonly SlacrawlUserInfo[] {
  const merged = new Map<string, SlacrawlUserInfo>();
  for (const user of messageUsers) {
    merged.set(user.id, user);
  }
  for (const user of metadata) {
    merged.set(user.id, { ...merged.get(user.id), ...user });
  }
  for (const user of referenceUsers) {
    merged.set(user.id, {
      ...merged.get(user.id),
      id: user.id,
      ...(user.name ? { name: user.name } : {}),
      source: merged.get(user.id)?.source ?? 'reference',
    });
  }
  return [...merged.values()].toSorted((left, right) =>
    userLabel(left).localeCompare(userLabel(right)),
  );
}

export function channelLabel(channel: SlacrawlChannelInfo): string {
  const name = channel.name ? `#${channel.name}` : channel.id;
  const flags = [
    channel.isPrivate ? 'private' : undefined,
    channel.kind,
    channel.source === 'messages' ? 'seen in messages' : undefined,
  ].filter((flag) => flag !== undefined);
  return flags.length > 0 ? `${name} (${flags.join(', ')})` : name;
}

export function userLabel(user: SlacrawlUserInfo): string {
  return user.name ? `${user.name} (${user.id})` : user.id;
}

function pick(names: readonly string[], preferred: readonly string[]): string | undefined {
  for (const candidate of preferred) {
    const exact = names.find((name) => name === candidate);
    if (exact) {
      return exact;
    }
  }

  for (const candidate of preferred) {
    const folded = names.find((name) => name.toLowerCase() === candidate.toLowerCase());
    if (folded) {
      return folded;
    }
  }

  return undefined;
}

function stringValue(row: Record<string, unknown>, column: string | undefined): string | undefined {
  if (!column) {
    return undefined;
  }

  const value = row[column];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function kindValue(
  row: Record<string, unknown>,
  column: string | undefined,
): ChannelConfig['kind'] | undefined {
  const value = stringValue(row, column)?.toLowerCase();
  if (value === 'channel' || value === 'dm' || value === 'mpim' || value === 'unknown') {
    return value;
  }

  if (value === 'im') {
    return 'dm';
  }

  return undefined;
}

function booleanValue(
  row: Record<string, unknown>,
  column: string | undefined,
): boolean | undefined {
  if (!column) {
    return undefined;
  }

  const value = row[column];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes'].includes(value.toLowerCase());
  }
  return undefined;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
