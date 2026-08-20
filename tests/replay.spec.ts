import { describe, it, expect } from 'vitest'
import { RouteSpecificReplayCodec, validateReplayEnvelope } from '../src/replay/codec.js'
import type { ReplayEnvelope } from '@deepseek-ai/dsh-llm'

describe('RouteSpecificReplayCodec (stateless)', () => {
  it('should validate a valid ReplayEnvelope', () => {
    const envelope: ReplayEnvelope = {
      response: {
        kind: 'dsh-gemini-compat',
        version: 1,
        wire: 'google-openai',
      },
      blocks: [
        { type: 'text' },
        { type: 'reasoning' },
        { type: 'tool-call', thoughtSignature: 'sig_abc' },
      ],
    }
    expect(validateReplayEnvelope(envelope)).toBe(true)
  })

  it('should reject foreign replay state', () => {
    const foreign = { response: { kind: 'other-adapter', version: 1, wire: 'google-openai' } }
    expect(validateReplayEnvelope(foreign)).toBe(false)
  })

  it('should reject stale version', () => {
    const stale = { response: { kind: 'dsh-gemini-compat', version: 0, wire: 'google-openai' } }
    expect(validateReplayEnvelope(stale)).toBe(false)
  })

  it('should reject unknown wire profile', () => {
    const unknown = {
      response: { kind: 'dsh-gemini-compat', version: 1, wire: 'openrouter-reasoning' },
    }
    expect(validateReplayEnvelope(unknown)).toBe(false)
  })

  it('should extract block signatures from envelope', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const envelope: ReplayEnvelope = {
      response: { kind: 'dsh-gemini-compat', version: 1, wire: 'google-openai' },
      blocks: [
        { type: 'text' },
        { type: 'tool-call', thoughtSignature: 'sig_0' },
        { type: 'tool-call' },
        { type: 'tool-call', thoughtSignature: 'sig_2' },
      ],
    }
    const sigs = codec.extractBlockSignatures(envelope)
    expect(sigs.get(0)).toBe('sig_0')
    expect(sigs.get(1)).toBeUndefined() // no signature on this block
    expect(sigs.get(2)).toBe('sig_2')
    expect(sigs.size).toBe(2)
  })

  it('should validateAndNormalize return envelope for valid input', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const envelope: ReplayEnvelope = {
      response: { kind: 'dsh-gemini-compat', version: 1, wire: 'google-openai' },
    }
    expect(codec.validateAndNormalize(envelope)).toBe(envelope)
  })

  it('should validateAndNormalize return undefined for invalid input', () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    expect(codec.validateAndNormalize('not an envelope')).toBeUndefined()
    expect(codec.validateAndNormalize({})).toBeUndefined()
    expect(codec.validateAndNormalize({ response: { kind: 'foreign' } })).toBeUndefined()
  })
})