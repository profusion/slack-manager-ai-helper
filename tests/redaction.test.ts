import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/redaction.js';

describe('redaction', () => {
  it('redacts built-in secret patterns', () => {
    const redactor = createRedactor(undefined);
    const text = [
      'Authorization: Bearer abc.def.ghi',
      'aws AKIAIOSFODNN7EXAMPLE',
      'slack xoxb-123456789012-abcdefghijklmnop',
      'github ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ',
      'entropy abcdefghijklmnopqrstuvwxyzABCDEF',
      'key="abcdefghijklmnopqrstuvwxyzABCDEF123456"',
    ].join('\n');

    expect(redactor.redactText(text)).toMatchInlineSnapshot(`
      "Authorization: [REDACTED]
      aws [REDACTED]
      slack [REDACTED]
      github [REDACTED]
      entropy [REDACTED]
      [REDACTED]"
    `);
  });

  it('applies additional user patterns', () => {
    const redactor = createRedactor({
      additionalPatterns: [
        {
          id: 'internal-ticket-secret',
          pattern: 'ticket-secret-[0-9]+',
          flags: 'i',
        },
      ],
    });

    expect(redactor.redactText('Use ticket-secret-12345')).toBe('Use [REDACTED]');
  });
});
