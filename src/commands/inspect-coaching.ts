import type { CommandModule } from 'yargs';
import { readStateStore } from '../state/state-store.js';

type InspectCoachingArgv = {
  readonly state: string;
  readonly date?: string | undefined;
  readonly user?: string | undefined;
};

export const inspectCoachingCommand: CommandModule<object, InspectCoachingArgv> = {
  command: 'inspect-coaching',
  describe: 'inspect stored per-day plan-coach messages and delivery status',
  builder: (argv) =>
    argv
      .option('state', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the portfolio target state JSON file',
      })
      .option('date', { type: 'string', describe: 'Filter by local date (YYYY-MM-DD)' })
      .option('user', { type: 'string', describe: 'Filter by Slack user id' }),
  handler: (argv) => {
    const store = readStateStore(argv.state);
    const coaching = store.state.runs
      .flatMap((run) => (run.coaching ?? []).map((record) => ({ runId: run.id, ...record })))
      .filter(
        (record) =>
          (argv.date === undefined || record.date === argv.date) &&
          (argv.user === undefined || record.userId === argv.user),
      );
    console.log(
      JSON.stringify(
        { topicId: store.state.topicId, statePath: store.statePath, coaching },
        null,
        2,
      ),
    );
  },
};
