# Functional Specs

This directory contains durable behavior contracts for `slack-manager-ai-helper`. Agents should read this index, then the relevant spec files, before changing runtime behavior, schemas, examples, prompts, commands, packaging, or operational flows.

Update these specs in the same change whenever implementation behavior changes. Keep `AGENTS.md` focused on agent workflow and use these files for product/runtime details.

## Spec index

- [`configuration.md`](./configuration.md): config loading, validation, prompt references, Slack source selection, matching, redaction, context expansion, synthetic threads, scored matchers, and slacrawl read behavior.
- [`state-and-evidence.md`](./state-and-evidence.md): persisted state, run selection, evidence expansion, memory continuity, compact state, and LLM input state shape.
- [`llm-analysis.md`](./llm-analysis.md): AI SDK analysis calls, structured output, model fallback/retry behavior, providers, token-window segmentation, and model-input inspection.
- [`cli-commands.md`](./cli-commands.md): CLI command semantics, date/window flags, config-editing wizards, validation commands, evidence resolution, and Ollama helper commands.
- [`portfolio.md`](./portfolio.md): implemented portfolio manifest behavior, target lifecycle, run/rollup/maintenance execution, report publishing, notification delivery, and `manage-portfolio`.
- [`run-portfolio.md`](./run-portfolio.md): source spec and roadmap for generic portfolio automation.
- [`plan-review-prompts.md`](./plan-review-prompts.md): plan-review prompt rules and evidence policy.
- [`packaging-and-operations.md`](./packaging-and-operations.md): npm packaging, publish behavior, slacrawl installation/runtime assumptions, environment variables, and local operational notes.
