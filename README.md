# dsh-gemini-compat

Gemini Tool Calling Compatibility Plugin for DeepSeek Harness (DSH).

Improves Gemini interoperability with DeepSeek Harness without replacing DSH tools.
It keeps DSH ToolSchema as the single source of truth, preserves provider-native Gemini replay metadata,
verifies streamed tool-call integrity, and makes existing INVALID_ARGS feedback more actionable.

## Features

- **Lossless Schema Projection**: Strips unneeded `$schema` while enforcing strict compatibility.
- **JSON Integrity Gate**: Prevents malformed or truncated tool calls from polluting sessions.
- **Replay Metadata Preservation**: Round-trips Gemini thought signatures without modifying core message types.
- **Generic INVALID_ARGS Feedback Enhancer**: Clear, actionable error feedback without tool-specific logic.
- **Comprehensive Trace & Diagnostics**: 4-stage tracing (Stage A-D) with automated telemetry classification.

## License

MIT
