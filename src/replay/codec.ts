import type { ReplayEnvelope } from '@deepseek-ai/dsh-llm'

export type CodecStrategy = 'google-standard' | 'extra-content' | 'openrouter-reasoning' | 'passthrough'

/**
 * Route-specific replay codec that extracts and injects provider metadata
 * (thought signatures, reasoning details) using exactly one strategy per route.
 * Never sprays multiple fields onto the same request.
 *
 * The envelope follows the official DSH {@link ReplayEnvelope} shape:
 * `response` holds response-level metadata; `blocks` holds per-block metadata
 * in first-seen stream order.
 */
export class RouteSpecificReplayCodec {
  private pendingReplayState: ReplayEnvelope | undefined

  constructor(
    readonly strategy: CodecStrategy = 'google-standard',
  ) {}

  /**
   * Store the replay envelope produced by the stream translator so the
   * serializer can inject it into the next request's messages.
   */
  setPendingReplayState(envelope: ReplayEnvelope): void {
    this.pendingReplayState = envelope
  }

  /**
   * Return the pending replay state and clear it (one-shot consumption).
   */
  getPendingReplayState(): ReplayEnvelope | undefined {
    return this.pendingReplayState
  }

  /**
   * Extract per-block metadata from the replay envelope for a given block index.
   */
  getBlockMetadata(envelope: ReplayEnvelope | undefined, blockIndex: number): unknown {
    if (envelope?.blocks === undefined) return undefined
    return envelope.blocks[blockIndex]
  }

  /**
   * Inject replay metadata into wire messages for the next request.
   * Only applies the configured single strategy — never sprays multiple fields.
   */
  injectMetadata(
    messages: readonly Record<string, unknown>[],
    envelope: ReplayEnvelope | undefined,
  ): Record<string, unknown>[] {
    if (envelope === undefined) return [...messages]

    const response = envelope.response as Record<string, unknown> | undefined
    if (response === undefined) return [...messages]

    const thoughtSignatures = response['thoughtSignatures'] as Record<string, string> | undefined
    const hasSignatures = thoughtSignatures !== undefined && Object.keys(thoughtSignatures).length > 0

    if (this.strategy === 'google-standard' && hasSignatures) {
      return messages.map((msg) => {
        if (msg['role'] !== 'assistant' || !Array.isArray(msg['tool_calls'])) return msg
        const cloned = { ...msg }
        cloned['tool_calls'] = (msg['tool_calls'] as Record<string, unknown>[]).map((tc) => {
          const id = tc['id'] as string | undefined
          if (id === undefined) return tc
          const sig = thoughtSignatures![id]
          if (sig === undefined) return tc
          return { ...tc, thought_signature: sig }
        })
        return cloned
      })
    }

    if (this.strategy === 'extra-content' && hasSignatures) {
      return messages.map((msg) => {
        if (msg['role'] !== 'assistant' || !Array.isArray(msg['tool_calls'])) return msg
        const cloned = { ...msg }
        cloned['tool_calls'] = (msg['tool_calls'] as Record<string, unknown>[]).map((tc) => {
          const id = tc['id'] as string | undefined
          if (id === undefined) return tc
          const sig = thoughtSignatures![id]
          if (sig === undefined) return tc
          return {
            ...tc,
            extra_content: {
              ...((tc['extra_content'] as Record<string, unknown> | undefined) ?? {}),
              google: { thought_signature: sig },
            },
          }
        })
        return cloned
      })
    }

    // openrouter-reasoning and passthrough: no thought_signature injection
    return [...messages]
  }
}
