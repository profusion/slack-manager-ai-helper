# Actions Follow-Up Example

This example watches Slack messages for requests, decisions, blockers, and follow-up items that a
manager may need to track.

- [`../actions-followup-minimal-config.json`](../actions-followup-minimal-config.json) is the
  smallest version. It configures one channel and no matchers, so every non-empty, redacted message
  in that channel can become an anchor message.
- [`../actions-followup-config.json`](../actions-followup-config.json) is the full version. It adds
  storage, multiple sources, global manager-action matchers, context limits, synthetic-thread
  scoring, and scored matcher defaults.

Use the minimal config for a low-volume channel or a channel already dedicated to manager follow-up.
In high-volume channels, use explicit matchers like the full config to restrict what reaches the
model and avoid noise. Global matchers do not match everything by default; if you intentionally want
global matching to include every Slack source, configure an explicit catch-all matcher such as a
`regex` matcher with pattern `.*`.
