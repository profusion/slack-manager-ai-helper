import type { CommandModule } from 'yargs';
import { loadConfig } from '../config/load-config.js';
import { type ConfigArgv, withConfigOption } from './shared.js';

export const inspectConfigCommand: CommandModule<object, ConfigArgv> = {
  command: 'inspect-config',
  describe: 'print the resolved configuration',
  builder: withConfigOption,
  handler: async (argv) => {
    const resolved = await loadConfig(argv.config);
    console.log(JSON.stringify(resolved.config, null, 2));
  },
};
