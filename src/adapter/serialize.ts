import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import { projectToolSchema } from '../schema/project.js'
import type { RouteSpecificReplayCodec } from '../replay/codec.js'

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface WireRequest {
  model: string
  messages: Record<string, unknown>[]
  stream: true
  stream_options: {
    include_usage: true
  }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

function flattenText(blocks: readonly Message['content'][0][]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function serializeAssistant(message: Message): Record<string, unknown> {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter((b) => b.type === 'tool-call')
    .map((b) => {
      if (b.type !== 'tool-call') return null
      return {
        id: String(b.id),
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: b.arguments,
        },
      }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)

  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

function serializeMessages(
  messages: readonly Message[],
  replayCodec: RouteSpecificReplayCodec,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: text blocks → user message, tool-result blocks → tool messages
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      if (result.type !== 'tool-result') continue
      const resultText = result.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: resultText || '(no output)',
      })
    }
  }

  // Inject replay state (thought signatures, etc.) into the wire messages
  const replayState = replayCodec.getPendingReplayState()
  if (replayState !== undefined) {
    return replayCodec.injectMetadata(wire, replayState)
  }
  return wire
}

function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => {
    const projected = projectToolSchema(tool, { target: 'openai-chat' })
    return {
      type: 'function' as const,
      function: {
        name: projected.name,
        description: projected.description,
        parameters: projected.parameters,
      },
    }
  })
}

export function serializeRequest(
  options: GenerateOptions,
  defaultModel: string,
  replayCodec: RouteSpecificReplayCodec,
): WireRequest {
  const messages: Record<string, unknown>[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages, replayCodec))

  const tools = serializeTools(options.tools)

  return {
    model: options.model || defaultModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}