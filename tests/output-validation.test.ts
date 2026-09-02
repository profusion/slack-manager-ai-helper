import { describe, expect, it } from 'vitest';
import { validateModelOutput } from '../src/llm/output-validation.js';

describe('output validation', () => {
  it('validates model output against an Ajv schema', () => {
    const result = validateModelOutput('{"status":"ok"}', {
      type: 'object',
      required: ['status'],
      properties: {
        status: { const: 'ok' },
      },
    });

    expect(result.schemaValid).toBe(true);
    expect(result.outputJson).toEqual({ status: 'ok' });
  });

  it('stores validation errors without throwing', () => {
    const result = validateModelOutput('{"status":"bad"}', {
      type: 'object',
      required: ['status'],
      properties: {
        status: { const: 'ok' },
      },
    });

    expect(result.schemaValid).toBe(false);
    expect(result.schemaErrors).toBeTruthy();
  });

  it('validates structured memory plus markdown report output', () => {
    const result = validateModelOutput(
      {
        memory: { status: 'ok' },
        reportText:
          '## Report\n\n- Completed detailed validation with concrete evidence and delivery confirmation.',
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['memory', 'reportText'],
        properties: {
          memory: {
            type: 'object',
            required: ['status'],
            properties: {
              status: { const: 'ok' },
            },
          },
          reportText: {
            type: 'string',
            minLength: 1,
          },
        },
      },
      1,
    );

    expect(result.schemaValid).toBe(true);
    expect(result.outputJson).toEqual({
      memory: { status: 'ok' },
      reportText:
        '## Report\n\n- Completed detailed validation with concrete evidence and delivery confirmation.',
    });
  });

  it('rejects empty structured markdown reports', () => {
    const result = validateModelOutput(
      {
        memory: { status: 'ok' },
        reportText: '   ',
      },
      {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: {
          memory: { type: 'object' },
          reportText: { type: 'string' },
        },
      },
    );

    expect(result.schemaValid).toBe(false);
    expect(JSON.stringify(result.schemaErrors)).toContain('reportText must be non-empty');
  });

  it('rejects reports padded only with Markdown punctuation and links', () => {
    const result = validateModelOutput(
      {
        memory: { status: 'ok' },
        reportText: '#\n\n---\n\n[](https://example.com/very-long-url)',
      },
      {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: {
          memory: { type: 'object' },
          reportText: { type: 'string' },
        },
      },
      1,
    );

    expect(result.schemaValid).toBe(false);
    expect(JSON.stringify(result.schemaErrors)).toContain('provide more detail');
  });

  it('requires 25 meaningful report words by default', () => {
    const result = validateModelOutput(
      {
        memory: { status: 'ok' },
        reportText: 'Completed detailed validation with evidence.',
      },
      {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: {
          memory: { type: 'object' },
          reportText: { type: 'string' },
        },
      },
    );

    expect(result.schemaValid).toBe(false);
    expect(JSON.stringify(result.schemaErrors)).toContain('requires at least 25');
  });

  it('counts only alphabetic words longer than three characters after Markdown cleanup', () => {
    const result = validateModelOutput(
      {
        memory: { status: 'ok' },
        reportText:
          '## Review\n\nCompleted [detailed validation](https://example.com/path) with evidence.',
      },
      {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: {
          memory: { type: 'object' },
          reportText: { type: 'string' },
        },
      },
      5,
    );

    expect(result.schemaValid).toBe(true);
  });

  it('rejects memory fences inside structured markdown reports', () => {
    const result = validateModelOutput(
      {
        memory: { status: 'ok' },
        reportText: ['## Report', '', '```jsonschema', '{}', '```'].join('\n'),
      },
      {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: {
          memory: { type: 'object' },
          reportText: { type: 'string' },
        },
      },
    );

    expect(result.schemaValid).toBe(false);
    expect(JSON.stringify(result.schemaErrors)).toContain('jsonschema fenced blocks');
  });

  it('rejects HTML tags inside structured markdown reports', () => {
    const result = validateModelOutput(
      { memory: { status: 'ok' }, reportText: '<br>Detailed report with sufficient evidence.' },
      {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: { memory: { type: 'object' }, reportText: { type: 'string' } },
      },
      1,
    );

    expect(result.schemaValid).toBe(false);
    expect(JSON.stringify(result.schemaErrors)).toContain('Markdown, not HTML');
  });
});
