import { describe, it, expect } from 'vitest'
import { translate } from '../src/adapter/translate.js'
import { RouteSpecificReplayCodec } from '../src/replay/codec.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function makeStream(dataChunks: string[]): ReadableStream<BufferSource> {
  const encoder = new TextEncoder()
  const sseText = dataChunks.map((d) => `data: ${d}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText))
      controller.close()
    },
  })
}

async function collect(
  stream: ReadableStream<BufferSource>,
  codec: RouteSpecificReplayCodec,
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(stream, codec, signal)) {
    chunks.push(chunk)
  }
  return chunks
}

const DONE_MARKER = '[' + 'DONE' + ']'

describe('Stream Translator - Official StreamChunk Protocol', () => {
  it('should emit block lifecycle for tool-call across many deltas', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'pwsh', arguments: '{"description":"' },
            }],
          },
        }],
      }),
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'list files","command":"dir"}' },
            }],
          },
        }],
      }),
      DONE_MARKER,
    ]), codec)

    const blockStart = chunks.find((c) => c.type === 'block-start')
    expect(blockStart).toBeDefined()
    expect(blockStart!.type).toBe('block-start')
    if (blockStart!.type === 'block-start') {
      expect(blockStart!.blockType).toBe('tool-call')
    }

    const toolCallDeltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(toolCallDeltas).toHaveLength(2)

    const blockEnd = chunks.find((c) => c.type === 'block-end')
    expect(blockEnd).toBeDefined()
    if (blockEnd!.type === 'block-end') {
      expect(blockEnd!.block.type).toBe('tool-call')
      if (blockEnd!.block.type === 'tool-call') {
        expect(blockEnd!.block.id).toBe('call_1')
        expect(blockEnd!.block.name).toBe('pwsh')
        expect(blockEnd!.block.arguments).toBe('{"description":"list files","command":"dir"}')
      }
    }

    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
    if (finish!.type === 'finish') {
      expect(finish!.reason.kind).toBe('stop')
    }
  })

  it('should maintain DSH block index independent from provider tool_calls index', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{
          delta: {
            content: 'Hello',
            reasoning_content: 'thinking',
            tool_calls: [{
              index: 5,
              id: 'call_1',
              function: { name: 'pwsh', arguments: '{}' },
            }],
          },
        }],
      }),
      DONE_MARKER,
    ]), codec)

    const blockStarts = chunks.filter((c) => c.type === 'block-start')
    expect(blockStarts).toHaveLength(3)
    if (blockStarts[0]!.type === 'block-start') {
      expect(blockStarts[0]!.index).toBe(0)
      expect(blockStarts[0]!.blockType).toBe('reasoning')
    }
    if (blockStarts[1]!.type === 'block-start') {
      expect(blockStarts[1]!.index).toBe(1)
      expect(blockStarts[1]!.blockType).toBe('text')
    }
    if (blockStarts[2]!.type === 'block-start') {
      expect(blockStarts[2]!.index).toBe(2)
      expect(blockStarts[2]!.blockType).toBe('tool-call')
    }

    const blockEnds = chunks.filter((c) => c.type === 'block-end')
    expect(blockEnds).toHaveLength(3)
  })

  it('should defer finish until DONE and emit usage before finish', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{
          delta: { content: 'Hello world' },
          finish_reason: 'stop',
        }],
      }),
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      DONE_MARKER,
    ]), codec)

    const usageIdx = chunks.findIndex((c) => c.type === 'usage')
    const finishIdx = chunks.findIndex((c) => c.type === 'finish')
    expect(usageIdx).toBeGreaterThanOrEqual(0)
    expect(finishIdx).toBeGreaterThan(usageIdx)

    if (chunks[usageIdx]!.type === 'usage') {
      expect(chunks[usageIdx]!.usage.inputTokens).toBe(10)
      expect(chunks[usageIdx]!.usage.outputTokens).toBe(5)
    }
  })

  it('should throw on malformed SSE JSON', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    await expect(
      collect(makeStream(['not valid json{{{', DONE_MARKER]), codec),
    ).rejects.toThrow(/malformed SSE/)
  })

  it('should throw STREAM_CLOSED when DONE is never received', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    await expect(
      collect(makeStream([
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      ]), codec),
    ).rejects.toThrow(/without/)
  })

  it('should throw on truncated tool-call JSON arguments', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    await expect(
      collect(makeStream([
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                function: { name: 'pwsh', arguments: '{"command":"incomplete' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        DONE_MARKER,
      ]), codec),
    ).rejects.toThrow(/Malformed tool-call/)
  })

  it('should emit empty-response error for stop with no blocks', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{ finish_reason: 'stop' }],
      }),
      DONE_MARKER,
    ]), codec)

    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
    if (finish!.type === 'finish') {
      expect(finish!.reason.kind).toBe('error')
      if (finish!.reason.kind === 'error') {
        expect(finish!.reason.failure.code).toBe('EMPTY_RESPONSE')
      }
    }
  })

  it('should capture thought_signature in replay envelope', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'pwsh', arguments: '{}' },
              thought_signature: 'sig_abc',
            }],
          },
        }],
      }),
      DONE_MARKER,
    ]), codec)

    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
    if (finish!.type === 'finish') {
      expect(finish!.replayState).toBeDefined()
      expect(finish!.replayState!.blocks).toBeDefined()
      const blocks = finish!.replayState!.blocks as Record<string, unknown>[]
      const toolBlock = blocks.find((b) => b.type === 'tool-call')
      expect(toolBlock).toBeDefined()
      if (toolBlock) {
        expect(toolBlock['thoughtSignature']).toBe('sig_abc')
      }
    }
  })

  it('should emit nothing after finish', async () => {
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
      }),
      JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      DONE_MARKER,
    ]), codec)

    const finishIdx = chunks.findIndex((c) => c.type === 'finish')
    expect(finishIdx).toBe(chunks.length - 1)
  })

  it('should handle Gemini streaming tool_calls without index field', async () => {
    // Gemini's OpenAI-compatible endpoint may omit the `index` field
    // in streaming tool_calls deltas. This test verifies the adapter
    // still accumulates arguments correctly.
    const codec = new RouteSpecificReplayCodec('google-openai')
    const chunks = await collect(makeStream([
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              // No index field!
              id: 'call_1',
              function: { name: 'pwsh', arguments: '{"comm' },
            }],
          },
        }],
      }),
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              // No index field!
              function: { arguments: 'and":"Get-ChildItem"}' },
            }],
          },
        }],
      }),
      DONE_MARKER,
    ]), codec)

    const blockEnd = chunks.find((c) => c.type === 'block-end')
    expect(blockEnd).toBeDefined()
    if (blockEnd && blockEnd.type === 'block-end') {
      const block = blockEnd.block
      expect(block.type).toBe('tool-call')
      if (block.type === 'tool-call') {
        expect(block.name).toBe('pwsh')
        expect(block.arguments).toBe('{"command":"Get-ChildItem"}')
        expect(JSON.parse(block.arguments)).toEqual({ command: 'Get-ChildItem' })
      }
    }
  })
})
