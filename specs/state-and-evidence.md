# State And Evidence

`schemas/persisted-state.schema.json` defines persisted app state. `schemas/state.schema.json` defines the compact state sent to LLM prompts.

## Persisted state

- App state is persisted as JSON and validated against `schemas/persisted-state.schema.json`.
- State files use a run-centric `v1` shape: root `version`, `topicId`, and `runs`.
- Each run owns its `memories`, `modelOutputs`, and `evidenceMessages`.
- Runs store `executionMode`, optional `requestedRange`, `scanStartCursor`, `scanEndCursor`, `scanStartedAt`, `scanEndedAt`, counts, and status.
- Explicit runs are selected by `--date`, `--window`, `--start-date`, or `--end-date`; they scan the requested local-date range and ignore prior implicit runs.
- Implicit runs have no date/window flags; the first starts at local today midnight, later runs start from the latest successful implicit run's frozen `scanEndCursor`, and completed no-match/no-model runs still advance that cursor.
- Previous memory selection must use the latest earlier successful run that actually stored memory.
- No-memory runs must not break memory continuity, and same-range reruns must not use memory from an earlier run of the same range.

## Evidence messages

- `runs[].evidenceMessages` stores the redacted Slack messages used for each model call.
- Evidence `source` values include `match`, `thread`, `nearby`, and `synthetic_related`.
- Evidence expansion includes all matched anchors and real thread messages.
- `context.maxMessages` only caps same-channel nearby context per match before synthetic-thread scoring, so raw context duplicates must not starve later matched anchors.
- Evidence dedupe keeps one record per Slack message but preserves `source: "match"` when the same message was first included as nearby/thread/synthetic context and later appears as a matched anchor.

## Model outputs

- `runs[].modelOutputs` stores the raw structured model response, optional markdown `reportText`, optional parsed memory JSON, Ajv validation errors, report-producing `modelProvider`/`modelName`, total `modelAttempts`, and detailed per-segment `modelCalls[]`.
- `runs[].modelOutputs[].usage` stores provider-reported token usage when the AI SDK exposes it.
- Aggregate segmented or follow-up calls before persisting the single output record.

## Compaction

- `compact-state --keep-runs N` keeps the newest N full runs.
- Compaction keeps model outputs and evidence only for retained full runs.
- Compaction keeps memory-bearing run history needed for the latest memory per `(scope, scopeId)`.

## Compact LLM input state

- Compact LLM input state is strictly validated in `buildRunState()` against `schemas/state.schema.json`.
- Every object level disables unexpected fields with `additionalProperties: false`.
- Compact LLM input includes top-level `topicId`, used by prompts as the memory `project.id`.
- Compact LLM evidence is grouped under `timeline[]` by local `date`, `dayOfWeek`, per-day configured `users`, channel, thread, and message.
- Day `users[]` entries use `status: "present"` with `firstMessageAt`, `channelMessages`, `repliesToOthers`, `totalMessages`, `authoredTopLevelMessages`, `authoredReplies`, and `ownedEvidence`, or `status: "absent"` with no counters.
- `channelMessages` counts top-level evidence messages in configured Slack sources.
- `repliesToOthers` counts evidence reply messages in known threads started by another user.
- `totalMessages` equals `authoredTopLevelMessages.length + authoredReplies.length`.
- `ownedEvidence` links may be used as that configured user's own per-user evidence.
- Nearby/synthetic context is excluded from `ownedEvidence`.
- Messages include local `time` as `HH:MM`, optional message/user ids, `userName` from config or the slacrawl directory when known, configured `userRole` when known, `externalAuthor: true` for known unconfigured authors, `evidenceScope: "owned" | "context"`, `anchor: true` for matched anchors, clickable `href` Slack HTTP permalinks, and redacted text.
- Omit matcher ids, match reasons, raw evidence source tags, run id, and full timestamps from model input.
