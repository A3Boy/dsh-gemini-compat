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
})
