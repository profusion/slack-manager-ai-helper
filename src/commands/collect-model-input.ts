import type { CommandModule } from 'yargs';
import { collectModelInput } from '../collect-model-input.js';
import { loadConfig } from '../config/load-config.js';
import { normalizeDateRange } from '../date-range.js';
import {
  type ConfigArgv,
  type DateRangeArgv,
  withConfigOption,
  withDateRangeOptions,
} from './shared.js';

type CollectModelInputArgv = ConfigArgv &
  DateRangeArgv & {
    readonly stateOnly?: boolean | undefined;
  };

export const collectModelInputCommand: CommandModule<object, CollectModelInputArgv> = {
  command: 'collect-model-input',
  describe: 'print the compiled model input without calling the model',
  builder: (argv) =>
    withDateRangeOptions(withConfigOption(argv)).option('state-only', {
      type: 'boolean',
      default: false,
      describe: 'Print only the compact JSON state before prompt compilation',
    }),
  handler: async (argv) => {
    const resolved = await loadConfig(argv.config);
    const result = await collectModelInput(resolved, {
      dateRange: normalizeDateRange({
        date: argv.date,
        window: argv.window,
        startDate: argv.startDate,
        endDate: argv.endDate,
      }),
      stateOnly: argv.stateOnly,
    });
    console.log(JSON.stringify(result, null, 2));
  },
};
