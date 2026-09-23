# Portfolio Automation

For the original generic portfolio automation source spec and roadmap, see [`run-portfolio.md`](./run-portfolio.md). This file tracks current implemented behavior and operational contracts.

## Schema and materialization

- `schemas/portfolio.schema.json` defines the generic portfolio manifest shape.
- `src/portfolio/load-portfolio.ts` validates portfolio manifests, enforces lifecycle semantics, and materializes target analysis configs with deterministic deep merge.
- Portfolio `analysisConfig` defaults and overrides must deep-merge into a complete `schemas/config.schema.json` config.
- Include required root fields such as `workspaceUrl`, `prompts`, and `model` at shared defaults when targets only override channels or matchers.
- Portfolio `defaults.matchers.pre/post` compose common matcher objects into every materialized channel matcher list after deep merge.
- Use `defaults.matchers.pre/post` for shared suppressors such as `exclude_laughs`.
- Target channel overrides may use `channels[].alsoChannels` so one user/matcher set covers multiple Slack sources. Portfolio materialization expands those entries through the shared config loader before validation against `schemas/config.schema.json`.
- Validate the final materialized config shape through `schemas/config.schema.json`.
- Portfolio `runAndNotifyConfig.name` defaults to the target display `name` when omitted.

## Execution

- `run-portfolio` analysis execution resolves each selected target to the existing `runOnce()` config shape.
- Attached rollups reuse `unified-report`.
- Maintenance runs `compact-state` over the same target state files.
- Portfolio `state.pathTemplate` renders with Handlebars.
- Markdown reports publish through `reports` Handlebars templates.
- When `reports.commit.enabled` is true, `run-portfolio` creates one git commit after all selected tasks finish.
- The execution-level commit considers touched report files, rollup report files, analysis state files, and maintenance state/backup files that live under the configured report archive repo.
- Only paths that `git status --porcelain` reports as changed are staged and committed. Gitignored paths (for example maintenance `*.bak` backups when `*.bak` is ignored) are skipped so `git add` does not fail after partial staging and leave the commit uncreated.
- Report publishing must not create one commit per report.
- Successful published reports deliver through `run-and-notify` using dotted CLI config arguments.
- When an analysis completes without a report, notification delivery sends `emptyReportMessageTemplate` instead of silently skipping it. The template is inherited through `runAndNotifyConfig` (portfolio defaults, analysis defaults, target, then run-specific overrides) and defaults to `No daily reports found - {{project}}`. Templates receive `project` as the target display name and `target.id` / `target.name`. The template is internal to portfolio execution and is never forwarded to `run-and-notify`.
- `run-portfolio --concurrency N` means up to `N` analysis/target lanes run in parallel.
- Tasks for the same `analysisId/targetId` remain ordered so analysis, rollup, and maintenance cannot overtake each other.
- `run-portfolio --date` overrides planned task windows and applies schedule-aware task selection for that local day without requiring `--due`.
- `run-portfolio --due` applies schedule-aware task selection at invocation time, including schedule time checks when `--date` is omitted.

## Manage portfolio wizard

- `manage-portfolio` is the interactive portfolio manifest editor in `src/portfolio/manage-portfolio.ts`.
- It edits manifest structures and JSON override blocks.
- It validates before saving.
- It writes timestamped backups.
- It previews with the same dry-run planner as `run-portfolio`.
- The CLI requires `--create` before starting a new missing manifest path.
- `manage-portfolio` can edit target channels with the shared config wizard prompts, including channel/user selection, role seeding from materialized configs, matcher copying, optional scored matcher provider overrides, and optional target-level model/scored-matcher default overrides while keeping raw JSON editing available.
- `manage-portfolio` edit target includes guided channel-member editing: select a target channel override, then add or remove configured members without re-running the full channel wizard.
- Channel-member add uses the slacrawl directory when available (with membership/message-derived candidates), falls back to manual user id entry, and reuses known roles from the target and sibling targets.
- Channel-member remove uses a multi-select of the channel's current configured users and omits empty `users` arrays from the channel override.
- `manage-portfolio` can move a configured member between targets: remove that user from every channel override on the source target and add them to every channel override on the destination target, preserving name/role and skipping channels where the user is already present.
- Move-member requires the source target to have at least one configured member and the destination target to have at least one channel override.
- `manage-portfolio` schedule prompts default to `22:00`.
- `manage-portfolio` submenus include a back option so selection and edit flows can return without changing the manifest.
- When adding a target, guided channel setup seeds known user roles from sibling targets in the same analysis.
- Guided target channel editing persists only target `analysisConfig` channel overrides; portfolio `defaults.matchers` pre/post entries are not written into target overrides.
- `manage-portfolio` prompts to add target-level `runAndNotifyConfig` after target creation and can configure SMTP/Slack transports with guided prompts or raw JSON editing.
- Portfolio-default guided `runAndNotifyConfig` prompts collect full transport settings. Analysis and target guided prompts collect only override fields that deep-merge on top of parent config, such as SMTP `to`, Slack `defaultChannel`, and optional Slack `thread`/`enabled`.
- Guided Slack transport prompts offer to disable classic link/media previews by setting `transports.slack.unfurlLinks` and `transports.slack.unfurlMedia` to `false` (proxied through `run-and-notify` to Better Notify / Slack `unfurl_links` and `unfurl_media`). When the user keeps previews enabled, those fields are omitted so Slack defaults apply.
- Target guided `runAndNotifyConfig` prompts ask separately for SMTP and Slack overrides. Omitted `name` values equal to the target display name because materialization defaults the notification name from the target.

### Non-interactive member editing

`portfolio-resource` provides agent-friendly `list`, `add`, `remove`, and `move` operations without the `manage-portfolio` prompt flow. It uses the wizard's channel-override member move semantics and the same validation, timestamped backup, and JSON save path. Membership mutations automatically pause affected active targets that become empty and activate affected paused targets receiving their first member; archived targets are never changed. Moves evaluate both ends, output records transitions in `detail.statusChanges`, and `--no-auto-status` disables lifecycle updates. See `specs/cli-commands.md` for flags and resolution rules.
