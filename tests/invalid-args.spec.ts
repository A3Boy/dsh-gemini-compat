import { describe, it, expect } from 'vitest'
import { formatInvalidArgsFeedback, isInvalidArgsResult } from '../src/feedback/invalid-args.js'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

describe('INVALID_ARGS Feedback Enhancer', () => {
  it('should format clean, diagnostic feedback for INVALID_ARGS', () => {
    const result: ToolExecutionResult = {
      isError: true,
      error: {
        message: 'invalid arguments: missing required property "command"',
        info: { code: 'INVALID_ARGS', name: 'pwsh' },
      },
      content: [],
    }

    const feedback = formatInvalidArgsFeedback(result)

    expect(feedback).toContain('The tool execution failed because the provided arguments were invalid.')
    expect(feedback).toContain('missing required property "command"')
  })

  it('should detect INVALID_ARGS result', () => {
    const validResult: ToolExecutionResult = {
      isError: true,
      error: { message: 'bad', info: { code: 'INVALID_ARGS', name: 't' } },
      content: [],
    }
    const businessError: ToolExecutionResult = {
      isError: true,
      error: { message: 'command failed', info: { code: 'COMMAND_FAILED', name: 't' } },
      content: [],
    }
    const successResult: ToolExecutionResult = {
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    }

    expect(isInvalidArgsResult(validResult)).toBe(true)
    expect(isInvalidArgsResult(businessError)).toBe(false)
    expect(isInvalidArgsResult(successResult)).toBe(false)
  })
})