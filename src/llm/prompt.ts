import { readFile } from 'node:fs/promises';
import stateSchema from '../../schemas/state.schema.json' with { type: 'json' };
import type { CompiledPrompts, ResolvedAppConfig, RunState } from '../types.js';
import { readDefaultPrompt } from './default-prompts.js';
import {
  extractJsonSchemaBlock,
  minifyJsonFencedBlocks,
  stripJsonSchemaFencedBlocks,
} from './markdown-schema.js';
import { strictifyJsonSchema } from './strict-json-schema.js';

export async function compilePrompts(
  config: ResolvedAppConfig,
  state: RunState,
): Promise<CompiledPrompts> {
  const promptFiles = await Promise.all(config.prompts.map((promptPath) => readPrompt(promptPath)));
  const combinedPrompt = promptFiles
    .map((promptFile) => minifyJsonFencedBlocks(promptFile).trim())
    .join('\n\n');
  const outputSchema = extractJsonSchemaBlock(combinedPrompt);
  const strictMemorySchema = outputSchema ? strictifyJsonSchema(outputSchema) : undefined;
  const structuredOutputSchema = strictMemorySchema
    ? buildStructuredOutputSchema(strictMemorySchema, config.model.minReportWords ?? 25)
    : undefined;
  const promptInstructions = stripJsonSchemaFencedBlocks(combinedPrompt).trim();
  const systemSections = [
    promptInstructions,
    '# INPUT STATE JSON SCHEMA (minified)',
    JSON.stringify(stateSchema),
  ];

  if (strictMemorySchema) {
    systemSections.push(
      '# STRUCTURED OUTPUT CONTRACT',
      [
        'Return one JSON object with exactly two top-level fields: memory and reportText.',
        'The memory field must be a JSON object matching the output memory schema.',
        'The reportText field must be a non-empty Markdown report string. Do not use HTML tags.',
        'Do not wrap the response in Markdown fences.',
      ].join(' '),
      '# OUTPUT MEMORY JSON SCHEMA',
      JSON.stringify(strictMemorySchema),
    );
  }

  const promptSections = ['# STATE (minified)', `<json>\n${JSON.stringify(state)}\n</json>`];

  if (state.previousMemory.content) {
    promptSections.push('# PREVIOUS MEMORY', state.previousMemory.content);
  }

  return {
    system: systemSections.join('\n\n'),
    prompt: promptSections.join('\n\n'),
    outputSchema: strictMemorySchema,
    structuredOutputSchema,
  };
}

function buildStructuredOutputSchema(memorySchema: unknown, minReportWords: number): unknown {
  const memorySchemaObject =
    memorySchema && typeof memorySchema === 'object' && !Array.isArray(memorySchema)
      ? memorySchema
      : {};
  const { $defs, ...memorySchemaWithoutDefs } = memorySchemaObject as {
    readonly $defs?: unknown;
    readonly [key: string]: unknown;
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AnalysisStructuredOutput',
    type: 'object',
    additionalProperties: false,
    required: ['memory', 'reportText'],
    properties: {
      memory: memorySchemaWithoutDefs,
      reportText: {
        type: 'string',
        minLength: 1,
        pattern: '\\S',
        description: `Markdown report to show to the user with at least ${minReportWords} meaningful words. Do not include the memory JSON, jsonschema fences, or a MEMORY section.`,
      },
    },
    ...($defs === undefined ? {} : { $defs }),
  };
}

export async function readPrompt(promptReference: string): Promise<string> {
  return readDefaultPrompt(promptReference) ?? (await readFile(promptReference, 'utf8'));
}

export async function readMinifiedPrompt(promptReference: string): Promise<string> {
  return minifyJsonFencedBlocks(await readPrompt(promptReference)).trim();
}
