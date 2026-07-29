import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import type { SlackMessage } from '../types.js';

type TableColumn = {
  readonly name: string;
  readonly type: string;
};

type DetectedFields = {
  channelId?: string | undefined;
  workspaceId?: string | undefined;
  ts?: string | undefined;
  text?: string | undefined;
  messageId?: string | undefined;
  threadTs?: string | undefined;
  userId?: string | undefined;
  type?: string | undefined;
  subtype?: string | undefined;
};

export type SlacrawlSchema = {
  readonly messageTable: string;
  readonly fields: {
    readonly channelId: string;
    readonly workspaceId?: string | undefined;
    readonly ts: string;
    readonly text: string;
    readonly messageId?: string | undefined;
    readonly threadTs?: string | undefined;
    readonly userId?: string | undefined;
    readonly type?: string | undefined;
    readonly subtype?: string | undefined;
  };
};

export type SlacrawlDatabase = {
  readonly db: DatabaseSync;
  readonly schema: SlacrawlSchema;
  readonly workspaceId: string | null;
  readonly redactMessage?: (<T extends SlackMessage>(message: T) => T) | undefined;
  readonly close: () => void;
};

const candidates = {
  channelId: ['channel_id', 'channel', 'conversation_id', 'channelId', 'cid'],
  workspaceId: ['workspace_id', 'workspace', 'team_id', 'team', 'teamId', 'enterprise_id'],
  ts: ['ts', 'timestamp', 'message_ts', 'created_at', 'date'],
  text: ['text', 'body', 'message', 'content'],
  messageId: ['message_id', 'id', 'client_msg_id'],
  threadTs: ['thread_ts', 'thread_timestamp', 'parent_ts', 'root_ts'],
  userId: ['user_id', 'user', 'sender_id', 'author_id'],
  type: ['type', 'message_type'],
  subtype: ['subtype', 'message_subtype'],
} as const;

export function openSlacrawlDatabase(
  databasePath: string,
  options: {
    readonly redactMessage?: (<T extends SlackMessage>(message: T) => T) | undefined;
  } = {},
): SlacrawlDatabase {
  if (!existsSync(databasePath)) {
    throw new Error(`slacrawl database not found: ${databasePath}`);
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  logger.info({ databasePath, readOnly: true }, 'opening slacrawl database');
  const schema = detectSlacrawlSchema(db);
  const workspaceId = detectWorkspaceId(db, schema);

  return {
    db,
    schema,
    workspaceId,
    redactMessage: options.redactMessage,
    close: () => db.close(),
  };
}

export function detectSlacrawlSchema(db: DatabaseSync): SlacrawlSchema {
  const tables = listTables(db);
  const inspected = tables.map((table) => ({ table, columns: listColumns(db, table) }));
  const ranked = inspected
    .map(({ table, columns }) => ({ table, columns, fields: detectFields(db, table, columns) }))
    .filter(({ fields }) => fields.channelId && fields.ts && fields.text)
    .sort(
      (left, right) => tableScore(right.table, right.fields) - tableScore(left.table, left.fields),
    );

  const best = ranked[0];
  if (!best?.fields.channelId || !best.fields.ts || !best.fields.text) {
    const summary = inspected
      .map(({ table, columns }) => `${table}(${columns.map((column) => column.name).join(',')})`)
      .join('; ');
    throw new Error(`Could not detect slacrawl message table. Tables inspected: ${summary}`);
  }

  return {
    messageTable: best.table,
    fields: {
      channelId: best.fields.channelId,
      workspaceId: best.fields.workspaceId,
      ts: best.fields.ts,
      text: best.fields.text,
      messageId: best.fields.messageId,
      threadTs: best.fields.threadTs,
      userId: best.fields.userId,
      type: best.fields.type,
      subtype: best.fields.subtype,
    },
  };
}

function listTables(db: DatabaseSync): readonly string[] {
  const sql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
  const rows = executeAll(db, 'slacrawl.listTables', sql, []) as readonly {
    readonly name: unknown;
  }[];
  return rows.map((row) => String(row.name));
}

function listColumns(db: DatabaseSync, table: string): readonly TableColumn[] {
  const sql = `PRAGMA table_info(${quoteIdentifier(table)})`;
  const rows = executeAll(db, 'slacrawl.listColumns', sql, [], { table }) as readonly {
    readonly name: unknown;
    readonly type: unknown;
  }[];

  return rows.map((row) => ({
    name: String(row.name),
    type: String(row.type ?? ''),
  }));
}

function detectFields(
  db: DatabaseSync,
  table: string,
  columns: readonly TableColumn[],
): DetectedFields {
  const names = columns.map((column) => column.name);
  const fields: DetectedFields = {};
  assignIfFound(fields, 'channelId', pick(names, candidates.channelId));
  assignIfFound(fields, 'workspaceId', pick(names, candidates.workspaceId));
  assignIfFound(fields, 'ts', pickTimestampField(db, table, names));
  assignIfFound(fields, 'text', pick(names, candidates.text));
  assignIfFound(fields, 'messageId', pick(names, candidates.messageId));
  assignIfFound(fields, 'threadTs', pick(names, candidates.threadTs));
  assignIfFound(fields, 'userId', pick(names, candidates.userId));
  assignIfFound(fields, 'type', pick(names, candidates.type));
  assignIfFound(fields, 'subtype', pick(names, candidates.subtype));
  return fields;
}

function detectWorkspaceId(db: DatabaseSync, schema: SlacrawlSchema): string | null {
  const fromMessageTable = readFirstValue(db, schema.messageTable, [
    schema.fields.workspaceId,
    ...candidates.workspaceId,
  ]);
  if (fromMessageTable) {
    return fromMessageTable;
  }

  for (const table of listTables(db)) {
    if (!/workspace|team|enterprise/i.test(table)) {
      continue;
    }

    const value = readFirstValue(db, table, [
      'id',
      'workspace_id',
      'team_id',
      'enterprise_id',
      'workspaceId',
      'teamId',
    ]);
    if (value) {
      return value;
    }
  }

  return null;
}

function readFirstValue(
  db: DatabaseSync,
  table: string,
  preferredColumns: readonly (string | undefined)[],
): string | null {
  const columns = listColumns(db, table).map((column) => column.name);
  const column = pick(
    columns,
    preferredColumns.filter((value) => value !== undefined),
  );
  if (!column) {
    return null;
  }

  const sql = `
        SELECT ${quoteIdentifier(column)} AS value
        FROM ${quoteIdentifier(table)}
        WHERE ${quoteIdentifier(column)} IS NOT NULL
          AND ${quoteIdentifier(column)} != ''
        LIMIT 1
      `;
  const row = executeGet(db, 'slacrawl.readFirstValue', sql, [], { table, column }) as
    | { readonly value: unknown }
    | undefined;

  return row?.value === null || row?.value === undefined ? null : String(row.value);
}

function assignIfFound(
  fields: DetectedFields,
  key: keyof DetectedFields,
  value: string | undefined,
): void {
  if (value) {
    fields[key] = value;
  }
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

function pickTimestampField(
  db: DatabaseSync,
  table: string,
  names: readonly string[],
): string | undefined {
  const candidateNames = timestampCandidateNames(names);
  if (candidateNames.length <= 1) {
    return candidateNames[0];
  }

  return candidateNames
    .map((name, index) => ({
      name,
      index,
      score: timestampColumnScore(db, table, name),
    }))
    .toSorted((left, right) => right.score - left.score || left.index - right.index)[0]?.name;
}

function timestampCandidateNames(names: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const candidate of candidates.ts) {
    const exact = names.find((name) => name === candidate);
    const folded = exact ?? names.find((name) => name.toLowerCase() === candidate.toLowerCase());
    if (folded && !found.includes(folded)) {
      found.push(folded);
    }
  }

  return found;
}

function timestampColumnScore(db: DatabaseSync, table: string, column: string): number {
  const sql = `
    SELECT ${quoteIdentifier(column)} AS value
    FROM ${quoteIdentifier(table)}
    WHERE ${quoteIdentifier(column)} IS NOT NULL
      AND ${quoteIdentifier(column)} != ''
    LIMIT 20
  `;
  const rows = executeAll(db, 'slacrawl.scoreTimestampColumn', sql, [], {
    table,
    column,
  }) as readonly { readonly value: unknown }[];

  if (rows.length === 0) {
    return 0;
  }

  return rows.reduce((score, row) => score + timestampValueScore(row.value), 0);
}

function timestampValueScore(value: unknown): number {
  const text = String(value);
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return -10;
  }

  return slackTimestampLikePattern.test(text) ? 2 : 1;
}

const slackTimestampLikePattern = /^\d{9,10}(?:\.\d+)?$/u;

function tableScore(table: string, fields: DetectedFields): number {
  const messageNameScore = /message|slack/i.test(table) ? 10 : 0;
  const optionalScore = Number(Boolean(fields.messageId)) + Number(Boolean(fields.threadTs));
  return messageNameScore + optionalScore;
}

export function readMessagesSince(
  source: SlacrawlDatabase,
  input: {
    readonly channelIds: readonly string[];
    readonly afterCursor: string | null;
    readonly beforeOrAtCursor?: string | null | undefined;
    readonly maxRows?: number;
  },
): readonly SlackMessage[] {
  const { schema } = source;
  const selectColumns = selectedColumns(schema);
  const channelClause =
    input.channelIds.length > 0
      ? `WHERE ${quoteIdentifier(schema.fields.channelId)} IN (${input.channelIds.map(() => '?').join(', ')})`
      : '';
  const afterClause = input.afterCursor
    ? `${channelClause ? 'AND' : 'WHERE'} CAST(${quoteIdentifier(schema.fields.ts)} AS REAL) > ?`
    : '';
  const beforeClause = input.beforeOrAtCursor
    ? `${channelClause || afterClause ? 'AND' : 'WHERE'} CAST(${quoteIdentifier(schema.fields.ts)} AS REAL) <= ?`
    : '';
  const limitClause = input.maxRows ? 'LIMIT ?' : '';
  const sql = `
    SELECT ${selectColumns}
    FROM ${quoteIdentifier(schema.messageTable)}
    ${channelClause}
    ${afterClause}
    ${beforeClause}
    ORDER BY CAST(${quoteIdentifier(schema.fields.ts)} AS REAL) ASC
    ${limitClause}
  `;
  const parameters: (string | number)[] = [...input.channelIds];
  if (input.afterCursor) {
    parameters.push(input.afterCursor);
  }
  if (input.beforeOrAtCursor) {
    parameters.push(input.beforeOrAtCursor);
  }
  if (input.maxRows) {
    parameters.push(input.maxRows);
  }

  const rows = executeAll(source.db, 'slacrawl.readMessagesSince', sql, parameters, {
    messageTable: schema.messageTable,
    channelIds: input.channelIds,
    afterCursor: input.afterCursor,
    beforeOrAtCursor: input.beforeOrAtCursor,
    maxRows: input.maxRows,
  }) as readonly Record<string, unknown>[];
  logMessageResultWindow('slacrawl.readMessagesSince', rows, schema);
  return normalizeSourceMessages(source, 'slacrawl.readMessagesSince', rows);
}

export function readLatestCursor(
  source: SlacrawlDatabase,
  channelIds: readonly string[],
): string | null {
  const channelClause =
    channelIds.length > 0
      ? `WHERE ${quoteIdentifier(source.schema.fields.channelId)} IN (${channelIds.map(() => '?').join(', ')})`
      : '';
  const sql = `
        SELECT MAX(CAST(${quoteIdentifier(source.schema.fields.ts)} AS REAL)) AS max_ts
        FROM ${quoteIdentifier(source.schema.messageTable)}
        ${channelClause}
      `;
  const row = executeGet(source.db, 'slacrawl.readLatestCursor', sql, [...channelIds], {
    messageTable: source.schema.messageTable,
    channelIds,
  }) as { readonly max_ts: unknown } | undefined;

  return row?.max_ts === null || row?.max_ts === undefined ? null : String(row.max_ts);
}

export function readThreadMessages(
  source: SlacrawlDatabase,
  anchor: SlackMessage,
): readonly SlackMessage[] {
  const threadField = source.schema.fields.threadTs;
  if (!threadField) {
    logger.debug(
      {
        channelId: anchor.channelId,
        ts: anchor.ts,
        reason: 'missing_thread_ts_field',
      },
      'skipping slacrawl thread query',
    );
    return [];
  }

  const threadCursor = anchor.threadTs ?? anchor.ts;
  const sql = `
        SELECT ${selectedColumns(source.schema)}
        FROM ${quoteIdentifier(source.schema.messageTable)}
        WHERE ${quoteIdentifier(source.schema.fields.channelId)} = ?
          AND (${quoteIdentifier(threadField)} = ? OR ${quoteIdentifier(source.schema.fields.ts)} = ?)
        ORDER BY CAST(${quoteIdentifier(source.schema.fields.ts)} AS REAL) ASC
      `;
  const parameters = [anchor.channelId, threadCursor, threadCursor];
  const rows = executeAll(source.db, 'slacrawl.readThreadMessages', sql, parameters, {
    messageTable: source.schema.messageTable,
    channelId: anchor.channelId,
    anchorTs: anchor.ts,
    threadCursor,
  }) as readonly Record<string, unknown>[];
  logMessageResultWindow('slacrawl.readThreadMessages', rows, source.schema);

  return normalizeSourceMessages(source, 'slacrawl.readThreadMessages', rows);
}

export function readNearbyMessages(
  source: SlacrawlDatabase,
  anchor: SlackMessage,
  input: {
    readonly beforeMinutes: number;
    readonly afterMinutes: number;
  },
): readonly SlackMessage[] {
  const anchorTs = Number(anchor.ts);
  if (!Number.isFinite(anchorTs)) {
    logger.debug(
      {
        channelId: anchor.channelId,
        ts: anchor.ts,
        reason: 'non_numeric_anchor_ts',
      },
      'skipping slacrawl nearby query',
    );
    return [];
  }

  const before = anchorTs - input.beforeMinutes * 60;
  const after = anchorTs + input.afterMinutes * 60;
  const sql = `
        SELECT ${selectedColumns(source.schema)}
        FROM ${quoteIdentifier(source.schema.messageTable)}
        WHERE ${quoteIdentifier(source.schema.fields.channelId)} = ?
          AND CAST(${quoteIdentifier(source.schema.fields.ts)} AS REAL) >= ?
          AND CAST(${quoteIdentifier(source.schema.fields.ts)} AS REAL) <= ?
        ORDER BY CAST(${quoteIdentifier(source.schema.fields.ts)} AS REAL) ASC
      `;
  const parameters = [anchor.channelId, before, after];
  const rows = executeAll(source.db, 'slacrawl.readNearbyMessages', sql, parameters, {
    messageTable: source.schema.messageTable,
    channelId: anchor.channelId,
    anchorTs: anchor.ts,
    beforeMinutes: input.beforeMinutes,
    afterMinutes: input.afterMinutes,
    beforeCursor: before,
    afterCursor: after,
  }) as readonly Record<string, unknown>[];
  logMessageResultWindow('slacrawl.readNearbyMessages', rows, source.schema);

  return normalizeSourceMessages(source, 'slacrawl.readNearbyMessages', rows);
}

function executeAll(
  db: DatabaseSync,
  operation: string,
  sql: string,
  parameters: readonly (string | number)[],
  context: Record<string, unknown> = {},
): readonly Record<string, unknown>[] {
  const startedAt = performance.now();
  logger.debug({ operation, sql: normalizeSql(sql), parameters, ...context }, 'slacrawl SQL query');
  const rows = db.prepare(sql).all(...parameters) as readonly Record<string, unknown>[];
  logger.debug(
    {
      operation,
      rowCount: rows.length,
      durationMs: elapsedMs(startedAt),
      ...context,
    },
    'slacrawl SQL query completed',
  );
  return rows;
}

function executeGet(
  db: DatabaseSync,
  operation: string,
  sql: string,
  parameters: readonly (string | number)[],
  context: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const startedAt = performance.now();
  logger.debug({ operation, sql: normalizeSql(sql), parameters, ...context }, 'slacrawl SQL query');
  const row = db.prepare(sql).get(...parameters) as Record<string, unknown> | undefined;
  logger.debug(
    {
      operation,
      rowFound: row !== undefined,
      durationMs: elapsedMs(startedAt),
      ...context,
    },
    'slacrawl SQL query completed',
  );
  return row;
}

function logMessageResultWindow(
  operation: string,
  rows: readonly Record<string, unknown>[],
  schema: SlacrawlSchema,
): void {
  const first = rows[0];
  const last = rows.at(-1);
  logger.debug(
    {
      operation,
      rowCount: rows.length,
      firstTs: first ? String(first[schema.fields.ts]) : null,
      lastTs: last ? String(last[schema.fields.ts]) : null,
    },
    'slacrawl message query result window',
  );
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/g, ' ').trim();
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function selectedColumns(schema: SlacrawlSchema): string {
  const fields = [
    schema.fields.channelId,
    schema.fields.ts,
    schema.fields.text,
    schema.fields.messageId,
    schema.fields.threadTs,
    schema.fields.userId,
    schema.fields.type,
    schema.fields.subtype,
  ].filter((field) => field !== undefined);

  return fields.map((field) => quoteIdentifier(field)).join(', ');
}

function normalizeMessage(row: Record<string, unknown>, schema: SlacrawlSchema): SlackMessage {
  return {
    channelId: String(row[schema.fields.channelId]),
    messageId: value(row, schema.fields.messageId),
    ts: String(row[schema.fields.ts]),
    threadTs: value(row, schema.fields.threadTs),
    userId: value(row, schema.fields.userId),
    text: String(row[schema.fields.text] ?? ''),
    type: value(row, schema.fields.type),
    subtype: value(row, schema.fields.subtype),
  };
}

function normalizeSourceMessage(
  source: SlacrawlDatabase,
  row: Record<string, unknown>,
): SlackMessage {
  const message = normalizeMessage(row, source.schema);
  return source.redactMessage ? source.redactMessage(message) : message;
}

function normalizeSourceMessages(
  source: SlacrawlDatabase,
  operation: string,
  rows: readonly Record<string, unknown>[],
): readonly SlackMessage[] {
  const messages = rows.map((row) => normalizeSourceMessage(source, row));
  const humanMessages = messages.filter((message) => !isBotOrSystemMessage(message));
  const skippedBotOrSystemMessageCount = messages.length - humanMessages.length;
  const nonEmpty = humanMessages.filter((message) => isMeaningfulMessageText(message.text));
  const skippedEmptyMessageCount = humanMessages.length - nonEmpty.length;
  if (skippedBotOrSystemMessageCount > 0) {
    logger.debug(
      {
        operation,
        skippedBotOrSystemMessageCount,
        returnedMessageCount: nonEmpty.length,
      },
      'slacrawl bot/system messages skipped',
    );
  }
  if (skippedEmptyMessageCount > 0) {
    logger.debug(
      {
        operation,
        skippedEmptyMessageCount,
        returnedMessageCount: nonEmpty.length,
      },
      'slacrawl empty messages skipped',
    );
  }

  return nonEmpty;
}

const systemMessageSubtypes = new Set([
  'bot_message',
  'channel_archive',
  'channel_join',
  'channel_leave',
  'channel_name',
  'channel_purpose',
  'channel_topic',
  'channel_unarchive',
  'desktop_draft',
  'ekm_access_denied',
  'group_archive',
  'group_join',
  'group_leave',
  'group_name',
  'group_purpose',
  'group_topic',
  'group_unarchive',
  'message_changed',
  'message_deleted',
  'message_replied',
  'pinned_item',
]);

function isBotOrSystemMessage(message: SlackMessage): boolean {
  if (message.userId === 'USLACKBOT') {
    return true;
  }

  if (!message.subtype) {
    return false;
  }

  return systemMessageSubtypes.has(message.subtype);
}

function isMeaningfulMessageText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed !== '[REDACTED]';
}

function value(row: Record<string, unknown>, key: string | undefined): string | undefined {
  if (!key) {
    return undefined;
  }

  const raw = row[key];
  return raw === null || raw === undefined || raw === '' ? undefined : String(raw);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
