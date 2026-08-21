import { describe, it, expect } from 'vitest'
import { DiagnosticsCollector } from '../src/diagnostics/trace.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

describe('Integration: Diagnostics with official ToolSchema', () => {
  const tools: ToolSchema[] = [
    {
      name: 'pwsh',
      description: 'Execute PowerShell command',
      parameters: {
        type: 'object' as const,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['command', 'description'],
      },
    },
    {
      name: 'edit',
      description: 'Edit a file',
      parameters: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  ]

  it('should classify a model argument contract violation', () => {
    const diag = new DiagnosticsCollector()

    const report = diag.generateFailureReport(
      'gemini-router',
      'gemini-2.0-flash',
      'pwsh',
      '{"description":"list files"}',
      { description: 'list files' },
      'missing required property "command"',
    )

    expect(report.validation.status).toBe('INVALID_ARGS')
    expect(report.classification).toBe('MODEL_ARGUMENT_CONTRACT_VIOLATION')
  })

  it('should classify an adapter argument loss', () => {
    const diag = new DiagnosticsCollector()

    const report = diag.generateFailureReport(
      'gemini-router',
      'gemini-2.0-flash',
      'pwsh',
      '{"command":"dir","description":"list"}',
      { description: 'list' },
      'missing required property "command"',
    )

    expect(report.classification).toBe('ADAPTER_ARGUMENT_LOSS')
  })

  it('should classify a malformed stream truncation', () => {
    const diag = new DiagnosticsCollector()

    const report = diag.generateFailureReport(
      'gemini-router',
      'gemini-2.0-flash',
      'pwsh',
      '{"command":"incomplete',
      null,
      'JSON parse error',
      true,
    )

    expect(report.classification).toBe('MALFORMED_STREAM_TRUNCATION')
  })

  it('should classify provider protocol error for unparseable JSON', () => {
    const diag = new DiagnosticsCollector()

    const report = diag.generateFailureReport(
      'gemini-router',
      'gemini-2.0-flash',
      'pwsh',
      'not json at all',
      null,
      'could not parse arguments',
    )

    expect(report.classification).toBe('PROVIDER_PROTOCOL_ERROR')
  })

  it('should return UNKNOWN when there is no validation error', () => {
    const diag = new DiagnosticsCollector()

    const report = diag.generateFailureReport(
      'gemini-router',
      'gemini-2.0-flash',
      'pwsh',
      '{"command":"dir","description":"list"}',
      { command: 'dir', description: 'list' },
    )

    expect(report.validation.status).toBe('VALID')
    expect(report.classification).toBe('UNKNOWN')
  })

  it('should track aggregate metrics', () => {
    const diag = new DiagnosticsCollector()

    diag.generateFailureReport('p', 'm', 't', '{}', {}, 'missing field')
    diag.generateFailureReport('p', 'm', 't', '{}', {}, 'missing field')
    diag.generateFailureReport('p', 'm', 't', '{}', {}, undefined)

    const metrics = diag.getMetrics()
    expect(metrics.toolCallsTotal).toBe(3)
    expect(metrics.invalidArgsTotal).toBe(2)
    expect(metrics.invalidArgsRate).toBeCloseTo(2 / 3)
  })

  it('should map nested Google context overflow 400 to CONTEXT_WINDOW_EXCEEDED', async () => {
    const { isContextOverflow } = await import('../src/adapter/adapter.js')
    
    // Real upstream error format: nested JSON string in error.message
    const rawError = JSON.stringify({
      error: {
        code: 400,
        message: 'The input token count (1213507) exceeds the maximum number of tokens allowed 1048576',
        status: 'INVALID_ARGUMENT',
      },
    })
    
    // The adapter extracts the nested message
    let detail = rawError
    try {
      const parsed = JSON.parse(rawError)
      if (parsed.error?.message) detail = parsed.error.message
    } catch {}

    expect(isContextOverflow(detail)).toBe(true)
  })

  describe('isContextOverflow classification', () => {
    it('matches Google input token count overflow format', async () => {
      const { isContextOverflow } = await import('../src/adapter/adapter.js')
      const googleError =
        'The input token count (1213507) exceeds the maximum number of tokens allowed 1048576.'
      expect(isContextOverflow(googleError)).toBe(true)
    })

    it('matches generic token count exceeds format', async () => {
      const { isContextOverflow } = await import('../src/adapter/adapter.js')
      const altGoogleError = 'Request payload token count exceeds 1048576 tokens limit'
      expect(isContextOverflow(altGoogleError)).toBe(true)
    })

    it('matches OpenAI context window format via DSH fallback', async () => {
      const { isContextOverflow } = await import('../src/adapter/adapter.js')
      const openaiError =
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."
      expect(isContextOverflow(openaiError)).toBe(true)
    })

    it('rejects non-context-overflow 400 errors containing "exceeds"', async () => {
      const { isContextOverflow } = await import('../src/adapter/adapter.js')
      // Quota / Rate limit errors
      expect(isContextOverflow('Quota exceeded for quota metric "Queries" and limit "Queries per minute"')).toBe(false)
      expect(isContextOverflow('Resource has been exhausted (e.g. check quota-exceeded)')).toBe(false)
      expect(isContextOverflow('User rate limit exceeded.')).toBe(false)

      // Output token / max completion limit (not context window overflow)
      expect(isContextOverflow('Generation stopped because max_output_tokens exceeded')).toBe(false)
      expect(isContextOverflow('Response length exceeds maximum allowed completion tokens 8192')).toBe(false)

      // General payload / field size errors
      expect(isContextOverflow('Request body size exceeds 10MB limit')).toBe(false)
      expect(isContextOverflow('Number of function declarations exceeds maximum allowed 128')).toBe(false)
      expect(isContextOverflow('Function call argument nesting depth exceeds 10')).toBe(false)

      // Unrelated 400 bad requests
      expect(isContextOverflow('Invalid function call schema')).toBe(false)
      expect(isContextOverflow('API key not valid. Please pass a valid API key.')).toBe(false)
    })
  })

  describe('resolveModel capacity override', () => {
    it('uses default capacity when no model-specific override provided', async () => {
      const { GeminiCompatAdapter } = await import('../src/adapter/adapter.js')
      const adapter = new GeminiCompatAdapter({
        baseURL: 'https://example.com/v1',
        defaultModel: 'gemini-2.5-flash',
        wireProfile: 'google-openai',
        toolSchemaReinforcement: 'off',
        streamIdleTimeoutMs: 10000,
        contextWindow: 1_048_576,
        defaultMaxTokens: 65_536,
        resolveApiKey: async () => 'test-key',
        replayCodec: {} as any,
      })

      const modelInfo = await adapter.resolveModel('google', 'gemini-2.5-flash')
      expect(modelInfo.context?.contextWindow).toBe(1_048_576)
      expect(modelInfo.defaultMaxTokens).toBe(65_536)
    })

    it('applies model-specific override when defined', async () => {
      const { GeminiCompatAdapter } = await import('../src/adapter/adapter.js')
      const adapter = new GeminiCompatAdapter({
        baseURL: 'https://example.com/v1',
        defaultModel: 'gemini-2.5-flash',
        wireProfile: 'google-openai',
        toolSchemaReinforcement: 'off',
        streamIdleTimeoutMs: 10000,
        contextWindow: 1_048_576,
        defaultMaxTokens: 65_536,
        models: {
          'gemini-2.5-pro': {
            contextWindow: 2_097_152,
            defaultMaxTokens: 65_536,
          },
          'gemini-1.5-flash-8b': {
            contextWindow: 1_000_000,
            defaultMaxTokens: 8_192,
          },
        },
        resolveApiKey: async () => 'test-key',
        replayCodec: {} as any,
      })

      const proModel = await adapter.resolveModel('google', 'gemini-2.5-pro')
      expect(proModel.context?.contextWindow).toBe(2_097_152)
      expect(proModel.defaultMaxTokens).toBe(65_536)

      const smallModel = await adapter.resolveModel('google', 'gemini-1.5-flash-8b')
      expect(smallModel.context?.contextWindow).toBe(1_000_000)
      expect(smallModel.defaultMaxTokens).toBe(8_192)

      const defaultModel = await adapter.resolveModel('google', 'gemini-2.5-flash')
      expect(defaultModel.context?.contextWindow).toBe(1_048_576)
      expect(defaultModel.defaultMaxTokens).toBe(65_536)
    })
  })
})
