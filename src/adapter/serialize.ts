import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { projectToolSchema } from '../schema/project.js'
import type { RouteSpecificReplayCodec, WireProfile } from '../replay/codec.js'

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
  stream_options: { include_usage: true }
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

function serializeAssistant(
  message: Message,
  wireProfile: WireProfile,
  codec: RouteSpecificReplayCodec,
): Record<string, unknown> {
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

  // Recover replay state from the assistant message's own source
  const raw = 'source' in message ? (message as any).source?.replayState : undefined
  let wireToolCalls = toolCalls

  if (raw !== undefined) {
    const envelope = codec.validateAndNormalize(raw)
    if (envelope !== undefined && envelope.blocks !== undefined) {
      const signatures = codec.extractBlockSignatures(envelope)
      let toolIndex = 0
      wireToolCalls = toolCalls.map((tc) => {
        const sig = signatures.get(toolIndex)
        toolIndex++
        if (sig === undefined) return tc
        if (wireProfile === 'google-openai') {
          return {
            ...tc,
            extra_content: {
              google: {
                thought_signature: sig,
              },
            },
          }
        }
        // generic-openai: inject top-level thought_signature
        return {
          ...tc,
          thought_signature: sig,
        }
      })
    }
  }

  return {
    role: 'assistant',
    content: text,
    ...(wireToolCalls.length > 0 ? { tool_calls: wireToolCalls } : {}),
  }
}

function serializeMessages(
  messages: readonly Message[],
  wireProfile: WireProfile,
  codec: RouteSpecificReplayCodec,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  // Build a map of callId -> function name from previous assistant messages
  const callIdToName = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      // Record tool call IDs for Google wire name field
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          callIdToName.set(String(block.id), block.name)
        }
      }
      wire.push(serializeAssistant(message, wireProfile, codec))
      continue
    }
    // user role
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
      const toolMsg: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: resultText || '(no output)',
      }
      // Google wire profile requires the function name on tool results
      if (wireProfile === 'google-openai') {
        const name = callIdToName.get(String(result.toolCallId))
        if (name) {
          toolMsg['name'] = name
        }
      }
      wire.push(toolMsg)
    }
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
  wireProfile: WireProfile,
  codec: RouteSpecificReplayCodec,
): WireRequest {
  // Batch D: reasoningEffort fail-loud when unsupported
  if (options.reasoningEffort !== undefined) {
    throw new LlmError(
      `Gemini compat adapter does not support reasoningEffort "${options.reasoningEffort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }

  const messages: Record<string, unknown>[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages, wireProfile, codec))

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