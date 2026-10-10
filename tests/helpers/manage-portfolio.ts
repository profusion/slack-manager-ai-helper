import { vi } from 'vitest';
import type { PortfolioPromptApi } from '../../src/portfolio/manage-portfolio.js';

export function createPromptApi(input: {
  readonly selects?: readonly unknown[] | undefined;
  readonly inputs?: readonly string[] | undefined;
  readonly confirms?: readonly boolean[] | undefined;
  readonly editors?: readonly string[] | undefined;
  readonly numbers?: readonly number[] | undefined;
  readonly checkboxes?: readonly unknown[][] | undefined;
  readonly searchIndexes?: readonly number[] | undefined;
}): PortfolioPromptApi {
  const selects = [...(input.selects ?? [])];
  const inputs = [...(input.inputs ?? [])];
  const confirms = [...(input.confirms ?? [])];
  const editors = [...(input.editors ?? [])];
  const numbers = [...(input.numbers ?? [])];
  const checkboxes = [...(input.checkboxes ?? [])];
  const searchIndexes = [...(input.searchIndexes ?? [])];
  return {
    select: vi.fn(async () => shift(selects, 'select')),
    input: vi.fn(async () => shift(inputs, 'input')),
    confirm: vi.fn(async () => shift(confirms, 'confirm')),
    editor: vi.fn(async () => shift(editors, 'editor')),
    number: vi.fn(async () => shift(numbers, 'number')),
    checkbox: vi.fn(async () => checkboxes.shift() ?? []),
    search: vi.fn(async (config: Parameters<PortfolioPromptApi['search']>[0]) => {
      const choices = await config.source(undefined, { signal: new AbortController().signal });
      const selectedIndex = searchIndexes.shift() ?? 0;
      const selected = choices[selectedIndex];
      if (selected && typeof selected === 'object' && 'value' in selected) {
        return selected.value;
      }
      return selected;
    }),
  } as unknown as PortfolioPromptApi;
}

export function createManifest() {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        prompts: ['@DEFAULT_BASE_INSTRUCTIONS@'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
      },
    },
    analyses: [
      {
        id: 'plan-reviews',
        name: 'Plan Reviews',
        runs: [
          {
            id: 'daily',
            schedule: { kind: 'workdays' },
            window: { date: 'today' },
          },
        ],
        targets: [
          {
            id: 'project-alpha',
            name: 'Project Alpha',
            status: 'active',
            analysisConfig: {
              channels: [{ id: 'C_ALPHA' }],
            },
          },
        ],
      },
    ],
  } as const;
}

function shift<T>(values: T[], label: string): T {
  const value = values.shift();
  if (value === undefined) {
    throw new Error(`No mocked ${label} value left`);
  }
  return value;
}
