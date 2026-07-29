#!/usr/bin/env node
import './env.js';
import process from 'node:process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { collectModelInputCommand } from './commands/collect-model-input.js';
import { compactStateCommand } from './commands/compact-state.js';
import { createConfigCommand } from './commands/create-config.js';
import { editConfigCommand } from './commands/edit-config.js';
import { inspectConfigCommand } from './commands/inspect-config.js';
import { managePortfolioCommand } from './commands/manage-portfolio.js';
import { resolveEvidenceCommand } from './commands/resolve-evidence.js';
import { runCommand } from './commands/run.js';
import { runPortfolioCommand } from './commands/run-portfolio.js';
import { unifiedReportCommand } from './commands/unified-report.js';
import { validateConfigCommand } from './commands/validate-config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('slack-manager-ai-helper')
    .usage('$0 <command> --config <file>')
    .command(runCommand)
    .command(createConfigCommand)
    .command(editConfigCommand)
    .command(compactStateCommand)
    .command(collectModelInputCommand)
    .command(inspectConfigCommand)
    .command(resolveEvidenceCommand)
    .command(unifiedReportCommand)
    .command(runPortfolioCommand)
    .command(managePortfolioCommand)
    .command(validateConfigCommand)
    .demandCommand(1, 'Choose a command.')
    .strict()
    .recommendCommands()
    .help()
    .alias('h', 'help')
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .parseAsync();
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'command failed');
  process.exit(1);
});
