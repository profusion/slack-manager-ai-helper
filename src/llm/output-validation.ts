import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import * as addFormatsModule from 'ajv-formats';

export type OutputValidation = {
  readonly outputJson?: unknown;
  readonly schemaValid?: boolean;
  readonly schemaErrors?: unknown;
};

export function validateModelOutput(
  output: string | unknown,
  schema: unknown | undefined,
  minReportWords = 25,
): OutputValidation {
  if (!schema) {
    return {};
  }

  let outputJson: unknown;
  try {
    outputJson = typeof output === 'string' ? JSON.parse(output.trim()) : output;
  } catch (error) {
    return {
      schemaValid: false,
      schemaErrors: [
        {
          message: error instanceof Error ? error.message : 'Model output is not valid JSON',
        },
      ],
    };
  }

  const ajv = new Ajv2020({ allErrors: true });
  const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const schemaValid = validate(outputJson);
  const reportErrors = validateReportMarkdown(outputJson, minReportWords);
  const valid = schemaValid && reportErrors.length === 0;

  return {
    outputJson,
    schemaValid: valid,
    schemaErrors: valid ? undefined : [...(validate.errors ?? []), ...reportErrors],
  };
}

function validateReportMarkdown(
  outputJson: unknown,
  minReportWords: number,
): readonly { readonly message: string }[] {
  if (!outputJson || typeof outputJson !== 'object' || Array.isArray(outputJson)) {
    return [];
  }

  const reportText = (outputJson as { readonly reportText?: unknown }).reportText;
  if (reportText === undefined) {
    return [];
  }

  if (typeof reportText !== 'string' || reportText.trim().length === 0) {
    return [{ message: 'reportText must be non-empty Markdown text' }];
  }

  const errors: { message: string }[] = [];
  const reportWordCount = countMeaningfulReportWords(reportText);
  if (reportWordCount < minReportWords) {
    errors.push({
      message: `reportText must provide more detail: it has ${reportWordCount} meaningful words, but requires at least ${minReportWords}`,
    });
  }

  if (/(?:^|\n)#{1,6}\s*MEMORY\b/iu.test(reportText)) {
    errors.push({ message: 'reportText must not include a MEMORY section' });
  }

  if (/```(?:jsonschema|memory)\b/iu.test(reportText)) {
    errors.push({ message: 'reportText must not include memory or jsonschema fenced blocks' });
  }

  if (/<\/?[a-z][^>]*>/iu.test(reportText)) {
    errors.push({ message: 'reportText must use Markdown, not HTML tags' });
  }

  return errors;
}

function countMeaningfulReportWords(reportText: string): number {
  const text = reportText
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<https?:\/\/[^>]+>/gu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ');
  return text.match(/\p{L}{4,}/gu)?.length ?? 0;
}
