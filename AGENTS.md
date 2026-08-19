# AGENTS.md - slack-manager-ai-helper

This file is the canonical guide for humans and coding agents working in this repository. Keep it focused on agent workflow, repo navigation, and contribution requirements. Durable product and runtime specifications live under [`specs/`](./specs/).

## Self-update protocol (required)

When you learn something durable about this project, update the documentation source that owns it in the same change before finishing the task:

- Update the relevant functional spec under [`specs/`](./specs/) for architecture, behavior, SQL schema assumptions, command semantics, validation rules, operational behavior, or prompt policy.
- Use [`specs/README.md`](./specs/README.md) to choose the right spec file. If no existing spec fits, create a focused markdown file under `specs/` and add it to the index.
- Update this `AGENTS.md` only for agent workflow, tooling, QA, repository-layout, or documentation-routing guidance.
- Do not duplicate existing guidance. Revise or remove stale bullets when behavior changes.

Before finishing any task that touches config behavior, including schema, loader, example configs, or generated config behavior, check that [`README.md`](./README.md) documents every field and constraint in [`schemas/config.schema.json`](./schemas/config.schema.json). Update `README.md` in the same change if it is missing or stale. Treat the schema as the canonical source for config shape.

## Spec routing

Read [`specs/README.md`](./specs/README.md) before changing a functional area, then read the specific spec files that match the change:

- [`specs/configuration.md`](./specs/configuration.md): config loading, validation, prompt references, Slack source selection, matching, redaction, context expansion, synthetic threads, scored matchers, and slacrawl read behavior.
- [`specs/state-and-evidence.md`](./specs/state-and-evidence.md): persisted state, run selection, evidence expansion, memory continuity, compact state, and LLM input state shape.
- [`specs/llm-analysis.md`](./specs/llm-analysis.md): AI SDK analysis calls, structured output, model fallback/retry behavior, providers, token-window segmentation, and model-input inspection.
- [`specs/cli-commands.md`](./specs/cli-commands.md): CLI command semantics, date/window flags, config-editing wizards, validation commands, evidence resolution, and Ollama helper commands.
- [`specs/portfolio.md`](./specs/portfolio.md): implemented portfolio manifest behavior, target lifecycle, run/rollup/maintenance execution, report publishing, notification delivery, and `manage-portfolio`.
- [`specs/run-portfolio.md`](./specs/run-portfolio.md): source spec and roadmap for generic portfolio automation.
- [`specs/plan-review-prompts.md`](./specs/plan-review-prompts.md): plan-review prompt rules and evidence policy.
- [`specs/packaging-and-operations.md`](./specs/packaging-and-operations.md): npm packaging, publish behavior, slacrawl installation/runtime assumptions, environment variables, and local operational notes.

## Project overview

`slack-manager-ai-helper` uses the [`slacrawl`](https://github.com/openclaw/slacrawl) command line and read-only SQLite database to help managers track teams and tasks from Slack. It monitors configured Slack sources, matches messages to configured patterns or scored questions, expands evidence, sends compact redacted context to an LLM through the Vercel AI SDK `generateText()`, and persists reports plus memory for future runs.

## Repository layout

- `src/slack-manager-ai-helper.ts` is the CLI composition entrypoint.
- CLI subcommands live under `src/commands/`; keep each command's yargs flags in its own command module.
- `src/run-once.ts` orchestrates one configured run.
- `src/config/` loads and validates JSON configs with Ajv.
- `src/slacrawl/` introspects the read-only slacrawl SQLite schema and reads messages.
- `src/matching/`, `src/state/`, `src/synthetic/`, and `src/llm/` contain matching, context/state, synthetic-thread scoring, and prompt/model helpers.
- `src/portfolio/` loads, validates, plans, executes, and edits portfolio manifests.
- `schemas/config.schema.json` is canonical for config fields and constraints.
- `schemas/portfolio.schema.json` defines portfolio manifests.
- `schemas/persisted-state.schema.json` and `schemas/state.schema.json` define persisted state and compact LLM input state.
- `examples/` contains full and minimal JSON config variants per topic.
- Example-specific prompt files live beside their examples under `examples/<topic>/`.
- `specs/` contains durable functional specifications. Keep those files current when behavior changes.

## Tooling

- **Node**: use `nvm use` before running project commands; `.nvmrc` pins the required version.
- **TypeScript**: `tsconfig.json` extends `@tsconfig/strictest` with `"types": ["node"]`.
- **pnpm**: package management is pinned by `packageManager`.
- **Biome**: formatting and linting; TypeScript/JavaScript use single quotes.
- **Vitest**: unit and integration test runner.
- **Pino**: structured runtime logging.
- **yargs**: CLI command and option parsing.

## Formatting and QA (required before finishing work)

- TypeScript/JavaScript use single quotes. JSON config and schema files keep standard double-quoted JSON.
- Run `nvm use` first, then `pnpm run qa` before handing work back. `pnpm run qa` runs `check`, `build`, `test`, and `typecheck` in parallel.
- Fix all QA failures before calling the task done.
- `pnpm run check` uses `--error-on-warnings`; rules configured as warnings, such as `complexity/useLiteralKeys`, must stay warning-free.
- `pnpm run check:fix` applies Biome format plus safe lint fixes. Re-run `pnpm run qa` after auto-fixes.
- Husky runs `pnpm run qa` before commits. Do not commit with failing QA.
- Docs-only changes still need QA unless the user explicitly asks to skip it.

## Code and documentation conventions

- ESM is used throughout; TypeScript imports include `.js` extensions.
- Minimize scope of changes and match existing local style.
- All machine-readable artifacts are JSON, pretty-printed with 2-space indentation and a trailing newline.
- Validate machine-readable artifacts with Ajv against `schemas/*.schema.json` before persisting.
- Do not commit secrets, `tmp/`, logs, generated state, or browser profile data.
- Both code and documentation must use project-relative file paths. Do not add absolute local filesystem paths.
- For local CLI commands during development, prefer the package script pattern already used in this repo: `pnpm run slack-manager-ai-helper <subcommand>`.

## Common commands

- `pnpm run qa`
- `pnpm run check`
- `pnpm run check:fix`
- `pnpm run build`
- `pnpm run test`
- `pnpm run typecheck`
- `pnpm run slack-manager-ai-helper run --config examples/plan-reviews-config.json`
- `pnpm run slack-manager-ai-helper validate-config --config examples/plan-reviews-config.json`

See [`specs/cli-commands.md`](./specs/cli-commands.md) for command semantics and examples.

## Cursor Cloud specific instructions

Environment is prepared by the startup update script (Node per `.nvmrc`, corepack, `pnpm install`). Standard commands live in "Common commands" above and `package.json`; this section only records non-obvious cloud caveats.

- **Node resolution**: the sandbox ships a default `node` (v22) that shadows the project's required Node 26 (`.nvmrc`). The agent's `~/.bashrc` prepends the nvm Node 26 bin so `node`, `pnpm`, and `corepack` resolve to the correct version in interactive shells. If `node -v` ever shows v22, run `nvm use` (from the repo root) before any project command. If `.nvmrc` bumps the Node version, update the `~/.bashrc` PATH line accordingly.
- **pnpm via corepack**: Node 26 no longer bundles corepack, so it is installed globally (`npm i -g corepack`) and `corepack enable` provides the pinned `pnpm@11.9.0` from `packageManager`. Do not `npm i -g pnpm`; let corepack manage the version.
- **TZ is required for the test suite**: many test fixtures assume the local timezone `America/Sao_Paulo` (hardcoded in tests, e.g. a message at epoch is expected on a specific local date, and `HH:MM` rendering is offset-sensitive). `~/.bashrc` exports `TZ=America/Sao_Paulo`, so `pnpm run qa`/`pnpm run test` pass. With `TZ` unset (UTC), ~13 date-window tests fail spuriously. Set `TZ=America/Sao_Paulo` before running tests if it is missing.
- **Known pre-existing test failure**: `tests/manage-portfolio.test.ts > "prompts for guided runAndNotifyConfig when adding a target"` fails on an unmodified `master` (a wizard prompt-flow assertion, unrelated to environment setup). Expect `230 passed | 1 failed | 3 skipped`.
- **Running the app end-to-end**: `run` executes the full pipeline (read slacrawl SQLite read-only → match → redact → compile prompt → call LLM) and needs an LLM provider credential (e.g. `OPENAI_API_KEY`) or a local Ollama server. Read-only commands (`collect-model-input`, `validate-config`, `inspect-config`, `resolve-evidence`) need no credentials and are the quickest way to exercise the core pipeline without a model. Point `storage.slacrawlDatabasePath` at a SQLite file to avoid needing the `slacrawl` CLI; the reader auto-detects the message table/columns.
