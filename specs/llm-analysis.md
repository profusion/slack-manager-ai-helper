# LLM Analysis

Analysis uses the Vercel AI SDK `generateText()` with configured provider settings. The model is called only after deterministic matching finds messages.

## Prompt and output flow

- Prompt system sections are configured prompts, minified state schema, and structured output instructions when the combined prompt has a fenced `jsonschema` block.
- Prompt user sections are minified compact state JSON and previous memory when available.
- Analysis prompts with a `jsonschema` block use structured model output: top-level `memory` plus markdown `reportText`.
- Do not ask analysis models to return fenced memory/report sections.
- Model output Slack evidence links are canonicalized against the current evidence set before report extraction, memory validation, stdout, and persistence because models may strip `?thread_ts=<threadTs>` from reply permalinks even when model input hrefs are correct.

## Model config behavior

- Analysis uses `config.model.temperature` and optional `config.model.maxOutputTokens`.
- Analysis model calls omit configured `temperature` for known reasoning model families such as `gpt-5...` and `o1/o3/o4...`.
- `model.reasoningEffort` accepts `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` and is passed through as the provider-specific AI SDK reasoning-effort option for providers/models that support it.
- `model.baseUrl` configures analysis model providers that support custom endpoints, such as `openai-compatible` and `ollama`.
- Scoring helper providers keep their own nested `baseUrl` fields.
- `model.timeoutMs` optionally aborts analysis model calls after the configured milliseconds.
- Scoring helper providers keep their own nested `timeoutMs` fields.
- `model.openrouter` is only used when `model.provider` is `openrouter`; omitted subfields are not sent.
- `includeReasoning: false` sends `reasoning.exclude: true`, while `order` and `allowFallbacks` configure OpenRouter provider routing.

## Retries, fallbacks, and invalid output

- `model.retries` defaults to `3` for each analysis model, meaning up to four calls to that model before falling back or failing.
- `model.fallback` is a recursive analysis model config with the same options.
- Fallback is tried after provider execution errors exhaust retries or after `model.failOnInvalidOutput: true` rejects structured output for all attempts.
- `model.failOnInvalidOutput: true` retries schema-invalid model outputs according to `model.retries` before trying `model.fallback` or failing the run.
- A structured report is schema-invalid when, after Markdown formatting, links, URLs, code fences, and punctuation are removed, it contains fewer than `model.minReportWords` runs of four or more alphabetic characters. The default is 25. Retry prompts explicitly request a longer, more detailed report.
- When `model.failOnInvalidOutput` is false, invalid outputs are stored with validation errors and do not trigger fallback.
- OpenAI, OpenAI-compatible, and gateway requests receive a provider-compatible copy of the structured output schema with regex lookarounds removed, because OpenAI Structured Outputs rejects lookarounds. The original schema remains the local validation contract.
- Persisted `modelCalls` records each attempted provider/model separately, with its own attempt count; `modelAttempts` remains the total across the chain.

## Segmentation

- Set `model.contextWindowTokens` to enable compiled-input segmentation.
- The runtime estimates the full compiled `system + prompt`, including prompts, schemas, compact state, and previous memory.
- The runtime reserves `maxOutputTokens` or a conservative default for output.
- Evidence is split into local date/channel segments before model calls would exceed the configured window.
- When model fallbacks are configured, segmentation uses the smallest configured `contextWindowTokens` and largest configured `maxOutputTokens` across the fallback chain.
- Segmented runs merge segment reports chronologically into one stdout/stored report.
- Segmented runs persist one JSON memory object containing extracted segment memories.
- Future runs receive that merged memory as previous memory.

## Providers

- Built-in analysis/classifier providers are OpenAI, Anthropic, Google, xAI, OpenRouter, OpenCode, AI Gateway, Ollama, and `openai-compatible` mapped to OpenAI-compatible SDK behavior.
- Scoring helper embeddings also use AI SDK providers.
- Supported embedding provider ids are providers with embedding factories such as `ollama`, `openai`, `openrouter`, `google`, `gateway`, and `openai-compatible`.
- Add new LLM providers by patching `src/providers.ts`.

## Inspection and logging

- `LOG_LEVEL=debug` includes compiled model input and redacted model output.
- Use debug logging while setting up prompts/configs, but use `LOG_LEVEL=warn` for real usage.
- `collect-model-input` prints the compiled `modelInput.system`/`modelInput.prompt` JSON without calling the model or updating state.
- Compact LLM state dates/times are formatted in the local timezone inferred from the `TZ` environment variable.
- Message times are `HH:MM` without seconds because they are nested under a local date.
- The CLI warns and falls back to the system timezone when `TZ` is unset.
