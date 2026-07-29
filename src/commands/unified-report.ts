import type { CommandModule } from 'yargs';
import { loadConfig } from '../config/load-config.js';
import { unifiedReport } from '../unified-report.js';
import { resolveFromConfig } from '../utils/paths.js';
import {
  type ConfigArgv,
  type DateRangeArgv,
  withConfigOption,
  withDateRangeOptions,
} from './shared.js';

type UnifiedReportArgv = ConfigArgv &
  DateRangeArgv & {
    readonly prompt: string;
    readonly days?: number | undefined;
    readonly stateOnly?: boolean | undefined;
  };

export const unifiedReportCommand: CommandModule<object, UnifiedReportArgv> = {
  command: 'unified-report',
  describe: 'build a unified report from stored model outputs',
  builder: (argv) =>
    withDateRangeOptions(withConfigOption(argv))
      .option('prompt', {
        type: 'string',
        demandOption: true,
        describe: 'Markdown prompt for synthesizing the unified report',
      })
      .option('days', {
        type: 'number',
        describe:
          'Number of local calendar days to include, ending today; mutually exclusive with date/window flags',
      })
      .option('state-only', {
        type: 'boolean',
        default: false,
        describe: 'Print only the assembled unified-report input JSON without calling the model',
      }),
  handler: async (argv) => {
    const resolved = await loadConfig(argv.config);
    const result = await unifiedReport(resolved, {
      promptPath: resolveFromConfig(resolved.configPath, argv.prompt),
      range: {
        date: argv.date,
        window: argv.window,
        startDate: argv.startDate,
        endDate: argv.endDate,
        days: argv.days,
      },
      stateOnly: argv.stateOnly,
    });

    if (argv.stateOnly || !result.modelCalled) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.reportText) {
      console.log(result.reportText);
    }
  },
};
