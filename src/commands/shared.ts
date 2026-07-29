import type { Argv } from 'yargs';

export type ConfigArgv = {
  readonly config: string;
};

export type DateRangeArgv = {
  readonly date?: string | undefined;
  readonly window?: string | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
};

export function withConfigOption(argv: Argv): Argv<ConfigArgv> {
  return argv.option('config', {
    type: 'string',
    demandOption: true,
    describe: 'Path to a topic JSON config file',
  }) as Argv<ConfigArgv>;
}

export function withDateRangeOptions<T>(argv: Argv<T>): Argv<T & DateRangeArgv> {
  return argv
    .option('date', {
      type: 'string',
      describe:
        'Only include this local date in preview/model timeline operations (YYYY-MM-DD, today, or yesterday)',
    })
    .option('window', {
      type: 'string',
      choices: ['current-workday', 'previous-workday', 'previous-5-workdays'] as const,
      describe: 'Named local date window to include in preview/model timeline operations',
    })
    .option('start-date', {
      type: 'string',
      describe:
        'First local date to include in preview/model timeline operations, inclusive (YYYY-MM-DD)',
    })
    .option('end-date', {
      type: 'string',
      describe:
        'Last local date to include in preview/model timeline operations, inclusive (YYYY-MM-DD)',
    }) as Argv<T & DateRangeArgv>;
}
