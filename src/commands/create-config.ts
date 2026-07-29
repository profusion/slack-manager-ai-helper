import type { Argv, CommandModule } from 'yargs';
import { runCreateConfigWizard } from '../config-wizard/wizard.js';
import { normalizeDateRange } from '../date-range.js';
import { type DateRangeArgv, withDateRangeOptions } from './shared.js';

type CreateConfigArgv = DateRangeArgv & {
  readonly reference: string;
  readonly output?: string | undefined;
};

export const createConfigCommand: CommandModule<object, CreateConfigArgv> = {
  command: 'create-config',
  describe: 'interactively create a topic JSON config from a reference config',
  builder: (argv) => {
    const configured = withDateRangeOptions(
      argv
        .option('reference', {
          type: 'string',
          demandOption: true,
          describe: 'Reference config to seed the interactive builder',
        })
        .option('output', {
          type: 'string',
          describe: 'Output config path; prompted when omitted',
        }),
    );
    return configured as Argv<CreateConfigArgv>;
  },
  handler: async (argv) => {
    const result = await runCreateConfigWizard({
      reference: argv.reference,
      output: argv.output,
      dateRange: normalizeDateRange({
        date: argv.date,
        window: argv.window,
        startDate: argv.startDate,
        endDate: argv.endDate,
      }),
    });
    console.log(`Created ${result.outputPath}`);
  },
};
