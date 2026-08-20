import { describe, it, expect } from 'vitest'
import { formatInvalidArgsFeedback, isInvalidArgsResult } from '../src/feedback/invalid-args.js'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

describe('INVALID_ARGS Feedback Enhancer', () => {
  const invalidArgsResult: ToolExecutionResult = {
    isError: true,
    error: {
      message: 'invalid arguments: missing required property "command"',
      info: { code: 'INVALID_ARGS', name: 'pwsh' },
    },
    content: [],
  }

  it('should include tool name, provided arguments, and a clear rejection notice', () => {
    const feedback = formatInvalidArgsFeedback(
      'pwsh',
      { description: 'Run node script with custom args' },
      invalidArgsResult,
    )

    expect(feedback).toContain('Tool call rejected before execution.')
    expect(feedback).toContain('Tool: pwsh')
    expect(feedback).toContain('Run node script with custom args')
    expect(feedback).toContain('missing required property "command"')
    expect(feedback).toContain('did NOT execute')
    expect(feedback).toContain('COMPLETE argument object')
  })

  it('should render string arguments without JSON wrapping', () => {
    const feedback = formatInvalidArgsFeedback('pwsh', '{"description":"x"}', invalidArgsResult)
    expect(feedback).toContain('{"description":"x"}')
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