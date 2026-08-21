import { describe, it, expect } from 'vitest'
import {
  InvalidArgsEscalation,
  buildInvalidArgsRetryNotice,
  formatConciseResult,
  extractMissingFields,
  recoveryKey,
} from '../src/feedback/recovery.js'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

function makeExec(name = 'pwsh', args: unknown = { description: 'test' }): ToolExecution {
  return {
    callId: 'call_1' as never,
    rootCallId: 'call_1' as never,
    name,
    arguments: args,
    token: Symbol() as never,
    signal: new AbortController().signal,
    agent: { id: 'agent-1' } as unknown as Agent,
  }
}

const invalidResult: ToolExecutionResult = {
  isError: true,
  error: {
    message: 'invalid arguments: missing required property "command"',
    info: { code: 'INVALID_ARGS', name: 'pwsh' },
  },
  content: [],
}

describe('extractMissingFields', () => {
  it('extracts missing required property from error message', () => {
    expect(extractMissingFields(invalidResult)).toEqual(['command'])
  })

  it('extracts multiple missing fields', () => {
    const multi: ToolExecutionResult = {
      isError: true,
      error: {
        message: 'invalid arguments: missing required property "a"; missing required property "b"',
        info: { code: 'INVALID_ARGS', name: 't' },
      },
      content: [],
    }
    expect(extractMissingFields(multi)).toEqual(['a', 'b'])
  })

  it('returns empty array when no missing field is parsed', () => {
    const other: ToolExecutionResult = {
      isError: true,
      error: { message: 'other error', info: { code: 'OTHER', name: 't' } },
      content: [],
    }
    expect(extractMissingFields(other)).toEqual([])
  })
})

describe('recoveryKey', () => {
  it('keys on tool name and sorted missing fields', () => {
    const a = recoveryKey(makeExec(), invalidResult)
    const b = recoveryKey(makeExec(), invalidResult)
    expect(a).toBe(b)
    expect(a).toContain('pwsh')
    expect(a).toContain('command')
  })

  it('differs when the missing field differs', () => {
    const other: ToolExecutionResult = {
      isError: true,
      error: {
        message: 'invalid arguments: missing required property "description"',
        info: { code: 'INVALID_ARGS', name: 'pwsh' },
      },
      content: [],
    }
    expect(recoveryKey(makeExec(), invalidResult)).not.toBe(recoveryKey(makeExec(), other))
  })
})

describe('InvalidArgsEscalation', () => {
  it('advances the count for repeated identical failures', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec()
    expect(esc.advance(exec, invalidResult)).toBe(1)
    expect(esc.advance(exec, invalidResult)).toBe(2)
    expect(esc.advance(exec, invalidResult)).toBe(3)
  })

  it('returns 0 when there is no agent', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec()
    const noAgent = { ...exec, agent: undefined }
    // type cast: agent is optional at runtime
    const pruned = { ...exec } as ToolExecution
    pruned.agent = undefined
    expect(esc.advance(pruned, invalidResult)).toBe(0)
  })

  it('resets per-agent state', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec()
    esc.advance(exec, invalidResult)
    esc.advance(exec, invalidResult)
    if (exec.agent) esc.reset(exec.agent)
    expect(esc.advance(exec, invalidResult)).toBe(1)
  })

  it('resets a specific key on success', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec()
    esc.advance(exec, invalidResult)
    esc.resetKey(exec, invalidResult)
    expect(esc.advance(exec, invalidResult)).toBe(1)
  })
})

describe('buildInvalidArgsRetryNotice', () => {
  it('builds a count-1 corrective notice', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec(), invalidResult, 1)
    expect(notice.source.kind).toBe('plugin')
    expect(notice.source.plugin).toBe('dsh-gemini-compat')
    if (notice.source.kind === 'plugin') {
      expect(notice.source.form).toBe('notice')
      expect(notice.source.summary).toBe('Invalid pwsh arguments')
    }
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('rejected before execution')
    expect(text).toContain('command')
    expect(text).toContain('Do not repeat the previous argument object')
  })

  it('builds a stronger count-2 notice', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec(), invalidResult, 2)
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('2 times')
    expect(text).toContain('Stop retrying the previous argument pattern')
    expect(text).toContain('inspect the currently provided')
  })

  it('escalates to stop-repeating at count 3', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec(), invalidResult, 3)
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('Do not call')
    expect(text).toContain('Choose another tool')
    expect(text).toContain('Required: command')
  })
})

describe('formatConciseResult', () => {
  it('keeps the tool result concise', () => {
    const text = formatConciseResult('pwsh', invalidResult)
    expect(text).toContain('Tool call rejected before execution.')
    expect(text).toContain('Error: invalid arguments: missing required property "command"')
    expect(text).toContain('The tool did not execute.')
    // The long corrective prose belongs to the notice, not the result
    expect(text).not.toContain('Re-check this tool')
  })
})