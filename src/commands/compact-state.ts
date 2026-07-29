import { copyFileSync, existsSync } from 'node:fs';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig } from '../config/load-config.js';
import { compactState, openStateStore } from '../state/state-store.js';
import { type ConfigArgv, withConfigOption } from './shared.js';

type CompactStateArgv = ConfigArgv & {
  readonly 'keep-runs': number;
  readonly backup: boolean;
};

export const compactStateCommand: CommandModule<object, CompactStateArgv> = {
  command: 'compact-state',
  describe: 'compact the topic state file by keeping the last N runs',
  builder: (argv) =>
    withConfigOption(argv)
      .option('keep-runs', {
        type: 'number',
        demandOption: true,
        describe: 'Number of newest runs to keep in state history',
      })
      .option('backup', {
        type: 'boolean',
        default: true,
        describe: 'Create a timestamped backup before rewriting the state file',
      })
      .check((argv) => {
        if (!Number.isInteger(argv['keep-runs']) || argv['keep-runs'] < 0) {
          throw new Error(
            `Invalid --keep-runs: expected an integer >= 0, received ${argv['keep-runs']}`,
          );
        }
        return true;
      }) as Argv<CompactStateArgv>,
  handler: async (argv) => {
    const resolved = await loadConfig(argv.config);
    const store = openStateStore(resolved.config.storage.statePath, resolved.topicId);
    const backupPath = argv.backup ? createStateBackup(store.statePath) : null;
    const result = compactState(store, { keepRuns: argv['keep-runs'] });

    console.log(
      JSON.stringify(
        {
          topicId: resolved.topicId,
          statePath: store.statePath,
          backupPath,
          ...result.summary,
        },
        null,
        2,
      ),
    );
  },
};

function createStateBackup(statePath: string): string | null {
  if (!existsSync(statePath)) {
    return null;
  }

  const backupPath = `${statePath}.${new Date().toISOString().replaceAll(/[:.]/g, '-')}.bak`;
  copyFileSync(statePath, backupPath);
  return backupPath;
}
