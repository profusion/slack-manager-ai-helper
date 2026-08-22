# Packaging And Operations

## Environment variables

| Provider | Typical env vars |
| --- | --- |
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| google | `GOOGLE_GENERATIVE_AI_API_KEY` |
| xai | `XAI_API_KEY` |
| openrouter | `OPENROUTER_API_KEY` |
| opencode | OpenCode CLI plus provider keys in OpenCode config |

| Variable | Meaning |
| --- | --- |
| `LOG_LEVEL` | Pino level, default `info` |

Load API keys and `LOG_LEVEL` from a `.env` file in the project root via dotenv. `src/env.ts` is imported first in CLI entrypoints, and Vitest uses `tests/setup-env.ts`.

## npm publish

- Development and release workflows use the versions pinned in `.nvmrc` and `packageManager`; the package `engines` fields enforce the same minimum Node.js and pnpm releases for consumers.
- `prepublishOnly` runs `pnpm run build`, producing minified `dist/bundle/*.mjs` bundles with shebangs.
- Bundled CLI shebangs come from the TypeScript entrypoint source.
- Do not add an esbuild `banner` shebang because Node only accepts `#!` at byte 0 and duplicated shebangs break direct `node dist/bundle/*.mjs` execution.
- `files` ships bundles, `schemas/`, examples, and docs.
- `prepare` skips Husky during `pnpm pack` and `pnpm publish` so packaging does not try to mutate `.git/config`.
- `bin` maps `slack-manager-ai-helper` to `dist/bundle/*.mjs`.
- Slacrawl is a native package and not available in npmjs, so it must be checked before usage and the user should manually install it using an OS-specific installer such as `brew install slacrawl`.
- `prepare` runs Husky only in a git clone with dev dependencies, not on end-user `npm install`.

## Operational notes

- `slacrawl` must be installed separately.
- The CLI uses `slacrawl metadata --json` for the default database path when config does not set `storage.slacrawlDatabasePath`.
- The slacrawl database is opened read-only.
- All helper state goes to `storage.statePath`, defaulting to `state-<topic>.json` beside the config file.
- Synthetic-thread and scored-matcher embeddings/classifier settings execute through AI SDK providers when enabled.
- Ollama remains the default local provider for helper scoring models.
