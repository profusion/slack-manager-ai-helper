# Plan Reviews Example

This example watches a planning or delivery channel and asks the model to review whether posted
plans are concrete enough to act on.

- [`../plan-reviews-minimal-config.json`](../plan-reviews-minimal-config.json) is the smallest
  version. It configures one channel and no matchers, so every non-empty, redacted message in that
  channel can become an anchor message.
- [`../plan-reviews-config.json`](../plan-reviews-config.json) is the full version. It adds storage,
  user filters, explicit planning matchers, context limits, synthetic-thread scoring, and
  provider-backed scoring settings.

Use the minimal config when the channel is already dedicated to planning updates. In high-volume
channels, use explicit matchers like the full config to restrict what reaches the model and avoid
noise.
