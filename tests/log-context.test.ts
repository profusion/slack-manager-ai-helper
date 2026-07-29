import { describe, expect, it } from 'vitest';
import { logMessageText } from '../src/log-context.js';

describe('log context', () => {
  it('truncates already-redacted message text for logs', () => {
    const text = logMessageText(
      {
        channelId: 'C',
        ts: '1000',
        text: '[REDACTED] and a long suffix',
      },
      {
        textLimit: 18,
      },
    );

    expect(text).toBe('[REDACTED] and a l...');
  });
});
