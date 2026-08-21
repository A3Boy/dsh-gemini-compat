import { describe, it, expect } from 'vitest'
import {
  InvalidArgsEscalation,
  buildInvalidArgsRetryNotice,
  formatConciseResult,
  extractMissingFields,
  recoveryKey,
  GENERIC_INVALID_ARGS_KEY,
} from '../src/feedback/recovery.js'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

function makeExec(name = 'pwsh', args: unknown = { description: 'test' }, agent?: Agent): ToolExecution {
  return {
    callId: 'call_1' as never,
    rootCallId: 'call_1' as never,
    name,
    arguments: args,
    token: Symbol() as never,
    signal: new AbortController().signal,
    agent: agent ?? ({ id: 'agent-1' } as unknown as Agent),
  }
}

function invalid(missing: string): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message: `invalid arguments: missing required property "${missing}"`,
      info: { code: 'INVALID_ARGS', name: 't' },
    },
    content: [],
  }
}

/** A REAL success result — non-INVALID_ARGS, no error. */
const successResult: ToolExecutionResult = {
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
}

/** A generic INVALID_ARGS that is NOT a missing-required-property error. */
const genericInvalid: ToolExecutionResult = {
  isError: true,
  error: {
    message: 'invalid arguments: expected string, got number',
    info: { code: 'INVALID_ARGS', name: 't' },
  },
  content: [],
}

describe('extractMissingFields', () => {
  it('extracts missing required property from error message', () => {
    expect(extractMissingFields(invalid('command'))).toEqual(['command'])
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

  it('returns empty array when no missing field is parsed (generic)', () => {
    expect(extractMissingFields(genericInvalid)).toEqual([])
  })
})

describe('recoveryKey', () => {
  it('keys on tool name and sorted missing fields', () => {
    expect(recoveryKey(makeExec(), invalid('command')))
      .toBe(JSON.stringify(['pwsh', 'command']))
  })

  it('collapses generic INVALID_ARGS to a per-tool generic key', () => {
    const generic = recoveryKey(makeExec('pwsh'), genericInvalid)
    expect(generic).toBe(JSON.stringify(['pwsh', GENERIC_INVALID_ARGS_KEY]))
    // A different generic failure on the same tool shares the key
    const generic2 = recoveryKey(makeExec('pwsh'), {
      isError: true,
      error: { message: 'invalid arguments: unexpected key', info: { code: 'INVALID_ARGS', name: 't' } },
      content: [],
    })
    expect(generic).toBe(generic2)
  })

  it('differs when the missing field differs', () => {
    expect(recoveryKey(makeExec(), invalid('command')))
      .not.toBe(recoveryKey(makeExec(), invalid('description')))
  })
})

describe('InvalidArgsEscalation — consecutive chain state machine', () => {
  it('T1: real success result resets the chain', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec('pwsh')

    expect(esc.advance(exec, invalid('command'))).toBe(1)
    expect(esc.advance(exec, invalid('command'))).toBe(2)

    // Success (a REAL non-error result) resets the whole chain
    esc.reset(exec.agent!)

    expect(esc.advance(exec, invalid('command'))).toBe(1)
  })

  it('T2: different-key breaks the consecutive chain', () => {
    const esc = new InvalidArgsEscalation()
    const agent = { id: 'agent-1' } as unknown as Agent
    const pwsh = makeExec('pwsh', { description: 'a' }, agent)
    const read = makeExec('read', { file_path: 'x' }, agent)

    expect(esc.advance(pwsh, invalid('command'))).toBe(1)
    expect(esc.advance(read, invalid('file_path'))).toBe(1) // different key -> new chain
    expect(esc.advance(pwsh, invalid('command'))).toBe(1)   // back to pwsh -> fresh, not 3
  })

  it('same key accumulates', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec('pwsh')
    expect(esc.advance(exec, invalid('command'))).toBe(1)
    expect(esc.advance(exec, invalid('command'))).toBe(2)
    expect(esc.advance(exec, invalid('command'))).toBe(3)
  })

  it('returns 0 when there is no agent', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec()
    exec.agent = undefined
    expect(esc.advance(exec, invalid('command'))).toBe(0)
  })

  it('resets per-agent state on user interjection', () => {
    const esc = new InvalidArgsEscalation()
    const exec = makeExec('pwsh')
    esc.advance(exec, invalid('command'))
    esc.advance(exec, invalid('command'))
    esc.reset(exec.agent!)
    expect(esc.advance(exec, invalid('command'))).toBe(1)
  })
})

describe('buildInvalidArgsRetryNotice', () => {
  it('builds a count-1 corrective notice', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec('pwsh'), invalid('command'), 1)
    expect(notice.source.kind).toBe('plugin')
    expect(notice.source.plugin).toBe('dsh-gemini-compat')
    if (notice.source.kind === 'plugin') {
      expect(notice.source.form).toBe('notice')
      expect(notice.source.summary).toBe('Invalid pwsh arguments')
    }
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('rejected before execution')
    expect(text).toContain('missing: command')
    expect(text).toContain('Do not repeat the previous argument object')
  })

  it('builds a stronger count-2 notice', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec('pwsh'), invalid('command'), 2)
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('2 times')
    expect(text).toContain('Stop retrying the previous argument pattern')
    expect(text).toContain('inspect the currently provided')
  })

  it('T6: count 3 does NOT claim a full required set', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec('pwsh'), invalid('command'), 3)
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('Do not call')
    expect(text).toContain('Still missing: command')
    expect(text).toContain('Inspect the provided JSON Schema for the complete required argument set')
    // Must NOT claim "Required: command" — command is only what is missing
    expect(text).not.toContain('Required: command')
  })

  it('T5: generic INVALID_ARGS does not produce empty required wording', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec('pwsh'), genericInvalid, 3)
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).not.toContain('Required: .')
    expect(text).not.toContain('Missing: a required field')
    expect(text).toContain('Do not call')
    expect(text).toContain('Inspect the provided JSON Schema for the complete required argument set')
  })

  it('generic count 1 mentions schema checking', () => {
    const notice = buildInvalidArgsRetryNotice(makeExec('pwsh'), genericInvalid, 1)
    const text = notice.content[0]!.type === 'text' ? notice.content[0]!.text : ''
    expect(text).toContain('Do not repeat the same argument object')
    expect(text).toContain('types, enum constraints, and object shape')
  })
})

describe('formatConciseResult', () => {
  it('keeps the tool result concise', () => {
    const text = formatConciseResult('pwsh', invalid('command'))
    expect(text).toContain('Tool call rejected before execution.')
    expect(text).toContain('Error: invalid arguments: missing required property "command"')
    expect(text).toContain('The tool did not execute.')
    // The long corrective prose belongs to the notice, not the result
    expect(text).not.toContain('Re-check this tool')
  })
})