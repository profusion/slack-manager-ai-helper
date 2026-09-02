import { describe, expect, it } from 'vitest';
import { defaultBaseInstructionsReference, readDefaultPrompt } from '../src/llm/default-prompts.js';
import {
  extractJsonSchemaBlock,
  extractMemorySection,
  extractReportSection,
  minifyJsonFencedBlocks,
  stripJsonSchemaFencedBlocks,
} from '../src/llm/markdown-schema.js';

describe('markdown schema extraction', () => {
  it('makes pure Markdown a base instruction for every configured analysis', () => {
    expect(readDefaultPrompt(defaultBaseInstructionsReference)).toContain(
      'pure CommonMark Markdown',
    );
    expect(readDefaultPrompt(defaultBaseInstructionsReference)).toContain(
      'never use markup such as <br>',
    );
  });

  it('extracts jsonschema fenced blocks', () => {
    const schema = extractJsonSchemaBlock('x\n```jsonschema\n{"type":"object"}\n```');

    expect(schema).toEqual({ type: 'object' });
  });

  it('returns undefined when no schema exists', () => {
    expect(extractJsonSchemaBlock('plain instructions')).toBeUndefined();
  });

  it('minifies json and jsonschema fenced blocks', () => {
    const markdown = minifyJsonFencedBlocks(`Example:
\`\`\`json
{
  "a": 1,
  "nested": {
    "b": true
  }
}
\`\`\`

\`\`\`jsonschema
{
  "type": "object",
  "properties": {
    "a": {
      "type": "number"
    }
  }
}
\`\`\``);

    expect(markdown).toContain('```json\n{"a":1,"nested":{"b":true}}\n```');
    expect(markdown).toContain(
      '```jsonschema\n{"type":"object","properties":{"a":{"type":"number"}}}\n```',
    );
  });

  it('rejects invalid json fenced blocks', () => {
    expect(() => minifyJsonFencedBlocks('```json\n{"a":\n```')).toThrow(SyntaxError);
  });

  it('strips jsonschema fenced blocks while keeping json examples', () => {
    const markdown = stripJsonSchemaFencedBlocks(
      [
        'Keep this.',
        '```jsonschema',
        '{"type":"object"}',
        '```',
        '```json',
        '{"example":true}',
        '```',
      ].join('\n'),
    );

    expect(markdown).not.toContain('jsonschema');
    expect(markdown).not.toContain('"type":"object"');
    expect(markdown).toContain('```json\n{"example":true}\n```');
  });

  it('extracts delimited memory sections', () => {
    expect(extractMemorySection('MEMORY:\nremember this\n\nANALYSIS:\nreport')).toBe(
      'remember this',
    );
  });

  it('extracts headed fenced memory and report sections', () => {
    const output = [
      '### MEMORY',
      '',
      '```json',
      '{"status":"ok"}',
      '```',
      '',
      '---',
      '',
      '### ANALYSIS',
      '',
      'Markdown report',
    ].join('\n');

    expect(extractMemorySection(output)).toBe('{"status":"ok"}');
    expect(extractReportSection(output)).toBe('Markdown report');
  });

  it('extracts report text after a memory delimiter when the analysis heading is omitted', () => {
    const output = [
      '### MEMORY',
      '',
      '```json',
      '{"status":"ok"}',
      '```',
      '',
      '---',
      '',
      '# Date: 2026-06-05',
      'Markdown report',
    ].join('\n');

    expect(extractReportSection(output)).toBe('# Date: 2026-06-05\nMarkdown report');
  });

  it('extracts only the fenced json from memory when delimiter text follows the fence', () => {
    const output = [
      '### MEMORY',
      '```json',
      '{"status":"ok"}',
      '```',
      '---',
      '# Date: 2026-06-05',
      'Markdown report',
    ].join('\n');

    expect(extractMemorySection(output)).toBe('{"status":"ok"}');
  });
});
