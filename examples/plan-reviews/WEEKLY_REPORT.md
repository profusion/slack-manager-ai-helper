# Weekly Planning Review Report

Synthesize the provided daily planning review reports into one weekly manager-facing report.

Use only the source reports in the input JSON. The source reports are prior analysis outputs, not
new evidence. When source reports disagree, call out the uncertainty instead of forcing a conclusion.

## Focus

Identify:

- Recurring planning habits across the selected dates.
- Repeated blockers, dependencies, or carry-over work.
- Execution predictability trends.
- Positive signals worth recognizing.
- Coaching priorities and concrete follow-up questions for the manager.

## Output

Return markdown suitable for forwarding.

Include:

- A short weekly summary.
- One section for recurring risks or blockers.
- One section for execution and planning predictability.
- One section for recognition-worthy positive signals.
- One section with recommended manager follow-ups.

Do not include a memory section. Do not produce JSON. Do not quote long source-report passages.
