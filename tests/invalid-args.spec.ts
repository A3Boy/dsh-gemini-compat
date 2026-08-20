import { describe, it, expect } from 'vitest'
import { formatInvalidArgsFeedback } from '../src/feedback/invalid-args.js'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

describe('INVALID_ARGS Feedback Enhancer', () => {
  it('should format clean, diagnostic feedback without tool-specific branching', () => {
    const result: ToolExecutionResult = {
      isError: true,
      error: {
        message: 'invalid arguments: missing required property "command"',
        info: { code: 'INVALID_ARGS', name: 'pwsh' },
      },
      content: [],
    }

    const feedback = formatInvalidArgsFeedback(
      'pwsh',
      { description: 'Git commit and push changes' },
      result,
    )

    expect(feedback).toContain('Tool call rejected before execution.')
    expect(feedback).toContain('Tool: pwsh')
    expect(feedback).toContain('missing required property "command"')
    expect(feedback).toContain('The tool did not execute.')
  })

  it('should include the provided arguments for model self-correction', () => {
    const result: ToolExecutionResult = {
      isError: true,
      error: {
        message: 'invalid arguments: missing required property "connection_id"',
        info: { code: 'INVALID_ARGS', name: 'database_query' },
      },
      content: [],
    }

    const feedback = formatInvalidArgsFeedback(
      'database_query',
      { sql: 'SELECT * FROM users' },
      result,
    )

    expect(feedback).toContain('Tool: database_query')
    expect(feedback).toContain('sql')
    expect(feedback).toContain('SELECT * FROM users')
    expect(feedback).toContain('connection_id')
  })

  it('should use error.message when no violations array is available', () => {
    const result: ToolExecutionResult = {
      isError: true,
      error: {
        message: 'invalid arguments: missing required property "file_path"',
        info: { code: 'INVALID_ARGS', name: 'edit' },
      },
      content: [],
    }

    const feedback = formatInvalidArgsFeedback(
      'edit',
      { new_string: 'test' },
      result,
    )

    expect(feedback).toContain('missing required property "file_path"')
    expect(feedback).toContain('Tool: edit')
  })
})
