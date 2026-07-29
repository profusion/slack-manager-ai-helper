# Run Portfolio Automation

## Problem

Running many related manager workflows with one config file and one shell-script entry per project
does not scale. The current plan review workflow already needs separate analysis configs,
notification configs, state files, logs, reports, and ad hoc shell orchestration. That is manageable
for a few projects, but not for dozens of active and inactive projects.

The automation also needs to support workflows beyond daily planning reviews. A future SWOT
workflow, for example, may monitor similar Slack sources with different prompts, matchers, report
cadence, and recipients.

## Goals

- Provide a generic portfolio runner for multiple analysis workflows.
- Keep `plan-reviews` as the first concrete example, not a hardcoded concept.
- Let cron call one command that resolves due analysis runs, rollups, and maintenance tasks.
- Use a private ops manifest as the human-edited source of truth.
- Preserve existing single-config commands for one-off use and debugging.
- Reuse the existing `runOnce()` analysis path instead of adding parallel matching or prompt logic.
- Reuse `run-and-notify` for email and Slack delivery.
- Publish immutable markdown reports plus stable latest views in a private report archive repo.
- Keep JSONL logs, temporary files, secrets, and default local state out of Git.

## Non-Goals

- Replace `run`, `unified-report`, or `compact-state`.
- Add a new scheduler. Cron remains the external trigger.
- Add native SMTP or Slack transports to this repository.
- Commit JSONL logs or secrets.
- Make `plan-reviews` special in code or report layout.

## Core Model

The manifest defines `analyses[]`. An analysis is a reusable workflow such as `plan-reviews` or
`swot`. Each analysis owns its targets, state paths, reports, rollups, notifications, and
maintenance tasks.

Each analysis has:

- `id`: stable path-safe slug, such as `plan-reviews` or `swot`.
- Prompt, model, context, matcher, redaction, and storage defaults.
- `targets[]`: projects, teams, channels, or other monitored scopes.
- `runs[]`: normal analysis schedules.
- `rollups[]`: scheduled reports based on the analysis state and stored outputs.
- `maintenance[]`: scheduled operational tasks over the same target states.

Rollups and maintenance belong to a parent analysis. They reuse target configs and state paths from
that analysis unless they explicitly override a supported setting.

## Configuration Composition

Portfolio configuration should be composed with deterministic deep merges. The manifest should make
general settings easy to define once while allowing any target, run, rollup, or maintenance task to
override the inherited values it needs.

Merge layers for a normal analysis run:

1. top-level defaults;
2. analysis defaults;
3. run defaults;
4. target defaults;
5. target run overrides.

Rollups and maintenance follow the same parent-to-child pattern, but their task defaults replace the
normal run defaults.

Merge rules:

- objects merge recursively;
- arrays replace the inherited array wholesale;
- scalars replace inherited scalars;
- omitted fields inherit;
- the final materialized config must still validate against the target schema before execution.

Portfolio `defaults.matchers` is a separate composition layer for common channel matchers. `pre`
matchers are prepended and `post` matchers are appended to every materialized channel matcher list
after the normal deep merge. This keeps shared suppressors, such as `exclude_laughs`, out of every
target config while still validating the final merged result with `schemas/config.schema.json`.

Merge concerns should remain separate. For example, `analysisConfig` materializes into the existing
`slack-manager-ai-helper` config shape, while `runAndNotifyConfig` provides delivery and
notification-template settings for the external `run-and-notify` invocation. A target may override
either or both. `runAndNotifyConfig.name` defaults to the target display `name` when omitted.

Interactive schedule creation should default to `22:00`; cron remains the external trigger and may
invoke due checks at whatever cadence operators prefer.

The portfolio runner owns command output handling. It writes JSONL logs itself, passes only the
saved markdown report to `run-and-notify` as command stdout, and treats stdout format as always
`markdown`. Portfolio manifests should not require users to configure `stdout` or `stderr` parsing
for normal report delivery.

## Template Strings

Generated paths, filenames, commit messages, and notification names should use Handlebars template
strings. Do not introduce a custom placeholder syntax such as `<analysisId>`.

Templates should receive a structured context with at least:

- `analysis`: parent analysis metadata;
- `target`: selected target metadata;
- `run`, `rollup`, or `maintenance`: selected task metadata when applicable;
- `period`: resolved period metadata, including a path-safe `key`;
- `report`: report path metadata;
- `startedAt`: run start timestamp.

Path templates must render to relative paths inside their configured base directory unless a field
explicitly allows an absolute path.

## Target Lifecycle

Each target has:

- `id`: permanent slug that is never reused.
- `name`: display name that can change over time.
- `status`: `active`, `paused`, or `archived`.
- `startedOn`: optional local date.
- `endedOn`: required when archived.
- `archiveReason`: optional short note.

Runner behavior:

- `active` targets are included by default.
- `paused` targets are skipped by default but can run when explicitly selected.
- `archived` targets are retained for history and require an explicit include flag.
- Renames change `name`, not `id`.
- Splits and merges archive old target ids and create new target ids.
- State and reports are never deleted automatically when a target is paused or archived.

## Scheduling And Windows

Cron remains the scheduler. The portfolio runner resolves which tasks are due when it starts.

Supported date and window inputs should include:

- `--date today`
- `--date yesterday`
- `--date YYYY-MM-DD`
- `--window current-workday`
- `--window previous-workday`
- `--window previous-5-workdays`
- explicit `--start-date YYYY-MM-DD --end-date YYYY-MM-DD`

Dates and windows resolve once at startup using the configured local timezone behavior. The resolved
window is then used consistently for every selected analysis, rollup, and maintenance task in that
invocation.

`--date` also enables schedule-aware task selection for that local day. Tasks whose schedule does
not match the resolved date are skipped, even when `--due` is omitted. This keeps ad-hoc reruns for
one day from also running rollups or maintenance scheduled for other weekdays. Schedule time checks
still apply only to live `--due` invocations without `--date`.

Schedules should support:

- daily or workday runs;
- specific weekdays, such as Friday;
- multiple named slots per day, such as `morning` and `afternoon`;
- every N workdays;
- manual-only tasks.

`run-portfolio --due --manifest <file>` is the cron-friendly mode. It should run every analysis
run, rollup, and maintenance task that is due at invocation time.

## Execution Semantics

### Analysis Runs

A normal analysis run:

- materializes the existing single-config shape for each selected target;
- validates the materialized config with `schemas/config.schema.json`;
- calls `runOnce()` directly;
- writes a report only when report text is produced;
- publishes one report per target and resolved window;
- sends notifications for successful reports when configured.

The materialized config path behavior must match existing config semantics: relative paths resolve
from the manifest or generated config context, and prompt/model/context behavior must not diverge
from `run`.

### Rollups

A rollup task:

- belongs to one parent analysis;
- runs over one or more target state files from that analysis;
- reuses the existing `unified-report` logic;
- writes rollup reports under the parent analysis report tree;
- can have its own prompt, schedule, window, notification settings, and latest view.

First example: a `plan-reviews.weekly` rollup that runs every Friday over the previous five
workdays and uses the existing plan review weekly prompt.

### Maintenance

A maintenance task:

- belongs to one parent analysis;
- runs over target states from that analysis;
- is due by schedule or manual selection;
- does not publish normal analysis reports.

The first maintenance task is `compact-state`, with configurable `keepRuns` and backup behavior.

## Report Layout

Report paths must use Handlebars templates over `analysis.id`, not hardcoded workflow names.

Immutable analysis reports:

```text
reports/{{analysis.id}}/{{period.key}}/{{target.id}}.md
```

Stable latest analysis views:

```text
reports/{{analysis.id}}/latest/index.md
reports/{{analysis.id}}/latest/{{target.id}}.md
reports/{{analysis.id}}/targets/{{target.id}}/latest.md
reports/{{analysis.id}}/targets/{{target.id}}/index.md
```

Rollup reports:

```text
reports/{{analysis.id}}/rollups/{{rollup.id}}/{{period.key}}/{{target.id}}.md
reports/{{analysis.id}}/rollups/{{rollup.id}}/latest/{{target.id}}.md
```

`periodKey` depends on the resolved window:

- daily: `YYYY-MM-DD`
- named slot: `YYYY-MM-DD/<slot>`
- weekly: `YYYY-Www`
- explicit range: `YYYY-MM-DD_to_YYYY-MM-DD`

Stable latest views should be real markdown files, not symlinks, so they render cleanly in common
Git hosting UIs and work on every clone.

Historical reruns do not update `latest/` unless an explicit option such as `--update-latest` is
passed.

## Runtime Files

JSONL logs are runtime artifacts and must not be committed. Example ops and report repo ignore
rules:

```gitignore
/logs/
/tmp/
/work/
*.jsonl
.env
.env.*
!.env.example
```

State files are local-only by default unless the operator explicitly accepts storing redacted
evidence and memory in the private ops repo.

## Commands

Planned commands:

```bash
slack-manager-ai-helper run-portfolio --manifest portfolio.json --due
slack-manager-ai-helper run-portfolio --manifest portfolio.json --analysis plan-reviews --date today
slack-manager-ai-helper run-portfolio --manifest portfolio.json --analysis plan-reviews --target my-project --window previous-5-workdays
slack-manager-ai-helper run-portfolio --manifest portfolio.json --due --concurrency 4
slack-manager-ai-helper manage-portfolio --manifest portfolio.json
```

`run-portfolio` should support at least:

- `--manifest <file>`
- `--due`
- `--analysis <id>`
- `--target <id>`
- `--date <today|yesterday|YYYY-MM-DD>`
- `--window <name>`
- `--start-date <YYYY-MM-DD>`
- `--end-date <YYYY-MM-DD>`
- `--include-paused`
- `--include-archived`
- `--dry-run`
- `--concurrency <positive-integer>`
- `--no-notify`
- `--no-publish`
- `--update-latest`

## Wizard

`manage-portfolio --manifest <file>` is an interactive wizard for maintaining the private ops
manifest.

The wizard manages:

- analyses;
- targets and lifecycle status;
- schedules;
- channels, users, roles, and matchers;
- prompts and model/context overrides;
- rollups;
- maintenance;
- notification recipients and Slack destinations.

Save behavior:

- validate before save;
- write a timestamped backup beside the manifest before replacing it;
- never persist partial invalid JSON;
- reuse existing config wizard and preview behavior wherever possible;
- preview and dry-run paths must consume the same redacted runtime preparation as `run`.

## Failure Behavior

- One failed target must not stop later targets.
- Analysis, rollup, maintenance, publish, and notification failures are tracked independently.
- Saved reports are kept even if notification fails.
- Publish failures are reported after all selected work is attempted.
- The command prints a compact final JSON summary to stdout.
- Detailed logs go to ignored runtime files or stderr.
- Notification delivery receives saved report markdown as stdout; portfolio-owned JSONL logs are
  not passed to `run-and-notify` as stderr.
- Exit status is `0` only when every selected due task succeeds, reports publish when requested,
  and enabled notifications deliver.

## First Example

The first concrete manifest will model `plan-reviews` as an analysis:

- analysis id: `plan-reviews`;
- targets: the current project list;
- normal run: daily workday, default date `today`;
- rollup: `weekly`, Fridays, previous five workdays, using `unified-report`;
- maintenance: periodic `compact-state` for each target state.

This example must not introduce hardcoded `plan-reviews` behavior in the runner.

An illustrative sanitized manifest lives at `examples/portfolio-plan-reviews.json`. It is based on
the current local plan review workflow shape without real Slack ids, names, or recipient addresses.

## Implementation Roadmap

### 1. Spec Only

- Add this spec.
- Do not change runtime behavior.

### 2. Date And Window Parsing

- Add shared parsing for `today`, `yesterday`, and named windows.
- Resolve windows once per invocation using local timezone behavior.
- Add tests for timezone-sensitive resolution and invalid inputs.
- Keep existing `YYYY-MM-DD`, `--start-date`, and `--end-date` behavior unchanged.

### 3. Portfolio Manifest Schema And Loader

- Add `schemas/portfolio.schema.json`.
- Add a typed loader and Ajv validation.
- Model `analyses[]`, `targets[]`, `runs[]`, `rollups[]`, and `maintenance[]`.
- Validate lifecycle constraints, including archived targets requiring `endedOn`.
- Add tests for defaults, invalid ids, selection metadata, and lifecycle constraints.

### 4. Dry-Run Planner

- Add `run-portfolio --dry-run`.
- Resolve due tasks and selected targets without model calls, notifications, publishing, or state
  mutations.
- Print the execution plan as JSON.
- Test active, paused, archived, explicit target, and due-schedule behavior.

### 5. Analysis Execution

- Materialize existing config objects per selected target.
- Validate each materialized config with the current config schema.
- Call `runOnce()` directly.
- Run all selected targets independently and aggregate failures.
- Add tests with a mocked `runOnce()`.

### 6. Report Publishing And Latest Views

- Write immutable reports under the configured Handlebars report path template.
- Write latest mirror files and indexes.
- Add one execution-level Git commit and no-change behavior for the report archive repo, including reports, rollups, analysis state files, and maintenance state/backup files touched by the selected run.
- Stage and commit only paths that `git status --porcelain` reports as changed so gitignored touched paths (such as `*.bak` maintenance backups) do not make `git add` fail after partial staging.
- Ensure JSONL logs and runtime directories remain ignored.
- Test report path generation, latest update policy, and no-change commits.

### 7. Notification Integration

- Generate or reference `run-and-notify` configs.
- Invoke `run-and-notify` for successful reports.
- Track notification status per target.
- Add tests with mocked command execution.

### 8. Attached Rollups

- Implement rollup tasks under a parent analysis.
- Reuse existing `unified-report` logic.
- Support windows such as previous five workdays.
- Publish rollup reports under the configured Handlebars rollup report path template.
- Add tests with stored state fixtures.

### 9. Attached Maintenance

- Implement maintenance tasks under a parent analysis.
- Support `compact-state` with configurable `keepRuns` and backup behavior.
- Add tests for target selection and compaction invocation.

### 10. Portfolio Wizard

- Add `manage-portfolio --manifest <file>`.
- Support list, add, edit, pause, resume, archive, validate, and preview flows.
- Reuse existing config wizard helpers where possible.
- Write backups and validate before saving.
- Add prompt-driven tests with mocked user answers.

### 11. Documentation And Examples

- Update README command documentation.
- Add example generic portfolio manifests.
- Document private ops repo and report archive repo layout.
- Update the relevant functional specs when implementation details become durable.

## Acceptance Criteria

- The feature remains generic from day one.
- Rollups and maintenance are attached to a parent analysis.
- `plan-reviews` is represented only as example configuration.
- Cron can run due work with one command.
- Stable latest report views do not require browsing dated directories.
- JSONL logs are never committed.
- Existing single-config commands remain supported.
