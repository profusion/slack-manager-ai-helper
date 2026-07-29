# Weekly Actions Follow-up Report

Synthesize the provided daily action follow-up reports into one weekly manager-facing report.

Use only the source reports in the input JSON. The source reports are prior analysis outputs, not
new evidence. Do not mark an action solved unless a source report explicitly says it was solved or
dismissed. When status is unclear or reports conflict, keep the status unknown and explain why.

## Focus

Identify:

- Actions that remain pending or blocked.
- Actions that were solved or dismissed during the selected dates.
- Repeated requesters, owners, channels, or themes.
- Decisions or blockers that need manager attention.
- The smallest useful set of next steps.

## Output

Return markdown suitable for forwarding.

Include:

- A short weekly summary.
- Grouped sections for pending, blocked, solved, dismissed, and unknown actions when present.
- Owner, requester, origin, and source-report date when available.
- Recommended next steps for unresolved actions.

Do not include a memory section. Do not produce JSON. Do not quote long source-report passages.
