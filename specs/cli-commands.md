# CLI Commands

Use `pnpm run slack-manager-ai-helper <command>` during local development, or the bundled `slack-manager-ai-helper` binary after packaging/installing.

## Run commands

- `pnpm run slack-manager-ai-helper run --config examples/plan-reviews-config.json`
- `pnpm run slack-manager-ai-helper run --config examples/plan-reviews-config.json --date YYYY-MM-DD|today|yesterday` filters the model timeline to one local date.
- `--window current-workday|previous-workday|previous-5-workdays` selects named local workday ranges.
- `--start-date` and `--end-date` define an inclusive local-date range.
- Date-limited runs and runtime preparation filter matched anchors and diagnostics to the requested local date range before evidence expansion, so preview matches and model evidence stay consistent.
- Explicit date/window runs scan from the requested range and do not affect the next implicit run start.
- `pnpm run slack-manager-ai-helper run --config examples/plan-reviews-minimal-config.json`
- `pnpm run slack-manager-ai-helper run --config examples/actions-followup-minimal-config.json`

## Model input and reports

- `pnpm run slack-manager-ai-helper collect-model-input --config examples/plan-reviews-config.json` prints the compiled model input without calling the model or updating state.
- When no model input would be generated, `collect-model-input` prints JSON with a `reason`.
- Add `--state-only` to stop before prompt compilation and print the compact JSON state.
- `pnpm run slack-manager-ai-helper unified-report --config examples/plan-reviews-config.json --prompt examples/plan-reviews/WEEKLY_REPORT.md --days 5` synthesizes a read-only report from stored model outputs.
- `--days N` selects today plus the previous `N - 1` local dates using `TZ`.
- `--date`, `--window`, or `--start-date`/`--end-date` select explicit local-date ranges for `unified-report`.
- `--state-only` prints the assembled source-report JSON without calling the model.
- `unified-report` does not scan slacrawl, create runs, save memory, or persist model outputs.
- `unified-report` joins completed canonical runs, stored model outputs, and evidence dates from the state file, then calls the configured model with the separate rollup prompt.

## Config wizard commands

- `pnpm run slack-manager-ai-helper create-config --reference examples/plan-reviews-minimal-config.json [--output my-topic-config.json]` opens an interactive config builder seeded from a reference config.
- `--date`, `--start-date`, and `--end-date` on `create-config` affect only the builder's preview and dry-run.
- `pnpm run slack-manager-ai-helper edit-config --config examples/plan-reviews-config.json [--reference examples/plan-reviews-minimal-config.json]` edits an existing config in place with the shared config wizard flow.
- `edit-config` validates before saving, writes a timestamped `.bak`, and uses the optional reference for copyable roles and matchers.
- `create-config` may reference, copy, or copy-and-edit prompt files.
- Prompt editing must always happen on a copied prompt near the output config and never on the original reference prompt.
- `create-config` should default `Add user filter...?` prompts to yes and include a fake cancel option in user search so the user can back out without adding a selected user.
- `create-config` role prompts should seed choices from all reference channel user roles, even when the channel being added was not copied from the reference config.
- `create-config` preview/testing should default to the last two local days ending at the latest configured Slack source message when no date range was provided, and must ask for confirmation before scanning real messages.
- If `create-config` cannot generate a test report and the user does not choose to continue without one, return to channel/context editing instead of finishing the command.
- `create-config` match previews should group matched anchors and ignored messages by channel then local date, show channel id plus name, use per-message `HH:MM`, and print match/ignore reason before `Name (ID): message`.
- `create-config` matcher sample tests should ask whether the tested matcher is OK; a negative answer must loop back to edit the matcher before accepting it.
- `create-config` matcher type selection should include a cancel option that stops adding the matcher without writing a partial matcher config.
- `create-config` exclude-wrapper child selection should explain that the child matcher suppresses matching messages, and must not offer another `exclude` option because nested excludes are invalid.
- `create-config` omits optional top-level arrays such as `channels` and `globalMatchers` when they are empty.
- Do not serialize `channels: []` because the schema only allows omitted channels or a non-empty channels array.
- Interactive config creation must reuse the same redacted scan, matching, evidence expansion, prompt compilation, and dry-run paths as `run` and `collect-model-input`.
- Do not add separate preview-only matching behavior.

## Portfolio commands

- `pnpm run slack-manager-ai-helper run-portfolio --manifest examples/portfolio-plan-reviews.json --dry-run` prints a read-only portfolio execution plan.
- `--date YYYY-MM-DD|today|yesterday` on `run-portfolio` overrides planned task windows and plans only tasks whose schedule matches that local day.
- `--due` on `run-portfolio` plans tasks due at invocation time using the current local day and schedule time.
- Analysis execution, attached rollups, maintenance, report publishing, notification delivery, and target-lane parallelism with `--concurrency N` are available.
- `pnpm run slack-manager-ai-helper manage-portfolio --manifest examples/portfolio-plan-reviews.json` opens the interactive portfolio manifest editor.
- `manage-portfolio` can add/edit analyses, targets, runs, rollups, maintenance, target lifecycle status, and `runAndNotifyConfig` overrides.
- `manage-portfolio` submenus include a back option so flows such as edit target can return without saving changes.
- `manage-portfolio` can configure `runAndNotifyConfig` with guided SMTP/Slack transport prompts or raw JSON editing.
- `manage-portfolio` edit target includes runAndNotifyConfig editing and channel-member add/remove for a selected target channel.
- `manage-portfolio` can move a member between targets, removing them from every source-target channel and adding them to every destination-target channel.

## Inspection and validation

- `pnpm run slack-manager-ai-helper inspect-config --config examples/plan-reviews-config.json`
- `pnpm run slack-manager-ai-helper validate-config --config examples/plan-reviews-config.json` exits `0` on success and writes JSON validation/load errors to stderr with exit `1`, without Pino logging.
- `pnpm run slack-manager-ai-helper compact-state --config examples/plan-reviews-config.json --keep-runs 20` compacts the topic state file and writes a timestamped backup unless `--no-backup` is passed.
- `pnpm run slack-manager-ai-helper resolve-evidence --config examples/plan-reviews-config.json --id '2026-06-05T12-00-00-000Z:0' [--output link|json]` resolves evidence by persisted `run-id:index` id or by unique Slack/slacrawl `messageId` UUID.
- `resolve-evidence --output link` prints the configured Slack HTTP permalink.
- `resolve-evidence --output json` includes the redacted stored evidence record, how the id was resolved, state path, computed reference fields, and a labeled `slack-reference` coordinate.

## Ollama helpers

- `pnpm run ollama:classifier` checks/starts Ollama, pulls `OLLAMA_CLASSIFIER_MODEL` (default `qwen3:0.6b`), and smoke-tests `/api/generate`.
- `pnpm run ollama:embeddings` checks/starts Ollama, pulls `OLLAMA_EMBEDDINGS_MODEL` (default `nomic-embed-text`), and smoke-tests `/api/embed`.
- `pnpm run test:ollama` runs optional localhost Ollama scored-matcher integration tests; it is not part of normal `pnpm run qa`.
- Keep Ollama tests sequential and avoid parallel Ollama requests.
- Tune Ollama tests with `OLLAMA_TEST_TIMEOUT_MS` and `OLLAMA_PROVIDER_TIMEOUT_MS` when local models are slow.

## `portfolio-resource`

`portfolio-resource <action> --manifest <path>` lists and edits portfolio channel membership without prompts. Relative manifest paths use `INIT_CWD` when set, otherwise the current directory. `--analysis <id>` selects an analysis; it may be omitted only when the manifest has one analysis. `--dry-run` validates and computes edits without writing or creating a backup.

Actions:

- `list [--target <id>]` prints targets, channels, and users.
- `add --target <id> --user <id-or-name> --channel <id> [--role <role>]` adds a user. IDs take precedence over case-insensitive exact full-name matches. The explicit role wins, then a known manifest role is reused.
- `remove --target <id> --user <id-or-name> [--channel <id>]` removes the user from all target channels, or only the selected channel.
- `move --from <target-id> --to <target-id> --user <id-or-name>` removes the user from every source override and adds them to every destination override, skipping duplicates.

Successful output is one JSON object with the action, resolved paths and user, affected targets/channels, change state, dry-run state, and backup path. After any add, remove, or move, an `active` affected target with no configured users across its channel overrides becomes `paused`; a `paused` target that had no members and receives its first member becomes `active`. Archived targets and all other status values are untouched. Moves evaluate both source and destination. `--no-auto-status` disables these transitions. Mutation output always includes `detail.statusChanges`, which is an array of `{ targetId, from, to }` objects and is empty when no transition occurs. Writes use the same validation and timestamped backup behavior as `manage-portfolio`.

```bash
pnpm run slack-manager-ai-helper portfolio-resource list --manifest portfolio.json
pnpm run slack-manager-ai-helper portfolio-resource add --manifest portfolio.json --target team-b --user 'Ada Lovelace' --channel C2
pnpm run slack-manager-ai-helper portfolio-resource remove --manifest portfolio.json --target team-a --user U1 --channel C1
pnpm run slack-manager-ai-helper portfolio-resource move --manifest portfolio.json --from team-a --to team-b --user U1 --dry-run
```
