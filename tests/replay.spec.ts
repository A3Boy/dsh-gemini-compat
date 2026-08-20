import { describe, it, expect } from 'vitest'
import { RouteSpecificReplayCodec } from '../src/replay/codec.js'
import type { ReplayEnvelope } from '@deepseek-ai/dsh-llm'

describe('RouteSpecificReplayCodec', () => {
  it('should inject thought_signature using google-standard strategy', () => {
    const codec = new RouteSpecificReplayCodec('google-standard')
    const envelope: ReplayEnvelope = {
      response: {
        kind: 'dsh-gemini-compat',
        version: 1,
        protocol: 'openai-chat',
        codecType: 'google-standard',
        thoughtSignatures: {
          call_1: 'sig_data_xyz',
        },
      },
    }

    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'pwsh',
              arguments: '{"command":"dir"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'success',
      },
    ]

    const injected = codec.injectMetadata(messages, envelope) as Record<string, unknown>[]
    const toolCall = (injected[0]!['tool_calls'] as Record<string, unknown>[])[0]!
    expect(toolCall['thought_signature']).toBe('sig_data_xyz')
    expect(toolCall['extra_content']).toBeUndefined()
  })

  it('should inject extra_content.google.thought_signature using extra-content strategy', () => {
    const codec = new RouteSpecificReplayCodec('extra-content')
    const envelope: ReplayEnvelope = {
      response: {
        kind: 'dsh-gemini-compat',
        version: 1,
        protocol: 'openai-chat',
        codecType: 'extra-content',
        thoughtSignatures: {
          call_1: 'sig_val_789',
        },
      },
    }

    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'pwsh',
              arguments: '{"command":"dir"}',
            },
          },
        ],
      },
    ]

    const injected = codec.injectMetadata(messages, envelope) as Record<string, unknown>[]
    const toolCall = (injected[0]!['tool_calls'] as Record<string, unknown>[])[0]!
    const extraContent = toolCall['extra_content'] as Record<string, unknown>
    const google = extraContent['google'] as Record<string, unknown>
    expect(google['thought_signature']).toBe('sig_val_789')
  })

  it('should NOT spray duplicate fields when using google-standard', () => {
    const codec = new RouteSpecificReplayCodec('google-standard')
    const envelope: ReplayEnvelope = {
      response: {
        kind: 'dsh-gemini-compat',
        version: 1,
        protocol: 'openai-chat',
        codecType: 'google-standard',
        thoughtSignatures: {
          call_1: 'sig_test',
        },
      },
    }

    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'pwsh', arguments: '{}' },
          },
        ],
      },
    ]

    const injected = codec.injectMetadata(messages, envelope) as Record<string, unknown>[]
    const toolCall = (injected[0]!['tool_calls'] as Record<string, unknown>[])[0]!
    expect(toolCall['thought_signature']).toBe('sig_test')
    expect(toolCall['extra_content']).toBeUndefined()
  })

  it('should not inject anything for passthrough strategy', () => {
    const codec = new RouteSpecificReplayCodec('passthrough')
    const envelope: ReplayEnvelope = {
      response: {
        kind: 'dsh-gemini-compat',
        version: 1,
        protocol: 'openai-chat',
        codecType: 'passthrough',
        thoughtSignatures: { call_1: 'sig' },
      },
    }

    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'pwsh', arguments: '{}' },
          },
        ],
      },
    ]

    const injected = codec.injectMetadata(messages, envelope) as Record<string, unknown>[]
    const toolCall = (injected[0]!['tool_calls'] as Record<string, unknown>[])[0]!
    expect(toolCall['thought_signature']).toBeUndefined()
    expect(toolCall['extra_content']).toBeUndefined()
  })

  it('should return undefined when no replay state is set', () => {
    const codec = new RouteSpecificReplayCodec('google-standard')
    expect(codec.getPendingReplayState()).toBeUndefined()
  })

  it('should set and get pending replay state', () => {
    const codec = new RouteSpecificReplayCodec('google-standard')
    const envelope: ReplayEnvelope = {
      response: { kind: 'dsh-gemini-compat', version: 1, protocol: 'openai-chat', codecType: 'google-standard' },
    }
    codec.setPendingReplayState(envelope)
    expect(codec.getPendingReplayState()).toBe(envelope)
  })

  it('should get per-block metadata by index', () => {
    const codec = new RouteSpecificReplayCodec('google-standard')
    const envelope: ReplayEnvelope = {
      response: { kind: 'dsh-gemini-compat', version: 1, protocol: 'openai-chat', codecType: 'google-standard' },
      blocks: [undefined, { thoughtSignature: 'sig_block_1' }],
    }
    expect(codec.getBlockMetadata(envelope, 0)).toBeUndefined()
    expect(codec.getBlockMetadata(envelope, 1)).toEqual({ thoughtSignature: 'sig_block_1' })
  })
})
