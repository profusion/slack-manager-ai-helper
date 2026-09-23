# Repository conventions reference

## Specification routing

- specs/configuration.md: configuration, loading, matching, redaction, and Slack reads.
- specs/state-and-evidence.md: state, evidence, memory continuity, and compaction.
- specs/llm-analysis.md: model calls, structured output, retries, and model input.
- specs/cli-commands.md: CLI semantics and options.
- specs/portfolio.md: portfolio manifests, lifecycle, execution, and editing.
- specs/run-portfolio.md: generic portfolio automation roadmap.
- specs/plan-review-prompts.md: plan-review prompt and evidence policy.
- specs/packaging-and-operations.md: npm packaging and runtime operations.

## Command module pattern

Keep each yargs command's arguments, options, validation, handler, and structured output in its own module under src/commands/. Test user-observable behavior in tests/*-command.test.ts, including invalid input and persistence side effects. Use compact-state as the reference implementation.

## Packaging

The TypeScript entrypoint is bundled by esbuild into dist/bundle/slack-manager-ai-helper.mjs. The bundle carries the executable shebang, and package.json bin exposes it as slack-manager-ai-helper. Keep shipped non-bundle assets in the files allowlist.
