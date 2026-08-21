# dsh-gemini-compat

Gemini OpenAI-compatible tool calling adapter plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

## Architecture

- **`extends LlmAdapter`**: Implements the official DSH `LlmAdapter` abstraction directly.
- **DSH Block Lifecycle**: Maps SSE chunks into `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`.
- **JSON Integrity Gate**: Validates all tool-call arguments as well-formed JSON objects before emitting `block-end`.
- **Deferred Completion**: Defers `usage` and `finish` until after `[DONE]`. Usage always precedes finish; nothing follows finish.
- **Stateless Replay Codec**: Replays Gemini thought signatures (`extra_content.google.thought_signature`) reading from `message.source.replayState`.
- **INVALID_ARGS Enhancement**: Corrects model-facing feedback while preserving structured error identity (`{ kind: 'accept', content: [...] }`).

## Supported Wire Profiles

- **`google-openai`** (default): Google's OpenAI-compatible endpoint. Captures and replays `extra_content.google.thought_signature`.
- **`generic-openai`**: Generic OpenAI-compatible endpoints with standard tool calls.

## Installation in DSH

### Option 1: DSH Profile Bundle

Add to your `package.json`'s `dsh.profile.bundles` if working within a DSH workspace:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-gemini-compat"]
    }
  }
}
```

### Option 2: Cordis Patch (`cordis.patch.yml`)

Add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: gemini-compat
      name: dsh-gemini-compat
      config:
        apiKeyEnv: GEMINI_API_KEY
        baseURL: https://generativelanguage.googleapis.com/v1beta/openai
        wireProfile: google-openai
        defaultModel: gemini-2.0-flash
        streamIdleTimeoutMs: 300000
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKeyEnv` | `string` | `"GEMINI_API_KEY"` | Environment variable for API key |
| `baseURL` | `string` | Google endpoint | Base URL for OpenAI-compatible endpoint |
| `wireProfile` | `"google-openai" \| "generic-openai"` | `"google-openai"` | Replay/wire adaptation profile |
| `toolSchemaReinforcement` | `"off" \| "auto" \| "required-only"` | `"auto"` | Tool schema reinforcement prompt mode |
| `contextWindow` | `number` | `1048576` | Default context window capacity for models |
| `defaultMaxTokens` | `number` | `65536` | Default maximum output tokens |
| `models` | `Record<string, { contextWindow?, defaultMaxTokens? }>` | `{}` | Optional per-model capacity overrides |
| `defaultModel` | `string` | `"gemini-2.0-flash"` | Fallback model name |
| `streamIdleTimeoutMs` | `number` | `300000` | Transport idle timeout in ms |
| `enableDiagnostics` | `boolean` | `false` | Enable diagnostic trace collection |

## Development

```bash
npm run build   # Type-check and compile to lib/
npm run check   # Type-check only
npm run test    # Run test suite
```

## License

MIT
