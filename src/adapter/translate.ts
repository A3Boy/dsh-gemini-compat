import { createParser } from 'eventsource-parser'
import type { EventSourceMessage } from 'eventsource-parser'
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

import type { RouteSpecificReplayCodec, GeminiReplayBlock } from '../replay/codec.js'

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
  index?: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
  thought_signature?: string
  extra_content?: {
    google?: {
      thought_signature?: string
    }
  }
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

interface InFlightBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
  thoughtSignature?: string
}

function closeBlock(block: InFlightBlock): ContentBlock {
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

function processEventData(
  data: string,
  state: ProcessingState,
  replayCodec: RouteSpecificReplayCodec,
  signal: AbortSignal | undefined,
): StreamChunk[] {
  if (signal?.aborted) {
    throw new LlmError('Gemini compat request aborted by caller', 'ABORTED')
  }

  if (data === DONE) {
    return handleDone(state, replayCodec)
  }

  let chunk: WireChunk
  try {
    chunk = JSON.parse(data) as WireChunk
  } catch {
    throw new LlmError(`malformed SSE payload: ${data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
  }

  const events: StreamChunk[] = []

  if (chunk.id !== undefined && state.responseId === undefined) {
    state.responseId = chunk.id
  }

  if (chunk.usage) {
    state.pendingUsage = mapUsage(chunk.usage)
  }

  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta

    const reasoningText = delta?.reasoning_content ?? delta?.reasoning
    if (typeof reasoningText === 'string' && reasoningText.length > 0) {
      if (state.reasoningBlock === undefined) {
        state.reasoningBlock = openBlock(state, 'reasoning')
        events.push({ type: 'block-start', index: state.reasoningBlock.index, blockType: 'reasoning' })
      }
      state.reasoningBlock.text += reasoningText
      events.push({ type: 'reasoning-delta', index: state.reasoningBlock.index, text: reasoningText })
    }

    const content = delta?.content
    if (typeof content === 'string' && content.length > 0) {
      if (state.textBlock === undefined) {
        state.textBlock = openBlock(state, 'text')
        events.push({ type: 'block-start', index: state.textBlock.index, blockType: 'text' })
      }
      state.textBlock.text += content
      events.push({ type: 'text-delta', index: state.textBlock.index, text: content })
    }

    for (const call of delta?.tool_calls ?? []) {
      // Gemini's OpenAI-compatible endpoint may OMIT the `index` field in
      // streaming tool_calls deltas. Fall back to 0, then to id, then to name
      // so we can still accumulate fragments into the correct block.
      const callKey: number =
        typeof call.index === 'number' ? call.index : 0

      let block = state.toolBlocks.get(callKey)
      if (block === undefined) {
        block = openBlock(state, 'tool-call')
        state.toolBlocks.set(callKey, block)
        events.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
      }
      if (call.id !== undefined) block.callId = call.id
      if (call.function?.name !== undefined) block.name = call.function.name

      const sig = call.extra_content?.google?.thought_signature ?? call.thought_signature
      if (sig !== undefined) {
        block.thoughtSignature = sig
      }

      const fragment = call.function?.arguments ?? ''
      block.text += fragment
      events.push({
        type: 'tool-call-delta',
        index: block.index,
        id: CallId(block.callId ?? ''),
        ...(block.name !== undefined ? { name: block.name } : {}),
        argumentsDelta: fragment,
      })
    }

    if (typeof choice.finish_reason === 'string') {
      state.pendingFinish = mapFinishReason(choice.finish_reason)
    }
  }

  return events
}

interface ProcessingState {
  nextIndex: number
  order: InFlightBlock[]
  textBlock: InFlightBlock | undefined
  reasoningBlock: InFlightBlock | undefined
  toolBlocks: Map<number, InFlightBlock>
  pendingFinish: FinishReason | undefined
  pendingUsage: TokenUsage | undefined
  responseId: string | undefined
  sawDone: boolean
}

function openBlock(state: ProcessingState, kind: 'text' | 'reasoning' | 'tool-call'): InFlightBlock {
  const block: InFlightBlock = { index: state.nextIndex++, kind, text: '' }
  state.order.push(block)
  return block
}

function handleDone(state: ProcessingState, replayCodec: RouteSpecificReplayCodec): StreamChunk[] {
  const events: StreamChunk[] = []
  state.sawDone = true

  // 1. JSON Integrity Gate: validate BEFORE block-end
  for (const block of state.toolBlocks.values()) {
    if (!block.callId || block.callId.trim().length === 0) {
      throw new LlmError('Provider returned tool call with missing or empty id', 'MALFORMED_RESPONSE')
    }
    if (!block.name || block.name.trim().length === 0) {
      throw new LlmError('Provider returned tool call with missing or empty function name', 'MALFORMED_RESPONSE')
    }
    if (!block.text || block.text.trim().length === 0) {
      throw new LlmError(`Empty arguments for tool "${block.name}": tool call must have arguments`, 'MALFORMED_RESPONSE')
    }
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('top-level value must be a JSON object')
      }
    } catch (e) {
      throw new LlmError(
        `Malformed tool-call arguments for tool "${block.name}": ${block.text.slice(0, 200)}`,
        'MALFORMED_RESPONSE',
        { cause: e as Error },
      )
    }
  }

  // 2. All checks passed -> emit block-end
  for (const block of state.order) {
    events.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
  }

  // 3. Usage before finish
  if (state.pendingUsage !== undefined) {
    events.push({ type: 'usage', usage: state.pendingUsage })
  }

  // 4. Finish
  const reason = state.pendingFinish ?? { kind: 'stop' as const }
  const isEmptyResponse = reason.kind === 'stop' && state.order.length === 0

  const replayBlocks: GeminiReplayBlock[] = state.order.map((block) => {
    if (block.kind === 'tool-call') {
      return {
        type: 'tool-call',
        ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
      }
    }
    if (block.kind === 'reasoning') {
      return { type: 'reasoning' }
    }
    return { type: 'text' }
  })

  const replayEnvelope: ReplayEnvelope = {
    response: {
      kind: 'dsh-gemini-compat',
      version: 1,
      wire: replayCodec.wireProfile,
      ...(state.responseId !== undefined ? { responseId: state.responseId } : {}),
    },
    blocks: replayBlocks,
  }

  events.push({
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
  })

  return events
}

export async function* translate(
  body: ReadableStream<BufferSource>,
  replayCodec: RouteSpecificReplayCodec,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const decoder = new TextDecoder()
  const reader = body.getReader()

  const state: ProcessingState = {
    nextIndex: 0,
    order: [],
    textBlock: undefined,
    reasoningBlock: undefined,
    toolBlocks: new Map(),
    pendingFinish: undefined,
    pendingUsage: undefined,
    responseId: undefined,
    sawDone: false,
  }

  let buffer = ''
  const collected: EventSourceMessage[] = []

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      collected.push(event)
    },
  })

  try {
    while (true) {
      if (signal?.aborted) {
        throw new LlmError('Gemini compat request aborted by caller', 'ABORTED')
      }

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      collected.length = 0
      parser.feed(buffer)
      buffer = ''
      // All onEvent calls happened synchronously during feed()
      for (const event of collected) {
        const chunks = processEventData(event.data, state, replayCodec, signal)
        for (const chunk of chunks) {
          yield chunk
        }
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      collected.length = 0
      parser.feed(buffer)
      buffer = ''
      for (const event of collected) {
        const chunks = processEventData(event.data, state, replayCodec, signal)
        for (const chunk of chunks) {
          yield chunk
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    if (signal?.aborted) {
      throw new LlmError('Gemini compat request aborted by caller', 'ABORTED', { cause: error as Error })
    }
    throw new LlmError('Gemini compat stream read failed', 'TRANSPORT', { cause: error as Error })
  }

  if (!state.sawDone) {
    throw new LlmError('Gemini compat SSE stream ended without [DONE]', 'STREAM_CLOSED')
  }
}