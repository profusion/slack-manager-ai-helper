# Configuration, Matching, And Redaction

`schemas/config.schema.json` is canonical for config fields and constraints. `README.md` must document every field and constraint in that schema.

## JSON and validation

- All machine-readable artifacts are JSON, pretty-printed with 2-space indentation and a trailing newline.
- Validate with Ajv against `schemas/*.schema.json` before persisting.
- Example configs under `examples/` are checked in tests against `schemas/config.schema.json`.
- Config paths are resolved relative to the config file directory after `~` expansion.
- Config topic id is inferred from the config filename, stripping a trailing `-config`.
- `config.context` is optional and resolved configs default it to `{}`.
- `channels` is optional; provide `channels`, `globalMatchers`, or both. When both are omitted, no Slack messages can match.
- When `channels` is omitted, `globalMatchers` scan every Slack source in the slacrawl database but still require an explicit matcher hit. Use an explicit catch-all matcher such as regex `.*` if global matching should include every Slack source.
- Channel `kind` uses `dm` for Slack API `im` one-to-one direct messages; `mpim` means multi-person direct message.
- `channels[].alsoChannels` is an optional non-empty list of additional Slack sources that reuse the parent channel's `users` and `matchers`. Each entry requires `id` and may set `name` and `kind`. Config validation expands those entries into full channel configs before runtime matching; omitted `kind` inherits the parent channel kind when present. Expanded channel ids must be unique across the whole config.
- `channels[].users` filters anchor matches together with source/global matchers; context expansion can include messages from any user.

## Prompt references

- `config.prompts` is either one prompt reference or an ordered array of prompt references; resolved configs normalize it to an array and prompt content is concatenated in order.
- `@DEFAULT_BASE_INSTRUCTIONS@` and `@DEFAULT_BASE_PROMPT@` expand to inline built-in prompts; other prompt references are Markdown paths resolved relative to the config file.
- Prompt files are scanned for fenced `json` and `jsonschema` blocks before model calls; those blocks must be valid JSON and are minified to reduce context size.
- Prompts that need both durable memory and a forwardable report should include one fenced `jsonschema` block for the memory object. Runtime wraps that schema in an AI SDK structured output object with top-level `memory` and `reportText`; local Ajv validation still checks the full object and markdown report before persistence.
- `model.minReportWords` defaults to `25`. Structured `reportText` must contain at least that many meaningful words: runs of four or more alphabetic characters after Markdown formatting, links, URLs, code fences, and punctuation are removed.
- Before structured model calls, prompt memory schemas are strictified for all analysis providers: every object with `properties` gets `additionalProperties: false`, every property key is listed in `required`, and former optional fields accept `null`.

## Evidence links

- `workspaceUrl` is required and is used to create Slack HTTP evidence permalinks as `<workspaceUrl>/archives/<channelId>/p<tsWithoutDot>` for top-level messages.
- Thread reply links append `?thread_ts=<threadTs>`.
- Do not emit `slack://` app links in model input or prompt schemas because some email clients strip them.

## Redaction boundary

- Redaction is enabled by default at the slacrawl DB read boundary.
- `redaction.additionalPatterns` extends built-in secret regexes.
- Matchers, synthetic-thread scoring, context expansion, logs, model input, and state writes must only receive already-redacted Slack message text.
- Do not send or persist unredacted Slack message text, previous memory, or model output.
- Empty Slack messages are skipped at the slacrawl DB read boundary after normalization and redaction.
- Matchers should not receive file/image-only rows with blank text or rows reduced to only `[REDACTED]`.
- Slackbot, bot-message, desktop-draft, and common Slack system-event rows are skipped at the slacrawl DB read boundary after normalization/redaction.
- Matchers, context expansion, evidence persistence, and model input should only receive sent human-authored messages.

## Context expansion

- Synthetic-thread settings live under `context.syntheticThreads`.
- Context expansion defaults are `includeRealThread: true`, `nearbyMessagesBeforeMinutes: 5`, `nearbyMessagesAfterMinutes: 60`, and `maxMessages: 100`.
- `maxMessages` limits same-channel nearby context per matched anchor and resets for every match, without capping matched anchors or real thread messages.
- Synthetic-thread detection is enabled by default; set `context.syntheticThreads.enabled` to `false` to disable it.
- Synthetic-thread defaults include `candidateWindowMinutes: 60`, thresholds `0.6/0.6/0.72/0.72`, and weights `semanticSimilarityWeight: 0`, `lexicalOverlapWeight: 0.55`, `sameAuthorOrMentionWeight: 0.2`, `temporalProximityWeight: 0.2`, and `channelTopicMatchWeight: 0.05`.
- Synthetic-thread scoring uses top-level Slack messages as anchors and candidates.
- Synthetic-thread classifier settings use `context.syntheticThreads.classifier`.
- `context.syntheticThreads.classifier.useForRanges` is an optional non-empty array of `ambiguous`, `unrelated`, and `related`, defaulting to `ambiguous`.
- Synthetic-thread detection skips same-channel candidates that would already be selected by a configured channel's match-all behavior; this keeps provider calls focused on otherwise-unmatched context such as unconfigured users replying in a monitored channel.

## Matchers

- Matchers support `regex`, `text`, `mention`, `scored`, `and`, `or`, and top-level `exclude`.
- `scored` uses `question`, thresholds, scoring weights, heuristics, and optional embeddings/classifier config.
- Scored matcher defaults are thresholds `0.6/0.6/0.72/0.72` and weights `semanticSimilarityWeight: 0`, `questionSimilarityWeight: 0.15`, `keywordWeight: 0.45`, `phraseWeight: 0.3`, and `patternWeight: 0.1`.
- `regex` matchers use optional JavaScript RegExp `flags` and default to `iu` when omitted.
- Do not use the removed `caseInsensitive` field for regex configs.
- Matcher evaluation runs all applicable top-level `exclude` suppressors before positive matchers, regardless of config order.
- Nested `exclude` is invalid; `exclude.matcher`, `and.matchers`, and `or.matchers` can only contain positive matcher expressions.
- Positive matcher evaluation short-circuits on first hit for each eligible message: global matchers are evaluated before channel-local matchers, the first positive matcher id/type is recorded, and later positive matchers are skipped for that message.
- A configured channel with no applicable positive matchers matches every eligible message in that channel after user filtering and excludes. The synthetic match reason is `matcherId: "channel"` and `matcherType: "channel"`.
- `mention` matchers target one Slack user id, matching `<@USER>` and literal `@USERID` text for that exact id.
- `mention` matchers do not resolve Slack user groups or aliases.
- `scoredMatcherDefaults` provides default AI SDK embeddings/classifier provider settings for scored matchers.
- Matcher-local `embeddings` or `classifier` fields override the matching default object.

## Slacrawl reads and storage defaults

- If `storage.slacrawlDatabasePath` is omitted, the config loader runs `slacrawl metadata --json` and uses `paths.default_database`.
- If `storage.statePath` is omitted, it defaults to `state-<config-name>.json` beside the config file, stripping a trailing `-config` from the config filename.
- Structured logs derive `workspaceId` from slacrawl SQLite metadata when available and may include redacted message text snippets for matcher/synthetic-thread diagnostics.
- Slacrawl SQLite reads log SQL, bind parameters, duration, row counts, and result cursor windows at the DB boundary; keep new database reads behind the same logging helpers.
- Slacrawl schema detection must map `SlackMessage.ts` to the numeric Slack cursor field by sampling candidate timestamp columns.
- Columns named `timestamp` can contain non-numeric draft ids, so prefer a numeric field such as `message_ts` when present.
- Scoring and provider logs should include IDs and trace context such as workspace id, channel id, user id, matcher id, score/range, provider, model, base URL, timeout, and model input sizes.
