import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupeEvidence } from '../src/matching/dedupe.js';
import { findMatches, matches } from '../src/matching/matchers.js';
import type { AppConfig, ChannelConfig, EvidenceMessage, SlackMessage } from '../src/types.js';

const message: SlackMessage = {
  channelId: 'C1',
  ts: '1000',
  userId: 'U1',
  text: 'Planning update for today <@U_MANAGER>',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('matchers', () => {
  it('matches regex patterns', () => {
    expect(matches(message, { id: 'r', type: 'regex', pattern: '\\bplanning\\b' })).toBe(true);
  });

  it('defaults regex patterns to case-insensitive unicode matching', () => {
    expect(matches(message, { id: 'r', type: 'regex', pattern: '\\bplanning\\b' })).toBe(true);
    expect(matches(message, { id: 'r', type: 'regex', pattern: '\\bPLANNING\\b' })).toBe(true);
  });

  it('uses explicit regex flags when configured', () => {
    expect(
      matches(message, { id: 'r', type: 'regex', pattern: '\\bplanning\\b', flags: 'u' }),
    ).toBe(false);
    expect(
      matches(
        { ...message, text: 'ignore\nPlanning\nUpdate' },
        { id: 'r', type: 'regex', pattern: '^planning.update$', flags: 'imsu' },
      ),
    ).toBe(true);
  });

  it('matches mention patterns', () => {
    expect(matches(message, { id: 'm', type: 'mention', userId: 'U_MANAGER' })).toBe(true);
  });

  it('matches scored action-intent patterns', () => {
    expect(
      matches(
        { ...message, text: 'Can you follow up on the blocked auth action item?' },
        {
          id: 'action_intent',
          type: 'scored',
          question: 'Is this message an action a manager should track?',
          thresholds: {
            relatedFrom: 0.45,
          },
          scoring: {
            keywordWeight: 0.35,
            phraseWeight: 0.35,
            patternWeight: 0.25,
          },
          heuristics: {
            keywords: ['action', 'blocked'],
            phrases: ['follow up', 'action item'],
            patterns: ['\\bblocked\\b'],
          },
        },
      ),
    ).toBe(true);
  });

  it('rejects unrelated scored matcher messages', () => {
    expect(
      matches(
        { ...message, text: 'Lunch was moved to 12:30.' },
        {
          id: 'action_intent',
          type: 'scored',
          question: 'Is this message an action a manager should track?',
          thresholds: {
            relatedFrom: 0.45,
          },
          heuristics: {
            keywords: ['action', 'blocked'],
            phrases: ['follow up', 'action item'],
          },
        },
      ),
    ).toBe(false);
  });

  it('applies channel users and matchers as an AND for anchor matches', async () => {
    const config = sampleConfig({
      users: [{ id: 'U1' }],
      matchers: [{ id: 'planning', type: 'regex', pattern: '\\bplanning\\b' }],
    });
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update' },
      { channelId: 'C1', ts: '1001', userId: 'U2', text: 'planning update' },
      { channelId: 'C1', ts: '1002', userId: 'U1', text: 'hello' },
    ];

    expect((await findMatches(messages, config)).map((match) => match.message.ts)).toEqual([
      '1000',
    ]);
  });

  it('does not filter anchor matches by user when channel users are omitted', async () => {
    const config = sampleConfig({
      matchers: [{ id: 'planning', type: 'regex', pattern: '\\bplanning\\b' }],
    });
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update' },
      { channelId: 'C1', ts: '1001', userId: 'U2', text: 'planning update' },
    ];

    expect((await findMatches(messages, config)).map((match) => match.message.ts)).toEqual([
      '1000',
      '1001',
    ]);
  });

  it('matches every message in a configured channel when no positive matchers apply', async () => {
    const config = sampleConfig({});
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update' },
      { channelId: 'C1', ts: '1001', userId: 'U2', text: 'casual update' },
      { channelId: 'C2', ts: '1002', userId: 'U1', text: 'elsewhere' },
    ];

    const found = await findMatches(messages, config);

    expect(found.map((match) => match.message.ts)).toEqual(['1000', '1001']);
    expect(found.map((match) => match.matcherType)).toEqual(['channel', 'channel']);
  });

  it('uses global positive matchers to restrict configured channels without local matchers', async () => {
    const config: AppConfig = {
      ...sampleConfig({}),
      globalMatchers: [{ id: 'manager_mentions', type: 'mention', userId: 'U_MANAGER' }],
    };
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'please check <@U_MANAGER>' },
      { channelId: 'C1', ts: '1001', userId: 'U2', text: 'casual update' },
    ];

    const found = await findMatches(messages, config);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      matcherId: 'manager_mentions',
      matcherType: 'mention',
    });
  });

  it('stops evaluating matchers after the first positive match for a message', async () => {
    const config: AppConfig = {
      workspaceUrl: 'https://example.slack.com',
      storage: {
        slacrawlDatabasePath: '/tmp/slacrawl.db',
      },
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [{ id: 'global_planning', type: 'text', terms: ['planning'] }],
      channels: [
        {
          id: 'C1',
          matchers: [
            { id: 'channel_planning', type: 'regex', pattern: '\\bplanning\\b' },
            { id: 'expensive_scored', type: 'scored', question: 'Is this planning?' },
          ],
        },
      ],
      context: {},
    };

    const found = await findMatches(
      [{ channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update' }],
      config,
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      matcherId: 'global_planning',
      matcherType: 'text',
    });
  });

  it('suppresses otherwise matching messages with top-level exclude matchers', async () => {
    const config = sampleConfig({
      matchers: [
        {
          id: 'ignore_planning',
          type: 'exclude',
          matcher: { id: 'internal', type: 'text', terms: ['planning'] },
        },
        { id: 'planning', type: 'regex', pattern: '\\bplanning\\b' },
      ],
    });

    const found = await findMatches(
      [{ channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update' }],
      config,
    );

    expect(found).toEqual([]);
  });

  it('evaluates top-level exclude matchers before positive matchers regardless of order', async () => {
    const config = sampleConfig({
      matchers: [
        { id: 'planning', type: 'regex', pattern: '\\bplanning\\b' },
        {
          id: 'ignore_planning',
          type: 'exclude',
          matcher: { id: 'internal', type: 'text', terms: ['planning'] },
        },
      ],
    });

    const found = await findMatches(
      [{ channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update' }],
      config,
    );

    expect(found).toEqual([]);
  });

  it('supports exclude matchers that wrap positive AND expressions', async () => {
    const config = sampleConfig({
      matchers: [
        {
          id: 'ignore_manager_planning',
          type: 'exclude',
          matcher: {
            id: 'manager_planning',
            type: 'and',
            matchers: [
              { id: 'manager', type: 'mention', userId: 'U_MANAGER' },
              { id: 'planning_text', type: 'text', terms: ['planning'] },
            ],
          },
        },
        { id: 'planning', type: 'regex', pattern: '\\bplanning\\b' },
      ],
    });
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update <@U_MANAGER>' },
      { channelId: 'C1', ts: '1001', userId: 'U1', text: 'planning update' },
    ];

    expect((await findMatches(messages, config)).map((match) => match.message.ts)).toEqual([
      '1001',
    ]);
  });

  it('supports exclude matchers that wrap positive OR expressions', async () => {
    const config = sampleConfig({
      matchers: [
        {
          id: 'ignore_noise',
          type: 'exclude',
          matcher: {
            id: 'noise',
            type: 'or',
            matchers: [
              { id: 'archived', type: 'text', terms: ['archived'] },
              { id: 'cancelled', type: 'text', terms: ['cancelled'] },
            ],
          },
        },
        { id: 'planning', type: 'regex', pattern: '\\bplanning\\b' },
      ],
    });
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'planning update archived' },
      { channelId: 'C1', ts: '1001', userId: 'U1', text: 'planning update cancelled' },
      { channelId: 'C1', ts: '1002', userId: 'U1', text: 'planning update' },
    ];

    expect((await findMatches(messages, config)).map((match) => match.message.ts)).toEqual([
      '1002',
    ]);
  });

  it('uses top-level scored matcher defaults for provider execution', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaGenerateResponse('related')));
    vi.stubGlobal('fetch', fetchMock);

    const config = sampleConfig({
      matchers: [
        {
          id: 'provider_action',
          type: 'scored',
          question: 'Is this an action?',
          thresholds: {
            ambiguousFrom: 0.4,
            ambiguousBelow: 0.99,
            relatedFrom: 0.99,
          },
          scoring: {
            semanticSimilarityWeight: 0.5,
          },
        },
      ],
    });
    const messages: SlackMessage[] = [
      { channelId: 'C1', ts: '1000', userId: 'U1', text: 'please follow up' },
    ];

    const matches = await findMatches(messages, {
      ...config,
      scoredMatcherDefaults: {
        embeddings: {
          enabled: true,
          provider: 'ollama',
          model: 'nomic-embed-text',
        },
        classifier: {
          enabled: true,
          provider: 'ollama',
          model: 'qwen3:0.6b',
          useForRanges: ['ambiguous'],
        },
      },
    });

    expect(matches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('supports provider-backed scored matchers nested in positive AND and OR expressions', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaGenerateResponse('related')));
    vi.stubGlobal('fetch', fetchMock);

    const found = await findMatches(
      [{ channelId: 'C1', ts: '1000', userId: 'U1', text: 'please follow up <@U_MANAGER>' }],
      {
        ...sampleConfig({
          matchers: [
            {
              id: 'manager_action',
              type: 'and',
              matchers: [
                { id: 'manager_mentions', type: 'mention', userId: 'U_MANAGER' },
                {
                  id: 'action_any',
                  type: 'or',
                  matchers: [
                    { id: 'unmatched_text', type: 'text', terms: ['not present'] },
                    {
                      id: 'provider_action',
                      type: 'scored',
                      question: 'Is this an action?',
                      thresholds: {
                        ambiguousFrom: 0.4,
                        ambiguousBelow: 0.99,
                        relatedFrom: 0.99,
                      },
                      scoring: {
                        semanticSimilarityWeight: 0.5,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
        scoredMatcherDefaults: {
          embeddings: {
            enabled: true,
            provider: 'ollama',
            model: 'nomic-embed-text',
          },
          classifier: {
            enabled: true,
            provider: 'ollama',
            model: 'qwen3:0.6b',
            useForRanges: ['ambiguous'],
          },
        },
      },
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      matcherId: 'manager_action',
      matcherType: 'and',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('matches global matchers without configured channels', async () => {
    const config: AppConfig = {
      workspaceUrl: 'https://example.slack.com',
      storage: {
        slacrawlDatabasePath: '/tmp/slacrawl.db',
      },
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [{ id: 'manager_mentions', type: 'mention', userId: 'U_MANAGER' }],
      context: {},
    };

    const found = await findMatches(
      [{ channelId: 'C_ANY', ts: '1000', userId: 'U1', text: 'please check <@U_MANAGER>' }],
      config,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.channel).toEqual({ id: 'C_ANY', kind: 'unknown' });
  });

  it('does not match every message when only global matchers are configured', async () => {
    const config: AppConfig = {
      workspaceUrl: 'https://example.slack.com',
      storage: {
        slacrawlDatabasePath: '/tmp/slacrawl.db',
      },
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [{ id: 'manager_mentions', type: 'mention', userId: 'U_MANAGER' }],
      context: {},
    };

    const found = await findMatches(
      [{ channelId: 'C_ANY', ts: '1000', userId: 'U1', text: 'general update' }],
      config,
    );

    expect(found).toEqual([]);
  });
});

describe('dedupeEvidence', () => {
  it('deduplicates by message id and falls back to channel timestamp', () => {
    const evidence: EvidenceMessage[] = [
      { ...message, messageId: 'm1', source: 'match' },
      { ...message, messageId: 'm1', source: 'nearby' },
      { ...message, messageId: undefined, ts: '1001', source: 'nearby' },
      { ...message, messageId: undefined, ts: '1001', source: 'thread' },
    ];

    expect(dedupeEvidence(evidence)).toHaveLength(2);
  });

  it('preserves anchor match source when a matched message was first added as context', () => {
    const evidence: EvidenceMessage[] = [
      { ...message, messageId: 'm1', source: 'nearby' },
      { ...message, messageId: 'm1', source: 'match' },
    ];

    expect(dedupeEvidence(evidence)).toEqual([{ ...message, messageId: 'm1', source: 'match' }]);
  });
});

function sampleConfig(channel: Omit<ChannelConfig, 'id'>): AppConfig {
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
    channels: [{ ...channel, id: 'C1' }],
    context: {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
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

function ollamaGenerateResponse(response: string): unknown {
  return {
    model: 'qwen3:0.6b',
    created_at: '2026-06-05T00:00:00Z',
    response,
    done: true,
    context: [],
    total_duration: 1,
    load_duration: 1,
    prompt_eval_count: 1,
    eval_count: 1,
  };
}
