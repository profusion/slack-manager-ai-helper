import { describe, expect, it } from 'vitest';
import { findMatchesDetailed } from '../src/matching/matchers.js';
import type { AppConfig, SlackMessage } from '../src/types.js';

describe('matching diagnostics', () => {
  it('reports skipped and matched message reasons without changing match output', async () => {
    const config: AppConfig = {
      workspaceUrl: 'https://example.slack.com',
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: { provider: 'openai', model: 'gpt-test' },
      channels: [
        {
          id: 'C_ALLOWED',
          users: [{ id: 'U_MATCH' }],
          matchers: [
            {
              id: 'skip_noise',
              type: 'exclude',
              matcher: { id: 'noise', type: 'text', terms: ['noise'] },
            },
            { id: 'plan', type: 'text', terms: ['plan'] },
          ],
        },
      ],
    };
    const messages: readonly SlackMessage[] = [
      { channelId: 'C_OTHER', ts: '1', text: 'plan elsewhere', userId: 'U_MATCH' },
      { channelId: 'C_ALLOWED', ts: '2', text: 'plan from someone else', userId: 'U_OTHER' },
      { channelId: 'C_ALLOWED', ts: '3', text: 'noise plan', userId: 'U_MATCH' },
      { channelId: 'C_ALLOWED', ts: '4', text: 'plain update', userId: 'U_MATCH' },
      { channelId: 'C_ALLOWED', ts: '5', text: 'plan update', userId: 'U_MATCH' },
    ];

    const result = await findMatchesDetailed(messages, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.matcherId).toBe('plan');
    expect(
      result.diagnostics.map((diagnostic) => (diagnostic.matched ? 'matched' : diagnostic.reason)),
    ).toEqual([
      'unconfigured_channel',
      'user_filter',
      'exclude_matcher',
      'no_positive_match',
      'matched',
    ]);
  });
});
