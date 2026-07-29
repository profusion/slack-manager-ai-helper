import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import stateSchema from '../schemas/state.schema.json' with { type: 'json' };
import { buildRunState } from '../src/state/build-state.js';
import type { AppConfig, EvidenceMessage, MatchResult } from '../src/types.js';

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(stateSchema);

describe('state schema', () => {
  it('validates the compact state built for a per-channel run', () => {
    const state = buildRunState({
      runId: 'run-1',
      config: sampleConfig(),
      topicId: 'plan-reviews',
      generatedAt: '2026-06-02T15:34:56.000Z',
      previousCursor: '990',
      currentMaxCursor: '1000',
      matches: [sampleMatch()],
      evidence: [sampleEvidence(), sampleOtherUserThreadRoot(), sampleReplyToOtherUserThread()],
      previousMemory: null,
      localTimeZone: 'America/Sao_Paulo',
      workspaceId: 'T',
      knownUsers: [{ id: 'UO', name: 'Untracked User' }],
    });

    expect(validate(state)).toBe(true);
    expect(state.topicId).toBe('plan-reviews');
    expect(state.generatedAt).toBe('20260602T12:34:56-0300');
    expect(state).not.toHaveProperty('run');
    expect(state).not.toHaveProperty('checkpoint');
    expect(state).not.toHaveProperty('match');
    expect(state).not.toHaveProperty('matches');
    expect(state).not.toHaveProperty('messages');
    expect(state.timeline).toEqual([
      {
        date: '1969-12-31',
        dayOfWeek: 'Wednesday',
        users: [
          {
            id: 'U',
            name: 'User',
            role: 'engineer',
            status: 'present',
            firstMessageAt: '21:16',
            channelMessages: 1,
            repliesToOthers: 1,
            totalMessages: 2,
            authoredTopLevelMessages: ['https://example.slack.com/archives/C/p1000'],
            authoredReplies: ['https://example.slack.com/archives/C/p1002?thread_ts=1001'],
            ownedEvidence: [
              'https://example.slack.com/archives/C/p1000',
              'https://example.slack.com/archives/C/p1002?thread_ts=1001',
            ],
          },
          {
            id: 'U2',
            name: 'Other User',
            role: 'designer',
            status: 'absent',
          },
        ],
        channels: [
          {
            id: 'C',
            kind: 'channel',
            threads: [
              {
                messages: [
                  {
                    anchor: true,
                    time: '21:16',
                    userId: 'U',
                    userName: 'User',
                    userRole: 'engineer',
                    evidenceScope: 'owned',
                    href: 'https://example.slack.com/archives/C/p1000',
                    text: 'planning',
                  },
                ],
              },
              {
                messages: [
                  {
                    time: '21:16',
                    userId: 'UO',
                    userName: 'Untracked User',
                    externalAuthor: true,
                    evidenceScope: 'owned',
                    href: 'https://example.slack.com/archives/C/p1001',
                    text: 'question',
                  },
                  {
                    time: '21:16',
                    userId: 'U',
                    userName: 'User',
                    userRole: 'engineer',
                    evidenceScope: 'owned',
                    href: 'https://example.slack.com/archives/C/p1002?thread_ts=1001',
                    text: 'answer',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('rejects unexpected top-level state fields', () => {
    const state = {
      generatedAt: '2026-06-02T00:00:00.000Z',
      users: [],
      timeline: [],
      previousMemory: {
        content: null,
      },
      unexpected: true,
    };

    expect(validate(state)).toBe(false);
  });

  it('rejects unexpected nested message fields', () => {
    const state = buildRunState({
      runId: 'run-1',
      config: sampleConfig(),
      topicId: 'plan-reviews',
      generatedAt: '2026-06-02T00:00:00.000Z',
      previousCursor: null,
      currentMaxCursor: '1000',
      matches: [sampleMatch()],
      evidence: [sampleEvidence()],
      previousMemory: null,
      localTimeZone: 'America/Sao_Paulo',
      workspaceId: 'T',
    });

    const invalid = {
      ...state,
      timeline: [
        {
          ...state.timeline[0],
          channels: [
            {
              ...state.timeline[0]?.channels[0],
              threads: [
                {
                  ...state.timeline[0]?.channels[0]?.threads[0],
                  messages: [
                    {
                      ...state.timeline[0]?.channels[0]?.threads[0]?.messages[0],
                      unexpectedMessageField: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(validate(invalid)).toBe(false);
  });
});

function sampleConfig(): AppConfig {
  return {
    storage: {
      slacrawlDatabasePath: '/tmp/slacrawl.db',
    },
    workspaceUrl: 'https://example.slack.com',
    prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
    model: {
      provider: 'openai',
      model: 'gpt-test',
    },
    channels: [
      {
        id: 'C',
        kind: 'channel',
        users: [
          { id: 'U', name: 'User', role: 'engineer' },
          { id: 'U2', name: 'Other User', role: 'designer' },
        ],
      },
    ],
    context: {},
  };
}

function sampleMatch(): MatchResult {
  return {
    channel: { id: 'C', kind: 'channel', users: [{ id: 'U', name: 'User', role: 'engineer' }] },
    matcherId: 'm',
    matcherType: 'regex',
    message: {
      channelId: 'C',
      ts: '1000',
      userId: 'U',
      text: 'planning',
    },
  };
}

function sampleEvidence(): EvidenceMessage {
  return {
    channelId: 'C',
    ts: '1000',
    userId: 'U',
    text: 'planning',
    source: 'match',
  };
}

function sampleOtherUserThreadRoot(): EvidenceMessage {
  return {
    channelId: 'C',
    ts: '1001',
    userId: 'UO',
    text: 'question',
    source: 'thread',
  };
}

function sampleReplyToOtherUserThread(): EvidenceMessage {
  return {
    channelId: 'C',
    ts: '1002',
    threadTs: '1001',
    userId: 'U',
    text: 'answer',
    source: 'thread',
  };
}
