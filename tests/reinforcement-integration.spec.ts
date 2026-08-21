import { describe, it, expect } from 'vitest'
import { serializeRequest } from '../src/adapter/serialize.js'
import { RouteSpecificReplayCodec } from '../src/replay/codec.js'
import { resolveReinforcement } from '../src/config.js'
import type { ToolSchema, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

const pwshSchema: ToolSchema = {
  name: 'pwsh',
  description: 'Execute PowerShell command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['command', 'description'],
  },
}

function makeOptions(tools: readonly ToolSchema[], system?: string): GenerateOptions {
  const msg: Message = {
    id: 'm1' as never,
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }
  return {
    provider: 'gemini-router',
    model: 'gemini-3.6-flash',
    messages: [msg],
    ...(tools.length > 0 ? { tools } : {}),
    ...(system !== undefined ? { system } : {}),
  }
}

describe('Reinforcement integration at the provider boundary', () => {
  it('auto + google-openai injects the reminder into the merged system message', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const options = makeOptions([pwshSchema], 'You are a helpful assistant.')
    const wire = serializeRequest(
      options,
      'gemini-3.6-flash',
      'google-openai',
      codec,
      resolveReinforcement('google-openai', 'auto'),
    )

    // ONE merged system message
    const systemMsgs = wire.messages.filter((m) => m['role'] === 'system')
    expect(systemMsgs).toHaveLength(1)
    const systemContent = systemMsgs[0]!['content'] as string
    expect(systemContent).toContain('You are a helpful assistant.')
    expect(systemContent).toContain('Tool argument contract reminder')
    expect(systemContent).toContain('pwsh: command, description')
  })

  it('auto + generic-openai does NOT inject (off)', () => {
    const codec = new RouteSpecificReplayCodec('generic-openai')
    const options = makeOptions([pwshSchema], 'You are a helpful assistant.')
    const wire = serializeRequest(
      options,
      'gemini-3.6-flash',
      'generic-openai',
      codec,
      resolveReinforcement('generic-openai', 'auto'),
    )

    const systemMsgs = wire.messages.filter((m) => m['role'] === 'system')
    expect(systemMsgs).toHaveLength(1)
    const systemContent = systemMsgs[0]!['content'] as string
    expect(systemContent).toContain('You are a helpful assistant.')
    expect(systemContent).not.toContain('Tool argument contract reminder')
    expect(systemContent).not.toContain('pwsh: command, description')
  })

  it('off mode is byte-identical to current behavior (no reminder)', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const options = makeOptions([pwshSchema], 'You are a helpful assistant.')
    const wire = serializeRequest(
      options,
      'gemini-3.6-flash',
      'google-openai',
      codec,
      resolveReinforcement('google-openai', 'off'),
    )
    const systemMsgs = wire.messages.filter((m) => m['role'] === 'system')
    const content = systemMsgs[0]!['content'] as string
    expect(content).toBe('You are a helpful assistant.')
  })

  it('machine tools array is unchanged and still contains full schema', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const options = makeOptions([pwshSchema], 'You are helpful.')
    const wire = serializeRequest(
      options,
      'gemini-3.6-flash',
      'google-openai',
      codec,
      resolveReinforcement('google-openai', 'required-only'),
    )

    expect(wire.tools).toBeDefined()
    const tool = wire.tools![0]!
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('pwsh')
    expect(tool.function.description).toBe('Execute PowerShell command')
    expect(tool.function.parameters['required']).toEqual(['command', 'description'])
    // strict is always forced in this adapter
    expect(tool.function['strict']).toBe(true)
    // No description replacement / tool-specific patch
    expect(tool.function.description).not.toContain('CRITICAL')
    expect(tool.function.description).not.toContain('Parameter rules')
  })

  it('no tools -> no reminder, no system injection beyond original', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const options = makeOptions([], undefined)
    const wire = serializeRequest(
      options,
      'gemini-3.6-flash',
      'google-openai',
      codec,
      resolveReinforcement('google-openai', 'required-only'),
    )
    const systemMsgs = wire.messages.filter((m) => m['role'] === 'system')
    expect(systemMsgs).toHaveLength(0)
  })
})