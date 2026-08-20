import type { ReplayEnvelope } from '@deepseek-ai/dsh-llm'

export type WireProfile = 'google-openai' | 'generic-openai'

export interface GeminiReplayResponse {
  kind: 'dsh-gemini-compat'
  version: 1
  wire: WireProfile
  responseId?: string
}

export type GeminiReplayBlock =
  | { type: 'text' }
  | { type: 'reasoning' }
  | { type: 'tool-call'; thoughtSignature?: string }

/**
 * Validates untrusted ReplayEnvelope data from durable history.
 * Returns true only if the envelope conforms to the Gemini compat contract.
 */
export function validateReplayEnvelope(raw: unknown): raw is ReplayEnvelope {
  if (typeof raw !== 'object' || raw === null) return false
  const env = raw as Record<string, unknown>
  if (typeof env.response !== 'object' || env.response === null) return false
  const resp = env.response as Record<string, unknown>
  if (resp.kind !== 'dsh-gemini-compat') return false
  if (resp.version !== 1) return false
  if (resp.wire !== 'google-openai' && resp.wire !== 'generic-openai') return false
  if (env.blocks !== undefined) {
    if (!Array.isArray(env.blocks)) return false
    for (const b of env.blocks) {
      if (typeof b !== 'object' || b === null) return false
      const block = b as Record<string, unknown>
      if (typeof block.type !== 'string') return false
      if (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'tool-call') return false
    }
  }
  return true
}

/**
 * Stateless replay codec for Gemini-compatible endpoints.
 * Operates purely on explicit inputs without carrying mutable session state.
 */
export class RouteSpecificReplayCodec {
  constructor(public readonly wireProfile: WireProfile = 'google-openai') {}

  /**
   * Accept untrusted replay state from durable history.
   * Returns a normalized ReplayEnvelope when valid, or undefined when the
   * state is foreign, stale, or malformed. Never throws.
   */
  validateAndNormalize(raw: unknown): ReplayEnvelope | undefined {
    try {
      if (validateReplayEnvelope(raw)) {
        return raw as ReplayEnvelope
      }
    } catch {
      // swallow — invalid replay state degrades gracefully
    }
    return undefined
  }

  /**
   * Extract thought signatures from validated block-aligned replay metadata.
   * Returns a sparse map of tool-call block index to thought signature.
   */
  extractBlockSignatures(envelope: ReplayEnvelope): Map<number, string> {
    const signatures = new Map<number, string>()
    if (!validateReplayEnvelope(envelope) || !envelope.blocks) return signatures

    let toolCallIndex = 0
    for (const rawBlock of envelope.blocks) {
      const b = rawBlock as GeminiReplayBlock
      if (b.type === 'tool-call') {
        if (b.thoughtSignature) {
          signatures.set(toolCallIndex, b.thoughtSignature)
        }
        toolCallIndex++
      }
    }
    return signatures
  }
}