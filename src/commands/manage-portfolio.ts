import type { CommandModule } from 'yargs';
import { runManagePortfolioWizard } from '../portfolio/manage-portfolio.js';

type ManagePortfolioArgv = {
  readonly manifest: string;
  readonly create?: boolean | undefined;
  readonly createCustomPrompt?: boolean | undefined;
};

export const managePortfolioCommand: CommandModule<object, ManagePortfolioArgv> = {
  command: 'manage-portfolio',
  describe: 'interactively maintain a portfolio manifest',
  builder: (argv) =>
    argv
      .option('manifest', {
        type: 'string',
        demandOption: true,
        describe: 'Path to a portfolio manifest JSON file',
      })
      .option('create', {
        type: 'boolean',
        default: false,
        describe: 'Create a new manifest when the path does not exist',
      })
      .option('create-custom-prompt', {
        type: 'boolean',
        default: true,
        describe: 'Create an empty custom prompt file for new targets',
      }),
  handler: async (argv) => {
    const result = await runManagePortfolioWizard({
      manifest: argv.manifest,
      createIfMissing: argv.create,
      createCustomPrompt: argv.createCustomPrompt,
    });
    if (result.saved) {
      console.log(
        JSON.stringify(
          {
            manifestPath: result.manifestPath,
            saved: true,
            backupPath: result.backupPath,
          },
          null,
          2,
        ),
      );
    }
  },
};
