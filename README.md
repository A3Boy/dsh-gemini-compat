# dsh-gemini-compat

Gemini tool calling compatibility adapter for DeepSeek Harness (DSH).

A provider adapter that translates OpenAI-compatible Gemini endpoints (Google AI, OpenRouter, etc.) into the official DSH `StreamChunk` protocol. Directly imports `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` — no local mirror types.

## Features

- **Official `LlmAdapter`**: `GeminiCompatAdapter extends LlmAdapter` with `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`.
- **DSH Block Lifecycle**: `block-start` → deltas → `block-end` with the assembled `ContentBlock`. Block indices are assigned independently from provider `tool_calls[].index`.
- **Trailing Usage**: Finish reason and usage are deferred until `[DONE]`, so trailing usage-only chunks are captured. Usage always precedes finish; nothing follows finish.
- **JSON Integrity Gate**: Tool-call arguments are validated as parseable JSON objects before `block-end` is emitted. Truncated arguments abort with `MALFORMED_RESPONSE`.
- **Malformed SSE Detection**: Non-JSON SSE payloads throw `MALFORMED_RESPONSE` — never silently swallowed.
- **SSE Truncation Detection**: Stream ending without `[DONE]` throws `STREAM_CLOSED`.
- **Error Classification**: HTTP 401/403 → `AUTH`, 429 → `RATE_LIMIT`, 400 → `INVALID_REQUEST`, 500+ → `SERVER`, transport failures → `TRANSPORT`. Uses official `LlmError`.
- **Attribution Headers**: Every provider request includes `attributionHeaders()`.
- **Replay Metadata**: `RouteSpecificReplayCodec` preserves Gemini thought signatures using exactly one strategy per route (google-standard, extra-content, openrouter-reasoning, passthrough). Output follows the official `ReplayEnvelope` shape.
- **INVALID_ARGS Feedback**: `ctx.on('tools/post-execute', ...)` returns the official `PostToolDecision` with structured `{ kind: 'block', feedback: ContentBlock[] }`. Strictly detects `result.error.info.code === 'INVALID_ARGS'` — no tool-specific branching.
- **Credential Boundary**: API key resolved per request via `credentialRef` and `ctx.credentials`, with environment fallback.
- **Schemastery Config**: `z.object()` schema for plugin configuration.
- **Lossless Schema Projection**: Strips `$schema` while preserving all validation semantics.

## License

MIT