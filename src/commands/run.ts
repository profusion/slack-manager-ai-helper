import type { CommandModule } from 'yargs';
import { loadConfig } from '../config/load-config.js';
import { normalizeDateRange } from '../date-range.js';
import { runOnce } from '../run-once.js';
import {
  type ConfigArgv,
  type DateRangeArgv,
  withConfigOption,
  withDateRangeOptions,
} from './shared.js';

export const runCommand: CommandModule<object, ConfigArgv & DateRangeArgv> = {
  command: 'run',
  describe: 'run one configured analysis',
  builder: (argv) => withDateRangeOptions(withConfigOption(argv)),
  handler: async (argv) => {
    const resolved = await loadConfig(argv.config);
    const result = await runOnce(resolved, undefined, {
      dateRange: normalizeDateRange({
        date: argv.date,
        window: argv.window,
        startDate: argv.startDate,
        endDate: argv.endDate,
      }),
    });
    if (result.reportText) {
      console.log(result.reportText);
    }
  },
};
