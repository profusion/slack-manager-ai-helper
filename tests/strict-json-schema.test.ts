import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractJsonSchemaBlock } from '../src/llm/markdown-schema.js';
import { openAiCompatibleJsonSchema, strictifyJsonSchema } from '../src/llm/strict-json-schema.js';

describe('strictifyJsonSchema', () => {
  it('requires every property and adds null for optional fields', () => {
    const strict = strictifyJsonSchema({
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['title'],
    });

    expect(strict).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: {
          type: ['array', 'null'],
          items: { type: 'string' },
        },
      },
      required: ['title', 'tags'],
      additionalProperties: false,
    });
  });

  it('adds additionalProperties false to nested objects', () => {
    const strict = strictifyJsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    }) as {
      readonly properties: {
        readonly project: {
          readonly required: readonly string[];
          readonly additionalProperties: boolean;
          readonly properties: {
            readonly name: { readonly type: readonly string[] };
          };
        };
      };
    };

    expect(strict.properties.project.additionalProperties).toBe(false);
    expect(strict.properties.project.required).toEqual(['id', 'name']);
    expect(strict.properties.project.properties.name.type).toEqual(['string', 'null']);
  });

  it('strictifies $defs and optional $ref properties', () => {
    const strict = strictifyJsonSchema({
      type: 'object',
      properties: {
        user: { $ref: '#/$defs/user' },
      },
      required: ['user'],
      $defs: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['id'],
        },
      },
    }) as {
      readonly $defs: {
        readonly user: {
          readonly required: readonly string[];
          readonly properties: {
            readonly name: { readonly type: readonly string[] };
          };
        };
      };
    };

    expect(strict.$defs.user.required).toEqual(['id', 'name']);
    expect(strict.$defs.user.properties.name.type).toEqual(['string', 'null']);
  });

  it('keeps already nullable optional fields and adds them to required', () => {
    const strict = strictifyJsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string' },
        note: { type: ['string', 'null'] },
      },
    }) as {
      readonly required: readonly string[];
      readonly properties: {
        readonly note: { readonly type: readonly string[] };
      };
    };

    expect(strict.required).toEqual(['id', 'note']);
    expect(strict.properties.note.type).toEqual(['string', 'null']);
  });

  it('strictifies the plan-reviews memory schema for structured output', async () => {
    const instructions = await readFile('examples/plan-reviews/INSTRUCTIONS.md', 'utf8');
    const memorySchema = extractJsonSchemaBlock(instructions);
    const strict = strictifyJsonSchema(memorySchema) as {
      readonly properties: {
        readonly project: {
          readonly required: readonly string[];
          readonly properties: {
            readonly name: { readonly type: readonly string[] };
          };
        };
      };
      readonly required: readonly string[];
    };

    expect(strict.properties.project.required).toEqual(['id', 'name']);
    expect(strict.properties.project.properties.name.type).toEqual(['string', 'null']);
    expect(strict.required).toContain('team_patterns');
  });

  it('removes unsupported regex lookarounds without weakening local schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        project: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^(?!unknown$).+' },
            name: { type: 'string', pattern: '^[A-Za-z ]+$' },
          },
        },
      },
    };

    expect(openAiCompatibleJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        project: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string', pattern: '^[A-Za-z ]+$' },
          },
        },
      },
    });
    expect(schema.properties.project.properties.id.pattern).toBe('^(?!unknown$).+');
  });
});
