# slack-manager-ai-helper

`slack-manager-ai-helper` helps managers turn noisy Slack traffic into repeatable follow-up workflows. You point it at the channels, DMs, and people you care about, teach it what counts as signal, and it produces a durable local record plus an LLM-ready summary only when something worth reviewing actually happened. The included examples cover plan reviews and actions follow-up, and the same pattern fits other manager workflows such as escalation watch: for example, tracking delivery-risk or outage-related updates across engineering channels so a lead can review blockers without reading every thread.

It is designed for teams that already rely on Slack as the place where plans, asks, status changes, and decisions happen. Instead of asking a model to read everything, this tool first finds candidate messages deterministically, expands surrounding evidence, then runs analysis on the compact, redacted context. The result is a practical manager feed you can schedule, inspect, archive, and reuse as memory on later runs.

Technically, this is a TypeScript CLI that reads a local Slack SQLite database produced by [`slacrawl`](https://github.com/openclaw/slacrawl). It opens that database read-only, matches configured messages, expands context, calls an LLM through the [Vercel AI SDK](https://ai-sdk.dev/) only when matches exist, and persists run windows, evidence, memory, and model output in a local JSON state file under `tmp/` by default.

## What it is good for

- **Plan reviews**: watch a planning or delivery channel for daily plans, then score whether they are detailed enough for predictable execution. See [`examples/plan-reviews/README.md`](./examples/plan-reviews/README.md), [`examples/plan-reviews-minimal-config.json`](./examples/plan-reviews-minimal-config.json), and [`examples/plan-reviews-config.json`](./examples/plan-reviews-config.json).
- **Actions follow-up**: watch manager mentions, DMs, MPIMs, and selected channels for asks that became trackable actions. See [`examples/actions-followup/README.md`](./examples/actions-followup/README.md), [`examples/actions-followup-minimal-config.json`](./examples/actions-followup-minimal-config.json), and [`examples/actions-followup-config.json`](./examples/actions-followup-config.json).
- **Escalation watch**: a plausible third pattern is tracking messages that look like blockers, risks, or incident escalations so a manager can review what needs intervention without tailing every conversation in real time.

## How matching works

Matchers decide which messages become **anchor messages**. Only after anchors are found does the tool expand nearby evidence and optionally call the analysis model.

Supported matcher types:

- `regex`: JavaScript regular expression against Slack message text.
- `text`: simple term containment; any term can match.
- `mention`: direct one-user mention matching.
- `scored`: weighted heuristic scoring, optionally backed by embeddings and/or a classifier.
- `and` / `or`: positive matcher composition.
- `exclude`: top-level suppressor; when its nested positive matcher matches, the message is ignored.

Processing behavior:

- Messages are read from the slacrawl database, normalized, redacted, and filtered for non-empty text before any matcher sees them.
- For each eligible message, the tool evaluates all applicable top-level `exclude` matchers before positive matchers, regardless of config order.
- If an `exclude` matcher matches, the message is ignored and no evidence or state entry is recorded for it.
- If no `exclude` matcher matches, positive matchers are evaluated in order: global matchers first, then channel-local matchers.
- Positive matching stops at the first match for that message. The first matching matcher id/type is recorded as the anchor reason, and later positive matchers are not evaluated for that message.
- A configured channel with no applicable positive matchers matches every eligible message in that channel. This is useful for low-volume or topic-dedicated channels.
- Channel `users` filtering and matcher success are an **AND** for anchor selection: if you restrict a source to certain users, a message must come from one of those users and then either match at least one source/global matcher or fall through a configured channel with no applicable positive matchers.
- Global matchers never match everything by default. When `channels` is omitted, global matchers scan every Slack source, but a message still needs an explicit global matcher hit. To intentionally match every Slack source, configure a catch-all matcher such as a `regex` matcher with pattern `.*`.

About `mention` matching:

- It is for **one Slack user id**, configured as `userId`.
- It matches Slack-formatted mentions like `<@U12345678>`.
- It also accepts literal `@U12345678` text if that exact user id appears in the message.
- It does **not** resolve Slack user groups such as `@eng-leads`, `@support`, or other workspace aliases. If you need those, use `text`, `regex`, or a `scored` matcher.

## Redaction boundary

Redaction happens at the **Slack read boundary**.

- Slack messages are redacted immediately after they are read from the slacrawl SQLite database.
- Every matcher sees the post-redaction text, including `regex`, `text`, `mention`, `scored`, `and`, `or`, `exclude`, embeddings inputs, and classifier prompts.
- Context expansion, logs, persisted evidence, previous memory passed back into the model, and the final report/memory output are all handled from redacted text.
- Messages that become empty, whitespace-only, or exactly `[REDACTED]` after normalization and redaction are dropped before matching.

This means you should think of the readable Slack database as the only place where original text exists in this workflow. Once a message enters `slack-manager-ai-helper`, downstream processing is meant to stay redacted.

## What context gets captured

When a message matches, the tool stores both the match result and the evidence that surrounded it.

Evidence can include:

- the matching message itself (`source: "match"`)
- real Slack thread replies (`source: "thread"`)
- nearby same-channel messages before and after the match (`source: "nearby"`)
- top-level messages that score as synthetic related context (`source: "synthetic_related"`)

Persisted state is a local JSON file, usually `state-<topic>.json` beside the config file. State
uses a run-centric `v1` shape:

- `runs`: each execution attempt and whether it completed or failed
- `runs[].executionMode`: `explicit` for date/window-bounded invocations, `implicit` for unbounded cron-style invocations
- `runs[].requestedRange`: the explicit local-date range when one was requested
- `runs[].scanStartCursor` / `runs[].scanEndCursor`: the Slack timestamp cursor bounds used for the scan
- `runs[].memories`: durable memory produced by that run
- `runs[].modelOutputs`: raw model output, extracted report text, parsed JSON, validation results,
  and the model provider/name/attempt metadata that produced the report
- `runs[].evidenceMessages`: the redacted Slack evidence used for that run's model call

State files can be compacted when history grows too large:

```bash
slack-manager-ai-helper compact-state --config examples/plan-reviews-config.json --keep-runs 20
```

This keeps the last `N` full runs, prunes model outputs and evidence for older non-retained runs,
keeps memory-bearing run history needed for future memory continuity, writes a timestamped `.bak`
backup by default, and prints a JSON summary. Use `--no-backup` to skip backup creation.

Useful inspection commands with `jq`:

```bash
jq '.runs | map({id, status, executionMode, scanStartCursor, scanEndCursor, matchedMessageCount, modelCalled, finishedAt})' examples/state-plan-reviews.json
```

```bash
jq '.runs[-1].evidenceMessages | map({runId, source, channelId, ts, userId, text})[:20]' examples/state-plan-reviews.json
```

```bash
jq '.runs[-1].modelOutputs | map({runId, createdAt, modelProvider, modelName, modelAttempts, schemaValid, reportText})' examples/state-plan-reviews.json
```

```bash
jq -r '[.runs[].memories[]] | last | .content' examples/state-plan-reviews.json
```

## Slacrawl as the data source

`slack-manager-ai-helper` does not talk to the Slack API directly. It uses `slacrawl` as the capture layer and treats the resulting SQLite database as the system of record for Slack history.

- The helper opens the slacrawl SQLite database **read-only** and never writes to it.
- The only time it calls the `slacrawl` CLI itself is to discover the default database location with `slacrawl metadata --json` when `storage.slacrawlDatabasePath` is not configured.
- In practice, this lets you separate capture from analysis. One machine can stay logged into Slack and keep the database fresh, then that database can be copied or exported to another machine that only runs analysis.

Operationally, `slacrawl` is also where Slack access details live:

- If you are using `slacrawl tail`, that is the layer to think about for Slack API tokens, app bot user keys, and capture health.
- Watch for capture-side problems such as a desktop wiretap session not running, API keys not being available, or the Slack desktop app not being open when your slacrawl setup depends on it.
- If the database is stale, `slack-manager-ai-helper` will faithfully analyze stale data, so freshness checks belong at the `slacrawl` layer.
- Slackbot, bot-message, and common Slack system-event rows are skipped at the slacrawl read boundary before matching, context expansion, evidence persistence, or model input.

## Setup

Use `nvm` to select the Node version from `.nvmrc`, then install dependencies:

```bash
nvm use
pnpm install
```

Install `slacrawl` separately for your operating system, for example:

```bash
brew install slacrawl
```

Configure provider credentials in `.env`. Typical variables are `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, and `OPENROUTER_API_KEY`.
`LOG_LEVEL` controls Pino logging and defaults to `info`. Set `TZ` to the local timezone used for
dates and times exposed to the LLM. The compact LLM state groups messages by local date and sends
message times as `HH:MM`, for example with `TZ=America/Sao_Paulo`. The CLI logs a warning and falls
back to the system local timezone when `TZ` is unset.

## Commands

```bash
pnpm run slack-manager-ai-helper run --config examples/plan-reviews-config.json
pnpm run build
pnpm run lint
pnpm run test
pnpm run slack-manager-ai-helper run --config examples/plan-reviews-config.json
```

The bundled CLI supports:

```bash
slack-manager-ai-helper run --config examples/plan-reviews-config.json
slack-manager-ai-helper run --config examples/plan-reviews-config.json --date today
slack-manager-ai-helper run --config examples/plan-reviews-config.json --date 2026-06-03
slack-manager-ai-helper run --config examples/plan-reviews-config.json --window previous-5-workdays
slack-manager-ai-helper run --config examples/plan-reviews-config.json --start-date 2026-06-01 --end-date 2026-06-03
slack-manager-ai-helper collect-model-input --config examples/plan-reviews-config.json
slack-manager-ai-helper unified-report --config examples/plan-reviews-config.json --prompt examples/plan-reviews/WEEKLY_REPORT.md --days 5
slack-manager-ai-helper run-portfolio --manifest examples/portfolio-plan-reviews.json --dry-run
slack-manager-ai-helper run-portfolio --manifest examples/portfolio-plan-reviews.json --analysis plan-reviews --target project-alpha --date today --no-notify
slack-manager-ai-helper run-portfolio --manifest examples/portfolio-plan-reviews.json --due --concurrency 4
slack-manager-ai-helper manage-portfolio --manifest examples/portfolio-plan-reviews.json
slack-manager-ai-helper create-config --reference examples/plan-reviews-minimal-config.json --output my-topic-config.json
slack-manager-ai-helper validate-config --config examples/plan-reviews-config.json
slack-manager-ai-helper run --config examples/plan-reviews-minimal-config.json
slack-manager-ai-helper run --config examples/actions-followup-config.json
slack-manager-ai-helper run --config examples/actions-followup-minimal-config.json
slack-manager-ai-helper inspect-config --config examples/plan-reviews-config.json
slack-manager-ai-helper compact-state --config examples/plan-reviews-config.json --keep-runs 20
slack-manager-ai-helper resolve-evidence --config examples/plan-reviews-config.json --id '2026-06-05T12-00-00-000Z:0'
slack-manager-ai-helper resolve-evidence --config examples/plan-reviews-config.json --id 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69' --output json
```

`run-portfolio` executes analysis tasks with the existing `runOnce()` runtime, attached rollups with
the existing `unified-report` runtime, and maintenance tasks such as `compact-state` over the same
target state files. Pass `--date` to rerun one local day and plan only tasks whose schedule matches
that day. Pass `--due` for cron-style execution that filters by the current local day and schedule
time. When publishing is enabled, it writes markdown reports to the configured report
archive and updates latest views for current windows. When `reports.commit.enabled` is true,
`run-portfolio` creates one git commit after all selected tasks finish for touched report files,
rollup report files, analysis state files, and maintenance state/backup files that live under the
archive repo. Only paths that `git status` reports as changed are staged and committed; gitignored
paths such as maintenance `*.bak` backups are skipped so a partial `git add` cannot abort the commit. Pass `--no-publish` for state-only execution. When notifications are enabled, it
passes the materialized `runAndNotifyConfig` to `run-and-notify` as dotted CLI arguments, forces
markdown stdout, and delivers the saved report via `cat <report>`. Pass `--concurrency N` to run up
to `N` analysis/target lanes in parallel; tasks for the same analysis target still run in plan order
so rollups and maintenance do not overtake that target's analysis run.

Portfolio `defaults.matchers.pre` and `defaults.matchers.post` compose common matcher objects into
every materialized channel matcher list, before validation with `schemas/config.schema.json`. Use
`post` for shared suppressors such as common `exclude` matchers. If a channel has no local
`matchers`, the common matchers become that channel's matcher list. `runAndNotifyConfig.name` is
optional in portfolio manifests and defaults to the target display `name`; override it only when the
notification label should differ from the target name.

`manage-portfolio` is an interactive manifest editor for private ops manifests. It can list the
portfolio, add analyses and targets, edit target channels with the same guided channel/user/matcher
flow as config editing, edit members on a selected target channel (add/remove) from the edit-target
submenu, move a member between targets (remove from every source channel and add to every destination
channel), add optional target-level model and scored-matcher provider overrides, edit analysis
defaults and target overrides as JSON, add runs, rollups, and `compact-state` maintenance tasks,
pause/resume/archive targets, configure `runAndNotifyConfig` with guided SMTP/Slack transport prompts
or raw JSON at portfolio/analysis/target scope, validate, and preview the same dry-run plan as
`run-portfolio --dry-run`. Portfolio-default guided notification setup collects full transport
settings; analysis and target guided setup collects only override fields such as SMTP `to` and Slack
`defaultChannel` because those blocks deep-merge with parent config. Guided Slack setup can disable
classic link/media previews via `transports.slack.unfurlLinks` and `transports.slack.unfurlMedia`
(`false`/`false`), which `run-and-notify` forwards to Better Notify. Submenus include a back option so
edit flows can return without saving changes. New target setup seeds user roles from sibling targets when available. New schedule
prompts default to `22:00`. Saving validates the manifest first and writes a timestamped `.bak`
beside an existing manifest before replacing it. Pass `--create` when the manifest path does not
exist and you want to start a new manifest.

To build a new config interactively from an existing one, use:

```bash
slack-manager-ai-helper create-config --reference examples/plan-reviews-minimal-config.json
```

To edit an existing config in place with the same guided channel, user, role, matcher, and preview
flows, use:

```bash
slack-manager-ai-helper edit-config --config examples/plan-reviews-config.json
```

`create-config` prompts for an output path when `--output` is omitted. It inspects the configured
read-only slacrawl database to offer searchable channel and user choices with known names, source
kinds, and private flags when those are present in slacrawl metadata. If channel membership metadata
is unavailable, mention-user choices fall back to users who sent messages in that channel.
`edit-config` edits the selected config in place, optionally accepts `--reference` for copyable
roles and matchers, validates before saving, and writes a timestamped `.bak` beside the original.

The command seeds prompts, model settings, channels, users, roles, matchers, context, and provider
defaults from `--reference`. Built-in prompt tokens such as `@DEFAULT_BASE_INSTRUCTIONS@` remain
references. For prompt files, the wizard asks whether to reference, copy, or copy-and-edit; edits are
always made to a copied file near the output config, never to the original reference prompt.
Optional top-level arrays such as `channels` and `globalMatchers` are omitted when empty instead of
being written as empty arrays.

Matcher try-it flows and final preview use the same redacted slacrawl read boundary as `run`, so
sampled real Slack text shown by the wizard has already passed through configured redaction. Scored
matcher and synthetic-thread assistance can send user-entered samples to the configured main model,
but only after confirmation; the model suggestions are editable before saving.

After writing the config, the wizard can preview real matching without changing state. This preview
shows scanned counts, matched anchors, evidence that would be sent to the model, and ignored
messages with reasons. It can also dry-run the analysis model and render the markdown report in
terminal colors. Preview and dry-run never create runs, save evidence, write model output, or save
memory.

Local Ollama helper scripts:

```bash
pnpm run ollama:classifier
pnpm run ollama:embeddings
```

Both helpers start an Ollama server at `http://127.0.0.1:11434` when one is not already reachable,
pull the configured model, and run a small smoke request. Override defaults with environment
variables:

```bash
OLLAMA_CLASSIFIER_MODEL=qwen3:0.6b pnpm run ollama:classifier
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text pnpm run ollama:embeddings
OLLAMA_URL=http://127.0.0.1:11434 pnpm run ollama:embeddings
```

Optional live Ollama scoring integration tests are not part of normal QA:

```bash
pnpm run test:ollama
```

These live tests run sequentially because local Ollama models can be CPU or memory constrained.
Override the defaults with `OLLAMA_TEST_TIMEOUT_MS` for each Vitest case and
`OLLAMA_PROVIDER_TIMEOUT_MS` for each Ollama HTTP request.

## Configuration

All configuration files are JSON and are validated by `schemas/config.schema.json`. Relative paths
are resolved from the config file directory. `~` is expanded to the current home directory.

Top-level fields:

- `workspaceUrl` is required and must be the HTTPS base URL for the Slack workspace, such as
  `https://example.slack.com`. Evidence links are generated as
  `<workspaceUrl>/archives/<channelId>/p<tsWithoutDot>` for top-level messages, with
  `?thread_ts=<threadTs>` appended for thread replies so they can open in Slack's thread view.
  They remain HTTP links so they work in email clients that strip `slack://` app links.
- `storage` is optional. `storage.slacrawlDatabasePath` overrides the default slacrawl database path;
  when omitted, the CLI runs `slacrawl metadata --json` and uses `paths.default_database`.
  `storage.statePath` overrides the default local state file path.
- `prompts` is required and must be either one prompt reference or an ordered array of prompt
  references. `@DEFAULT_BASE_INSTRUCTIONS@` and `@DEFAULT_BASE_PROMPT@` expand to built-in prompts;
  other prompt references are Markdown paths resolved relative to the config file. Prompt content is
  concatenated in order.
- `model` is required and must include `provider` and `model`. Optional fields are `fallback`,
  `retries`, `baseUrl`, `temperature`, `reasoningEffort`, `maxOutputTokens`,
  `contextWindowTokens`, `timeoutMs`, `openrouter`, `minReportWords`, and `failOnInvalidOutput`. `fallback` is a
  recursive model config with the same fields; the runtime tries it after the current model
  exhausts its retries because provider execution failed or `failOnInvalidOutput` rejected
  structured output. `retries` defaults to `3` for each model, so a model can be called up to four
  times before falling back or failing. `baseUrl` configures providers that support custom
  endpoints, such as `openai-compatible` and `ollama`. `timeoutMs` aborts the analysis model call
  after the configured number of milliseconds.
  `openrouter` is only used when `provider` is `openrouter`; omitted OpenRouter subfields are not
  sent. Set `openrouter.includeReasoning` to `false` to send `reasoning.exclude: true`, or to
  `true` to send `reasoning.exclude: false`. `openrouter.order` and `openrouter.allowFallbacks`
  are forwarded as OpenRouter provider routing settings.
  When `failOnInvalidOutput` is true and a prompt declares an output JSON Schema, schema-invalid
  model responses are retried according to that model's `retries` value before the runtime tries
  `fallback` or fails the run. When `failOnInvalidOutput` is false, invalid output is stored with
  validation errors instead of triggering fallback.
  Configured `temperature` is omitted automatically for known reasoning model families, such as
  `gpt-5...` and `o1/o3/o4...`, because those models do not support temperature.
  `reasoningEffort` may be `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`, and is passed
  through to providers/models that support reasoning effort.
  `minReportWords` defaults to `25`; structured `reportText` must contain at least that many
  meaningful words, where a meaningful word is a run of four or more alphabetic characters after
  Markdown formatting, links, URLs, code fences, and punctuation are removed.
  Built-in analysis provider ids are `openai`,
  `anthropic`, `google`, `xai`, `openrouter`, `opencode`, `openai-compatible`, `gateway`, and
  `ollama`. When `contextWindowTokens` is set, the runtime estimates the fully compiled
  `system + prompt` tokens, including configured prompts, minified schemas, compact state, and
  previous memory, reserves `maxOutputTokens` or a conservative default for output, and splits model
  calls by local date/channel before sending a request that would exceed the configured window. When
  fallbacks are configured, segmentation uses the smallest configured `contextWindowTokens` and the
  largest configured `maxOutputTokens` across the fallback chain.
- `redaction` is optional and enabled by default. Optional fields are `enabled`,
  `replacement`, and `additionalPatterns`; custom patterns use JavaScript RegExp source strings,
  optional flags, and always run with global/unicode flags.
- `channels` is optional. When provided, it must contain at least one channel object with `id`.
  Optional channel fields are `name`, `kind`, `alsoChannels`, `users`, and `matchers`; `kind` must
  be `channel`, `dm`, `mpim`, or `unknown`.
- `channels[].alsoChannels` is optional. When provided, it is a non-empty array of additional Slack
  sources that reuse the parent channel's `users` and `matchers`. Each entry requires `id` and may
  set `name` and `kind`. At load time the loader expands each entry into a full channel config;
  omitted `kind` inherits the parent channel kind when present. Expanded channel ids must be unique
  across the whole config, including primary channel ids.
- `channels[].matchers` is optional. When a configured channel has no applicable positive matchers
  from either `globalMatchers` or `channels[].matchers`, every eligible message in that channel
  becomes an anchor match after user filtering and excludes.
- `channels[].users` restricts anchor matching for that source: when users are configured, a
  message must be from one of those users and then either satisfy a source/global matcher or fall
  through a configured channel with no applicable positive matchers. Context expansion can include
  thread, nearby, and synthetic-thread messages from any user.
- `globalMatchers` is optional and applies across all configured channels. When `channels` is
  omitted, global matchers scan every Slack source in the slacrawl database. They do not match all
  messages by omission; use an explicit catch-all matcher such as a `regex` matcher with pattern
  `.*` if that is intended.
- Provide `channels`, `globalMatchers`, or both. A config with neither is valid but cannot match any
  Slack message.
- `scoredMatcherDefaults` is optional. It provides default `embeddings` and `classifier` provider
  settings for every `scored` matcher; matcher-local provider settings override these defaults.
- `context` is optional and behaves like `{}` when omitted. Optional fields are
  `includeRealThread`, `nearbyMessagesBeforeMinutes`, `nearbyMessagesAfterMinutes`, `maxMessages`,
  and `syntheticThreads`.
- Context defaults are `includeRealThread: true`, `nearbyMessagesBeforeMinutes: 5`,
  `nearbyMessagesAfterMinutes: 60`, and `maxMessages: 100`. `maxMessages` limits same-channel
  nearby context per matched anchor; the count resets for every match and does not cap matched
  anchors or real thread messages.
- `context.syntheticThreads` is optional. It supports `enabled`, `candidateWindowMinutes`,
  `thresholds`, `scoring`, `heuristics`, `embeddings`, and `classifier`.
- Synthetic-thread detection is enabled by default; set `context.syntheticThreads.enabled` to
  `false` to disable it. Synthetic-thread scoring defaults to `candidateWindowMinutes: 60`,
  thresholds `0.6/0.6/0.72/0.72`, and weights `semanticSimilarityWeight: 0`,
  `lexicalOverlapWeight: 0.55`, `sameAuthorOrMentionWeight: 0.2`,
  `temporalProximityWeight: 0.2`, and `channelTopicMatchWeight: 0.05`.
- Synthetic-thread detection skips same-channel candidates that would already be selected by a
  configured channel's match-all behavior, so provider calls focus on otherwise-unmatched context
  such as unconfigured users replying in a monitored channel.
- `context.syntheticThreads.classifier.useForRanges` is optional and must contain at least one of
  `ambiguous`, `unrelated`, or `related` when provided. It defaults to `["ambiguous"]`.
- Scored matchers default to thresholds `0.6/0.6/0.72/0.72` and weights
  `semanticSimilarityWeight: 0`, `questionSimilarityWeight: 0.15`, `keywordWeight: 0.45`,
  `phraseWeight: 0.3`, and `patternWeight: 0.1`.
- Synthetic-thread scoring uses top-level Slack messages as anchors and candidates.

Matcher types:

- `regex` requires `id`, `type`, and `pattern`; optional `flags` uses JavaScript RegExp flags
  and defaults to `iu` when omitted.
- `text` requires `id`, `type`, and non-empty `terms`; `caseInsensitive` is optional.
- `mention` requires `id`, `type`, and `userId`; it matches Slack `<@USER>` mentions and literal
  `@USERID` text for that exact user id.
- `scored` requires `id`, `type`, and `question`. It scores a single message with optional
  `thresholds`, `scoring`, `heuristics`, `embeddings`, and `classifier` blocks. It combines
  deterministic heuristics with AI SDK embeddings and classifier calls when enabled, then treats
  `related` scores as matches. This is useful for questions such as "is this an action?"
- `and` requires `id`, `type`, and non-empty `matchers`; every nested positive matcher must match.
- `or` requires `id`, `type`, and non-empty `matchers`; any nested positive matcher can match.
- `exclude` requires `id`, `type`, and `matcher`. It is allowed only at the top level of
  `globalMatchers` or `channels[].matchers`; the nested `matcher` must be a positive matcher
  expression, so `exclude` cannot be nested inside `and`, `or`, or another `exclude`.

Slack source kinds:

- `channel` is a public or private Slack channel.
- `dm` is a one-to-one direct message. Slack's API commonly calls this an `im` conversation.
- `mpim` is a multi-person direct message, sometimes shown as a group DM.

Any configured prompt file may include one fenced `jsonschema` block. When present, that schema
defines the structured output `memory` field, and the analysis model is called through AI SDK
structured output with a top-level `{ "memory": ..., "reportText": "..." }` object. The full
object is still validated locally with Ajv, and `reportText` is additionally checked as non-empty
Markdown that does not contain memory/jsonschema fenced blocks or HTML tags. Invalid output is stored with
validation errors; the run only fails when `model.failOnInvalidOutput` is `true`. In that mode,
schema-invalid responses are retried with the validation errors according to `model.retries` before
the runtime tries `model.fallback` or fails.

As a context-reduction optimization, every configured prompt file is scanned before the model call
for fenced code blocks tagged `json` or `jsonschema`. Those blocks must contain valid JSON; valid
blocks are minified before being sent to the model.

## Persistence details

The state file is created automatically at `storage.statePath`. When `storage` or `statePath` is
omitted, it defaults to `state-<config-name>.json` beside the config file, with a trailing
`-config` removed from the config filename. For example,
`examples/planning-review-project-xpto-config.json` defaults to
`examples/state-planning-review-project-xpto.json`.

The topic id is inferred from the config filename with the same `-config` suffix rule, so
`examples/plan-reviews-config.json` uses topic id `plan-reviews`. Scheduling belongs to whatever
invokes the binary.

The slacrawl database path defaults to `paths.default_database` from `slacrawl metadata --json` and
is opened read-only. Structured logs include trace context such as topic id, SQL-detected
workspace id when available, channel id, user id, matcher id, redacted message text snippets,
scoring ranges, provider/model settings, and model input sizes. Set `LOG_LEVEL=debug` to include
the compiled model input and redacted model output in logs. Workspace id is inferred from
slacrawl SQLite metadata such as message-table `workspace_id`/`team_id` columns or workspace/team
tables. Debug logging is useful while setting up prompts and configuration because it traces the
compiled model payload and model output, but reduce `LOG_LEVEL` to `warn` for real usage. The
compact LLM input state is validated against `schemas/state.schema.json` and sends the config
`topicId` plus evidence as a nested `timeline`: date, day of week, per-day configured-user
summaries, channel, thread, and messages with local `time: "HH:MM"`. Daily user summaries report
`status: "present"` with `firstMessageAt`, `channelMessages`, `repliesToOthers`,
`totalMessages`, `authoredTopLevelMessages`, `authoredReplies`, and `ownedEvidence`, or `status:
"absent"` with no counters. `channelMessages` counts top-level evidence messages in configured
Slack sources, `repliesToOthers` counts evidence reply messages in known threads started by another
user, and `totalMessages` equals `authoredTopLevelMessages.length + authoredReplies.length`.
Authored message arrays contain Slack HTTP permalink hrefs that match entries under
`channels[].threads[].messages[]`. `ownedEvidence` lists authored messages from matched anchors and
real thread context that prompts may use as that configured user's own planning, update, review, or
completion evidence; nearby and synthetic context messages are excluded. Messages
include `userName` from config or the slacrawl directory when known, configured `userRole` when
known, `externalAuthor: true` for known authors outside the configured users, `evidenceScope:
"owned" | "context"`, `anchor: true` when the row was a matched anchor before context expansion,
and `href` as a clickable Slack HTTP permalink. Reply hrefs include `?thread_ts=<threadTs>`.
Matcher ids, match reasons, raw evidence source tags, run id, and full timestamps are omitted from
the LLM input.

To inspect the exact compiled system and prompt payload without calling the model, use:

```bash
slack-manager-ai-helper collect-model-input --config examples/plan-reviews-config.json
```

This command is read-only: it does not create a run record, save evidence, write model output,
or save memory. When a model call would happen, stdout is JSON with
`modelInput.system` and `modelInput.prompt`. When no model input would be generated, stdout is
still JSON and includes a `reason`, such as `no_matches`.

Use `--state-only` to stop before prompt compilation and print the compact JSON state that would
be embedded in the model prompt:

```bash
slack-manager-ai-helper collect-model-input --config examples/plan-reviews-config.json --state-only
```

To synthesize a weekly or multi-day report from already stored daily model outputs, use
`unified-report` with a separate rollup prompt:

```bash
slack-manager-ai-helper unified-report --config examples/plan-reviews-config.json --prompt examples/plan-reviews/WEEKLY_REPORT.md --days 5
slack-manager-ai-helper unified-report --config examples/actions-followup-config.json --prompt examples/actions-followup/WEEKLY_REPORT.md --start-date 2026-06-01 --end-date 2026-06-05
```

This command is read-only: it does not scan slacrawl, create runs, write model outputs, or save
memory. `--days N` selects today and the previous `N - 1` local dates using `TZ`;
use `--date`, `--window`, or `--start-date`/`--end-date` for explicit local-date ranges.
`--state-only` prints the assembled source-report JSON without calling the model.

`run` writes only the extracted `reportText` to stdout, so it can be piped directly to notification
tools. Metadata, scan cursors, evidence, memory, raw redacted model output, and schema validation
status are stored in the state file.

For portfolios, set `runAndNotifyConfig.emptyReportMessageTemplate` at the portfolio, analysis, target, or run level to send a notification when an analysis completes without a report. It defaults to `No daily reports found - {{project}}`; `{{project}}` is the target display name, and `{{target.name}}` / `{{target.id}}` are also available.

To resolve a stored evidence id back to the Slack coordinates used for analysis, use:

```bash
slack-manager-ai-helper resolve-evidence --config examples/plan-reviews-config.json --id '2026-06-05T12-00-00-000Z:0'
```

The `--id` value can be either a persisted evidence id in `run-id:index` form, such as
`2026-06-05T12-00-00-000Z:0`, or a unique Slack/slacrawl `messageId` UUID that appeared in model
output. The default `--output link` prints the configured Slack HTTP permalink. Use `--output json`
for scriptable output that also includes the redacted stored evidence text, how the id was resolved,
the state file used, permalink/reference fields, configured channel name/kind when available, and a
clearly labeled `slack-reference` coordinate with channel id, timestamp, optional thread
timestamp/message id/user id, run id, and evidence id.

When `model.contextWindowTokens` causes a run to split into multiple model calls, each segment is
bounded by local date/channel evidence units and the final stdout report is a chronological merge of
segment reports. The persisted memory for the run is one JSON memory object containing the extracted
memory from each segment; future runs receive that merged memory as their previous memory.
When model fallbacks are configured, segmentation uses the smallest configured
`contextWindowTokens` and the largest configured `maxOutputTokens` across the fallback chain so a
segment that fits the primary model also fits configured fallback models.

Date flags on `run` and `collect-model-input` filter the local dates included in the model
timeline. Date flags on `create-config` apply only to its preview and dry-run; they are not written
to the generated config.

- `--date YYYY-MM-DD` is a shortcut for a one-day range.
- `--date today` and `--date yesterday` resolve once using the local timezone from `TZ`.
- `--window current-workday`, `--window previous-workday`, and `--window previous-5-workdays`
  select named local workday ranges.
- `--start-date YYYY-MM-DD` and `--end-date YYYY-MM-DD` define an inclusive range.
- `--start-date` without `--end-date` includes messages from that local date forward.
- `--end-date` without `--start-date` includes messages up to that local date.
- `--date`, `--window`, and explicit `--start-date`/`--end-date` ranges are mutually exclusive.
- Any date or window flag makes the run `explicit`: the scan bounds come from the requested local
  range and prior implicit runs are ignored.
- With no date/window flags, the run is `implicit`: the first run starts at local today midnight,
  and later runs start from the latest successful implicit run's `scanEndCursor`.
- Implicit runs freeze `scanEndCursor` before scanning. Completed implicit runs advance the next
  implicit start even when there are no matches or no model call; failed runs do not advance.
- Previous memory is selected from the latest earlier successful run that actually stored memory.
  No-match and model-without-memory runs do not erase memory continuity, and same-range reruns do
  not feed on memory from an earlier run of that same range.

## Scoring Helper Models

The global `model` block configures the analysis LLM used by Vercel AI SDK. The nested
`context.syntheticThreads.embeddings` and `context.syntheticThreads.classifier` blocks configure
optional helpers for synthetic-thread detection. `scoredMatcherDefaults` provides the same default
provider settings for `scored` matchers, and each scored matcher can override those defaults.
Scoring helpers also run through the AI SDK. Classifier calls use language providers such as
`ollama`, `openai`, `anthropic`, `google`, `xai`, `openrouter`, `opencode`, `gateway`, and
`openai-compatible`. Embedding calls require providers that expose an AI SDK embedding model, such
as `ollama`, `openai`, `openrouter`, `google`, `gateway`, or `openai-compatible`; providers without
embedding support fail with a clear error. Defaults remain local-first: classifiers use
`provider: "ollama"` with `qwen3:0.6b`, and embeddings use `provider: "ollama"` with
`nomic-embed-text`.

For local Ollama classifier setup, install Ollama and run:

```bash
pnpm run ollama:classifier
```

The default classifier model is `qwen3:0.6b`; override it with `OLLAMA_CLASSIFIER_MODEL`. This
optional setup script checks/starts the Ollama server, pulls the model, and sends a `/api/generate`
smoke request.

Local embeddings are possible with Ollama's embeddings API. The default helper model is
`nomic-embed-text`, which is an embeddings-only model; override it with `OLLAMA_EMBEDDINGS_MODEL`.

```bash
pnpm run ollama:embeddings
```

The optional embeddings helper checks/starts Ollama, pulls the model, and sends a `/api/embed`
smoke request. Both helpers write local Ollama startup logs to `tmp/ollama.log` when they need to
start a server.

### Embeddings

- Primary: `nomic-embed-text` (size: 274 MB, context: 2K)
- Fast path: `all-minilm` (size: 46 MB, context: 512)
- Heavy but multilingual and larger context: `bge-m3` (size: 1.2 GB, context: 8K)

### Classifiers

- Primary: `qwen3:0.6b` (523 MB)
- Alternative: `smollm2:360m` (726 MB)
- Heavy but safe: `llama3.2:1b` (1.3 GB)
- Heavy: `llama3.2:3b` (2.0 GB)
