# Plan Review Prompts

Plan-review prompts evaluate configured Slack users from redacted evidence. These rules are prompt policy and should stay aligned with examples and generated reports.

## Evidence policy

- Plan-review prompts must refer to configured Slack identities as users.
- Gate plan detection on current-day user presence plus clear top-level channel evidence from that configured user.
- Keywords such as `plan` and `planning` are hints, not automatic proof.
- Previous memory must not justify today's plan-submission finding.
- Plan-review prompts must use only a configured user's `ownedEvidence` links for that user's plan, update, review, completion, delivery, positive-signal, blocker, and predictability findings.
- `evidenceScope: "context"` and `externalAuthor: true` messages are surrounding context only.
- Plan-review prompts must evaluate a user's updates, review, completion, and predictability from all same-day owned evidence by that same configured user, including standalone main-channel updates.
- Do not judge follow-through from only the latest review message or from peer updates.

## Planning cutoff and quality

- Plan-review prompts treat plans as on time only when the earliest same-day plan-like message from that configured user was sent before 10:00 local time.
- 10:00 or later is late even if the plan is high quality.
- Plan-review prompts should state planning cutoff rules with explicit `HH:MM` ranges so the yes/no label and comparison operator match the cited local message time.
- Plan-review quality should be strict.
- Mark a plan strong only when it names concrete deliverables, expected outcomes, validation or review criteria, and relevant priority/timebox/dependency information.
- Generic review, investigation, meeting, support, or status-only plans are weak or adequate, not strong by default.
- Plan-review reports must include specific planning coaching whenever planning quality is not strong, citing what is missing and how the next plan could be improved.

## Memory fields

- Plan-review memory stores `average_predictability` as a qualitative enum: `highly predictable`, `mostly predictable`, `moderately predictable`, `unpredictable`, or `unknown`.
- Plan-review memory stores durable per-user collaboration observations under `collaboration_patterns` with `type: "collaboration"` so future runs can compare each user's substantive-help or low-signal-reply habits over time.
