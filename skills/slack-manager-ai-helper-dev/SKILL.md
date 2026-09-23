---
name: slack-manager-ai-helper-dev
description: Develop slack-manager-ai-helper safely. Use for any code, test, schema, packaging, or documentation change in this repository, including selecting specifications, following TypeScript conventions, testing CLI modules, and verifying distributable bundles.
license: GPL-3.0-or-later
---

# Develop slack-manager-ai-helper

1. Load repository guidance and route the change.
   - Read AGENTS.md, then specs/README.md.
   - Read only the functional specs selected by [references/repo-conventions.md](references/repo-conventions.md).
   - **Done when:** implementation files, tests, and owning specs are identified before editing.

2. Establish the supported runtime.
   - Run nvm use.
   - Use the pnpm version pinned by packageManager; do not substitute npm or yarn.
   - Inspect the working tree and preserve unrelated user changes.
   - **Done when:** the pinned Node version is active and existing changes are understood.

3. Implement using local conventions.
   - Keep TypeScript/JavaScript single-quoted and use explicit .js extensions for ESM imports.
   - Treat schemas/config.schema.json as canonical for config shape; update README field documentation whenever config behavior changes.
   - Keep yargs options and validation in the owning src/commands/<command>.ts module.
   - Use src/commands/compact-state.ts and tests/compact-state-command.test.ts as command-module and CLI test patterns.
   - Update the owning spec in the same change.
   - **Done when:** code, focused tests, and durable documentation describe the same behavior.

4. Verify command and package behavior.
   - Run focused tests while iterating.
   - For CLI packaging changes, confirm scripts/build-cli.mjs still creates dist/bundle/slack-manager-ai-helper.mjs with one shebang and package bin points to it.
   - Confirm distributable source belongs in the package.json files allowlist.
   - **Done when:** focused checks pass and built/package paths are internally consistent.

5. Run authoritative QA.
   - Run pnpm run qa after nvm use.
   - Fix check, build, test, and typecheck failures; do not finish with warnings.
   - **Done when:** pnpm run qa exits successfully.

6. Use BOT identity for repository operations.
   - Run every agent-initiated Git or GitHub command through the operator's configured BOT runner wrapper when one is available; never use personal credentials.
   - Never use the operator's personal Git or GitHub credentials.
   - Do not commit or push unless the operator requested it.
   - **Done when:** requested repository operations use BOT identity and no unauthorized commit or push occurred.
