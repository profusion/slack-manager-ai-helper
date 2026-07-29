import type { Argv, CommandModule } from 'yargs';
import { runEditConfigWizard } from '../config-wizard/wizard.js';
import { normalizeDateRange } from '../date-range.js';
import { type DateRangeArgv, withDateRangeOptions } from './shared.js';

type EditConfigArgv = DateRangeArgv & {
  readonly config: string;
  readonly reference?: string | undefined;
};

export const editConfigCommand: CommandModule<object, EditConfigArgv> = {
  command: 'edit-config',
  describe: 'interactively edit a topic JSON config in place',
  builder: (argv) => {
    const configured = withDateRangeOptions(
      argv
        .option('config', {
          type: 'string',
          demandOption: true,
          describe: 'Config path to edit in place',
        })
        .option('reference', {
          type: 'string',
          describe: 'Optional reference config for copyable roles, matchers, and settings',
        }),
    );
    return configured as Argv<EditConfigArgv>;
  },
  handler: async (argv) => {
    const result = await runEditConfigWizard({
      config: argv.config,
      reference: argv.reference,
      dateRange: normalizeDateRange({
        date: argv.date,
        window: argv.window,
        startDate: argv.startDate,
        endDate: argv.endDate,
      }),
    });
    console.log(
      JSON.stringify(
        {
          configPath: result.outputPath,
          backupPath: result.backupPath,
        },
        null,
        2,
      ),
    );
  },
};
