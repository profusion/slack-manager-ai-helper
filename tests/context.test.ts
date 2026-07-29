import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openSlacrawlDatabase,
  readMessagesSince,
  readNearbyMessages,
} from '../src/slacrawl/slacrawl-db.js';
import { expandEvidence } from '../src/state/context.js';
import type { AppConfig, MatchResult } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('slacrawl context windows', () => {
  it('selects nearby messages in the configured window', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'before', NULL);
      INSERT INTO messages VALUES ('C', '1100', 'U2', 'anchor', NULL);
      INSERT INTO messages VALUES ('C', '2000', 'U3', 'after', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const nearby = readNearbyMessages(
      source,
      { channelId: 'C', ts: '1100', text: 'anchor' },
      { beforeMinutes: 5, afterMinutes: 5 },
    );

    expect(nearby.map((message) => message.text)).toEqual(['before', 'anchor']);
    source.close();
  });

  it('detects workspace id from slacrawl SQL metadata', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      CREATE TABLE teams (
        id TEXT
      );
      INSERT INTO teams VALUES ('T_WORKSPACE');
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);

    expect(source.workspaceId).toBe('T_WORKSPACE');
    source.close();
  });

  it('detects workspace id from message table when present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        workspace_id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('T_MESSAGES', 'C', '1000', 'U1', 'anchor', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);

    expect(source.workspaceId).toBe('T_MESSAGES');
    source.close();
  });

  it('reads every channel when no channel ids are configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C1', '1000', 'U1', 'first channel', NULL);
      INSERT INTO messages VALUES ('C2', '1001', 'U2', 'second channel', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const messages = readMessagesSince(source, {
      channelIds: [],
      afterCursor: null,
    });

    expect(messages.map((message) => message.channelId)).toEqual(['C1', 'C2']);
    source.close();
  });

  it('prefers numeric Slack timestamp columns over draft timestamp ids', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        timestamp TEXT,
        message_ts TEXT,
        user_id TEXT,
        text TEXT
      );
      INSERT INTO messages VALUES (
        'm1',
        'C',
        'draft:1000000000001:T000TESTWS:C000TESTCH-1000000000.000001',
        '1000000000.000001',
        'U1',
        'planning update'
      );
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const messages = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    });

    expect(source.schema.fields.ts).toBe('message_ts');
    expect(messages[0]?.ts).toBe('1000000000.000001');
    source.close();
  });

  it('redacts slacrawl messages before they reach matchers or context expansion', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor Bearer secret-token', '1000');
      INSERT INTO messages VALUES ('C', '1010', 'U2', 'thread Bearer thread-token', '1000');
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'nearby Bearer nearby-token', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath, {
      redactMessage: (message) => ({
        ...message,
        text: message.text.replace(/Bearer\s+\S+/u, '[REDACTED]'),
      }),
    });
    const messages = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    });
    const evidence = await expandEvidence(
      source,
      [
        {
          channel: { id: 'C', users: [{ id: 'U1' }] },
          matcherId: 'planning',
          matcherType: 'regex',
          message: messages[0] ?? { channelId: 'C', ts: '1000', text: '' },
        },
      ],
      sampleConfig(),
    );

    expect(messages.map((message) => message.text)).toEqual([
      'anchor [REDACTED]',
      'thread [REDACTED]',
      'nearby [REDACTED]',
    ]);
    expect(evidence.map((message) => message.text)).toEqual([
      'anchor [REDACTED]',
      'thread [REDACTED]',
      'nearby [REDACTED]',
    ]);
    source.close();
  });

  it('skips empty and fully redacted slacrawl messages after normalization and redaction', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', NULL, NULL);
      INSERT INTO messages VALUES ('C', '1001', 'U1', '', NULL);
      INSERT INTO messages VALUES ('C', '1002', 'U1', '   ', NULL);
      INSERT INTO messages VALUES ('C', '1003', 'U1', 'Bearer secret-token', NULL);
      INSERT INTO messages VALUES ('C', '1004', 'U1', 'visible planning', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath, {
      redactMessage: (message) => ({
        ...message,
        text: message.text.replace(/Bearer\s+\S+/u, '[REDACTED]'),
      }),
    });
    const messages = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    });

    expect(messages.map((message) => message.text)).toEqual(['visible planning']);
    source.close();
  });

  it('skips Slackbot, bot, and system messages after normalization', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        subtype TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'USLACKBOT', 'system reminder', NULL, NULL);
      INSERT INTO messages VALUES ('C', '1001', 'U_BOT', 'bot update', 'bot_message', NULL);
      INSERT INTO messages VALUES ('C', '1002', 'U2', 'joined channel', 'channel_join', NULL);
      INSERT INTO messages VALUES ('C', '1003', 'U1', 'human planning', NULL, NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const messages = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    });

    expect(messages.map((message) => message.text)).toEqual(['human planning']);
    source.close();
  });

  it('skips desktop draft rows with draft timestamp ids after normalization', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        subtype TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES (
        'C',
        'draft:1000000000001:T000TESTWS:C000TESTCH-1000000000.000001',
        'U1',
        'unsent draft planning',
        'desktop_draft',
        '1000000000.000001'
      );
      INSERT INTO messages VALUES ('C', '1000000000.000001', 'U1', 'sent planning', NULL, NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const messages = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    });

    expect(messages.map((message) => message.text)).toEqual(['sent planning']);
    source.close();
  });

  it('skips bot and system messages in thread and nearby context reads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        subtype TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor planning', NULL, '1000');
      INSERT INTO messages VALUES ('C', '1010', 'USLACKBOT', 'thread system reminder', NULL, '1000');
      INSERT INTO messages VALUES ('C', '1020', 'U_BOT', 'nearby bot update', 'bot_message', NULL);
      INSERT INTO messages VALUES ('C', '1030', 'U2', 'nearby human context', NULL, NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const evidence = await expandEvidence(source, [sampleMatch()], sampleConfig());

    expect(evidence.map((message) => message.text)).toEqual([
      'anchor planning',
      'nearby human context',
    ]);
    source.close();
  });

  it('skips empty thread and nearby context messages', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor planning', '1000');
      INSERT INTO messages VALUES ('C', '1010', 'U2', '', '1000');
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'nearby context', NULL);
      INSERT INTO messages VALUES ('C', '1030', 'U4', '   ', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const evidence = await expandEvidence(source, [sampleMatch()], sampleConfig());

    expect(evidence.map((message) => message.text)).toEqual(['anchor planning', 'nearby context']);
    source.close();
  });

  it('includes thread and nearby context from users outside the configured anchor users', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor planning', '1000');
      INSERT INTO messages VALUES ('C', '1010', 'U2', 'thread reply from another user', '1000');
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'nearby context from a third user', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const evidence = await expandEvidence(source, [sampleMatch()], sampleConfig());

    expect(evidence.map((message) => message.text)).toEqual([
      'anchor planning',
      'thread reply from another user',
      'nearby context from a third user',
    ]);
    source.close();
  });

  it('includes every matched anchor regardless of the nearby message limit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'first planning', NULL);
      INSERT INTO messages VALUES ('C', '1010', 'U2', 'second planning', NULL);
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'third planning', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const matches = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    }).map(
      (message): MatchResult => ({
        channel: { id: 'C', users: [{ id: message.userId ?? '' }] },
        matcherId: 'planning',
        matcherType: 'regex',
        message,
      }),
    );
    const evidence = await expandEvidence(source, matches, {
      ...sampleConfig(),
      context: {
        maxMessages: 1,
        nearbyMessagesBeforeMinutes: 0,
        nearbyMessagesAfterMinutes: 0,
        syntheticThreads: {
          enabled: false,
        },
      },
    });

    expect(evidence.map((message) => message.text)).toEqual([
      'first planning',
      'second planning',
      'third planning',
    ]);
    source.close();
  });

  it('applies maxMessages to nearby context separately for each match', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'first planning', NULL);
      INSERT INTO messages VALUES ('C', '1010', 'U2', 'first nearby kept', NULL);
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'first nearby skipped', NULL);
      INSERT INTO messages VALUES ('C', '2000', 'U4', 'second planning', NULL);
      INSERT INTO messages VALUES ('C', '2010', 'U5', 'second nearby kept', NULL);
      INSERT INTO messages VALUES ('C', '2020', 'U6', 'second nearby skipped', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const messages = readMessagesSince(source, {
      channelIds: ['C'],
      afterCursor: null,
    });
    const matches = [messages[0], messages[3]].map(
      (message): MatchResult => ({
        channel: { id: 'C', users: [{ id: message?.userId ?? '' }] },
        matcherId: 'planning',
        matcherType: 'regex',
        message: message ?? { channelId: 'C', ts: '0', text: '' },
      }),
    );
    const evidence = await expandEvidence(source, matches, {
      ...sampleConfig(),
      context: {
        maxMessages: 1,
        nearbyMessagesBeforeMinutes: 0,
        nearbyMessagesAfterMinutes: 1,
        syntheticThreads: {
          enabled: false,
        },
      },
    });

    expect(evidence.map((message) => [message.text, message.source])).toEqual([
      ['first planning', 'match'],
      ['second planning', 'match'],
      ['first nearby kept', 'nearby'],
      ['second nearby kept', 'nearby'],
    ]);
    source.close();
  });

  it('uses conservative nearby context defaults', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '699', 'U0', 'outside before default window', NULL);
      INSERT INTO messages VALUES ('C', '700', 'U1', 'inside before default window', NULL);
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor planning', NULL);
      INSERT INTO messages VALUES ('C', '4600', 'U2', 'inside after default window', NULL);
      INSERT INTO messages VALUES ('C', '4601', 'U3', 'outside after default window', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const evidence = await expandEvidence(source, [sampleMatch()], {
      ...sampleConfig(),
      context: {},
    });

    expect(evidence.map((message) => message.text)).toEqual([
      'anchor planning',
      'inside before default window',
      'inside after default window',
    ]);
    source.close();
  });

  it('does not run synthetic scoring for anchors inside real Slack threads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'thread root', '1000');
      INSERT INTO messages VALUES ('C', '1010', 'U2', 'reply anchor planning', '1000');
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'nearby top-level related planning', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    const evidence = await expandEvidence(source, [sampleThreadReplyMatch()], {
      ...sampleConfig(),
      context: {
        nearbyMessagesBeforeMinutes: 0,
        nearbyMessagesAfterMinutes: 1,
        syntheticThreads: {
          enabled: true,
          thresholds: {
            relatedFrom: 0,
          },
        },
      },
    });

    expect(evidence).not.toContainEqual(
      expect.objectContaining({
        text: 'nearby top-level related planning',
        source: 'synthetic_related',
      }),
    );
    source.close();
  });

  it('skips synthetic scoring for match-all channel candidates that would already be anchors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[0, 1]])));
    vi.stubGlobal('fetch', fetchMock);

    const dir = await mkdtemp(path.join(tmpdir(), 'smah-slacrawl-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'slacrawl.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('C', '1000', 'U1', 'anchor planning', NULL);
      INSERT INTO messages VALUES ('C', '1010', 'U2', 'configured user update', NULL);
      INSERT INTO messages VALUES ('C', '1020', 'U3', 'unconfigured user reply', NULL);
    `);
    db.close();

    const source = openSlacrawlDatabase(dbPath);
    await expandEvidence(
      source,
      [
        {
          channel: { id: 'C', users: [{ id: 'U1' }, { id: 'U2' }] },
          matcherId: 'channel',
          matcherType: 'channel',
          message: {
            channelId: 'C',
            ts: '1000',
            threadTs: '1000',
            userId: 'U1',
            text: 'anchor planning',
          },
        },
      ],
      {
        ...sampleConfig(),
        context: {
          nearbyMessagesBeforeMinutes: 0,
          nearbyMessagesAfterMinutes: 1,
          syntheticThreads: {
            enabled: true,
            scoring: {
              semanticSimilarityWeight: 0.5,
            },
            embeddings: {
              enabled: true,
              provider: 'ollama',
            },
          },
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    source.close();
  });
});

function jsonResponse(body: unknown): Response {
  return {
    headers: new Headers(),
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function ollamaEmbedResponse(embeddings: number[][]): unknown {
  return {
    model: 'nomic-embed-text',
    embeddings,
    total_duration: 1,
    load_duration: 1,
    prompt_eval_count: 1,
  };
}

function sampleConfig(): AppConfig {
  return {
    workspaceUrl: 'https://example.slack.com',
    storage: {
      slacrawlDatabasePath: '/tmp/slacrawl.db',
    },
    prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
    model: {
      provider: 'openai',
      model: 'gpt-test',
    },
    channels: [{ id: 'C', users: [{ id: 'U1' }] }],
    context: {
      nearbyMessagesBeforeMinutes: 0,
      nearbyMessagesAfterMinutes: 1,
      syntheticThreads: {
        enabled: false,
      },
    },
  };
}

function sampleMatch(): MatchResult {
  return {
    channel: { id: 'C', users: [{ id: 'U1' }] },
    matcherId: 'planning',
    matcherType: 'regex',
    message: {
      channelId: 'C',
      ts: '1000',
      threadTs: '1000',
      userId: 'U1',
      text: 'anchor planning',
    },
  };
}

function sampleThreadReplyMatch(): MatchResult {
  return {
    channel: { id: 'C', users: [{ id: 'U2' }] },
    matcherId: 'planning',
    matcherType: 'regex',
    message: {
      channelId: 'C',
      ts: '1010',
      threadTs: '1000',
      userId: 'U2',
      text: 'reply anchor planning',
    },
  };
}
