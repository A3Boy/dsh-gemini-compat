import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  CallId,
  LlmError,
  EMPTY_RESPONSE_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'

import type { RouteSpecificReplayCodec } from '../replay/codec.js'

const DONE = '[DONE]'

interface WireChunk {
  id?: string
  choices?: WireChoice[]
  usage?: WireUsage | null
}

interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

interface WireDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: WireToolCallDelta[]
}

interface WireToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
  thought_signature?: string
}

interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return {
      kind: 'error',
      failure: {
        message: `model stopped: ${reason}`,
        code: reason.toUpperCase(),
      },
    }
  }
}

function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
  thoughtSignature?: string
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId ?? ''),
        name: block.name ?? '',
        arguments: block.text,
      }
  }
}

/**
 * Consume an SSE byte stream and yield harness {@link StreamChunk}s.
 *
 * Block lifecycle: `block-start` → deltas → `block-end` with the assembled
 * {@link ContentBlock}. Finish reason and usage are deferred until `[DONE]`,
 * so trailing usage-only chunks are captured. Malformed JSON aborts with
 * `MALFORMED_RESPONSE`; missing EOF aborts with `STREAM_CLOSED`.
 */
export async function* translate(
  stream: ReadableStream<BufferSource>,
  signal: AbortSignal | undefined,
  replayCodec: RouteSpecificReplayCodec,
): AsyncGenerator<StreamChunk> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())

  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined
  let sawDone = false
  let responseId: string | undefined
  const thoughtSignatures: Record<string, string> = {}

  function openBlock(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  try {
    for await (const { data } of events) {
      if (signal?.aborted) {
        throw new LlmError('Gemini compat request aborted by caller', 'ABORTED')
      }

      if (data === DONE) {
        sawDone = true

        // Emit block-end for every opened block in first-seen order
        for (const block of order) {
          yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        }

        // JSON Integrity Gate: validate tool-call arguments are parseable JSON objects
        for (const block of toolBlocks.values()) {
          if (block.text.length === 0) continue
          try {
            const parsed: unknown = JSON.parse(block.text)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('top-level value must be a JSON object')
            }
          } catch (e) {
            throw new LlmError(
              `Malformed tool-call arguments for tool "${block.name ?? 'unknown'}": ${block.text.slice(0, 200)}`,
              'MALFORMED_RESPONSE',
              { cause: e as Error }
            )
          }
        }

        // Emit usage before finish (DSH contract: usage precedes finish)
        if (pendingUsage !== undefined) {
          yield { type: 'usage', usage: pendingUsage }
        }

        // Build finish reason
        const reason = pendingFinish ?? { kind: 'stop' as const }
        const isEmptyResponse = reason.kind === 'stop' && order.length === 0

        // Build replay envelope
        const replayEnvelope: ReplayEnvelope = {
          response: {
            kind: 'dsh-gemini-compat',
            version: 1,
            protocol: 'openai-chat',
            codecType: replayCodec.strategy,
            ...(responseId !== undefined ? { responseId } : {}),
            ...(Object.keys(thoughtSignatures).length > 0 ? { thoughtSignatures } : {}),
          },
          blocks: order.map((block) => {
            if (block.kind === 'tool-call' && block.thoughtSignature !== undefined) {
              return { thoughtSignature: block.thoughtSignature }
            }
            return undefined
          }),
        }

        replayCodec.setPendingReplayState(replayEnvelope)

        yield {
          type: 'finish',
          reason: isEmptyResponse
            ? {
                kind: 'error',
                failure: {
                  message: 'model returned a completed response with no content',
                  code: EMPTY_RESPONSE_CODE,
                },
              }
            : reason,
          replayState: replayEnvelope,
        }
        return
      }

      // Parse SSE data payload — malformed JSON must not be silently swallowed
      let chunk: WireChunk
      try {
        chunk = JSON.parse(data) as WireChunk
      } catch {
        throw new LlmError(
          `malformed SSE payload: ${data.slice(0, 120)}`,
          'MALFORMED_RESPONSE'
        )
      }

      // Capture response id
      if (chunk.id !== undefined && responseId === undefined) {
        responseId = chunk.id
      }

      // Process usage (deferred until [DONE])
      if (chunk.usage) {
        pendingUsage = mapUsage(chunk.usage)
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta

        // Reasoning content
        const reasoningText = delta?.reasoning_content ?? delta?.reasoning
        if (typeof reasoningText === 'string' && reasoningText.length > 0) {
          if (reasoningBlock === undefined) {
            reasoningBlock = openBlock('reasoning')
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
          }
          reasoningBlock.text += reasoningText
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoningText }
        }

        // Visible text content
        const content = delta?.content
        if (typeof content === 'string' && content.length > 0) {
          if (textBlock === undefined) {
            textBlock = openBlock('text')
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
          }
          textBlock.text += content
          yield { type: 'text-delta', index: textBlock.index, text: content }
        }

        // Tool calls
        for (const call of delta?.tool_calls ?? []) {
          let block = toolBlocks.get(call.index)
          if (block === undefined) {
            block = openBlock('tool-call')
            toolBlocks.set(call.index, block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          if (call.id !== undefined) block.callId = call.id
          if (call.function?.name !== undefined) block.name = call.function.name
          if (call.thought_signature !== undefined) {
            block.thoughtSignature = call.thought_signature
            if (block.callId !== undefined) {
              thoughtSignatures[block.callId] = call.thought_signature
            }
          }
          const fragment = call.function?.arguments ?? ''
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId ?? ''),
            ...(block.name !== undefined ? { name: block.name } : {}),
            argumentsDelta: fragment,
          }
        }

        // Defer finish reason — do not emit finish yet
        if (typeof choice.finish_reason === 'string') {
          pendingFinish = mapFinishReason(choice.finish_reason)
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    if (signal?.aborted) {
      throw new LlmError('Gemini compat request aborted by caller', 'ABORTED', { cause: error as Error })
    }
    throw new LlmError(
      'Gemini compat stream read failed',
      'TRANSPORT',
      { cause: error as Error }
    )
  }

  // EOF was truncated
  if (!sawDone) {
    throw new LlmError(
      'Gemini compat SSE stream ended without [DONE]',
      'STREAM_CLOSED'
    )
  }
}
