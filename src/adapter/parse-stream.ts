import { GeminiProtocolError } from './errors.js';
import { GeminiCompatReplayState } from '../replay/state.js';

export type DshStreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'thought-delta'; text: string }
  | { type: 'block-start'; index: number; block: { type: 'tool_call'; id: string; name: string } }
  | { type: 'tool-call-delta'; index: number; delta: string }
  | { type: 'block-end'; index: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: 'finish'; finishReason: string; replayState?: GeminiCompatReplayState };

export interface InFlightToolCall {
  id: string;
  name: string;
  argumentsBuffer: string;
  thoughtSignature?: string;
  index: number;
}

/**
 * 流式 Chunk 解析与 JSON 完整性门控 (Tool-Call JSON Integrity Gate)
 * 
 * 遵守架构规范：
 * 1. 严格检查 argumentsBuffer 是否闭合为合法 JSON Object
 * 2. 禁止把截断的半截 JSON (如 `{"command":"git`) 交付给上层
 * 3. 截断直接按 MALFORMED_RESPONSE 报错处理，不伪装成合法 Tool Call
 * 4. 产生符合 DSH 规范的 StreamChunk 事件
 */
export class GeminiStreamProcessor {
  private inFlightCalls = new Map<number, InFlightToolCall>();
  private accumulatedReplayState: GeminiCompatReplayState;
  private hasFinished = false;

  constructor(codecType: 'google-standard' | 'extra-content' | 'openrouter-reasoning' | 'passthrough' = 'google-standard') {
    this.accumulatedReplayState = {
      kind: 'dsh-gemini-compat',
      version: 1,
      protocol: 'openai-chat',
      codecType,
      thoughtSignatures: {},
    };
  }

  public processChunk(chunk: any): DshStreamChunk[] {
    if (this.hasFinished) {
      return [];
    }

    const events: DshStreamChunk[] = [];
    const choice = chunk.choices?.[0];

    // 处理 Usage 信息（必须在 finish 之前抛出）
    if (chunk.usage) {
      events.push({
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      });
    }

    if (!choice) {
      return events;
    }

    // 捕获 reasoning details / thought
    if (choice.delta?.reasoning_content || choice.delta?.reasoning) {
      const thoughtText = choice.delta.reasoning_content || choice.delta.reasoning;
      events.push({
        type: 'thought-delta',
        text: thoughtText,
      });
    }

    // 捕获普通正文
    if (choice.delta?.content) {
      events.push({
        type: 'text-delta',
        text: choice.delta.content,
      });
    }

    // 捕获 tool calls
    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const index = tc.index ?? 0;
        let inFlight = this.inFlightCalls.get(index);

        if (!inFlight) {
          inFlight = {
            id: tc.id || `call_${Date.now()}_${index}`,
            name: tc.function?.name || '',
            argumentsBuffer: '',
            thoughtSignature: tc.thought_signature,
            index,
          };
          this.inFlightCalls.set(index, inFlight);

          events.push({
            type: 'block-start',
            index,
            block: {
              type: 'tool_call',
              id: inFlight.id,
              name: inFlight.name,
            },
          });
        }

        if (tc.function?.arguments) {
          inFlight.argumentsBuffer += tc.function.arguments;
          events.push({
            type: 'tool-call-delta',
            index,
            delta: tc.function.arguments,
          });
        }

        if (tc.thought_signature && inFlight.id) {
          inFlight.thoughtSignature = tc.thought_signature;
          this.accumulatedReplayState.thoughtSignatures![inFlight.id] = tc.thought_signature;
        }
      }
    }

    // 捕获结束态 finish_reason
    if (choice.finish_reason) {
      // 遍历所有 in-flight tool calls 并执行 JSON Integrity 校验
      for (const [index, inFlight] of this.inFlightCalls.entries()) {
        try {
          const parsed = JSON.parse(inFlight.argumentsBuffer);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`Tool call arguments top-level value must be a JSON object, got ${typeof parsed}`);
          }
        } catch (e: any) {
          throw new GeminiProtocolError(
            `Malformed tool-call arguments stream detected for tool "${inFlight.name}". Received raw: ${JSON.stringify(
              inFlight.argumentsBuffer
            )}. Error: ${e.message}`,
            'MALFORMED_RESPONSE'
          );
        }

        events.push({
          type: 'block-end',
          index,
        });
      }

      events.push({
        type: 'finish',
        finishReason: choice.finish_reason,
        replayState: this.accumulatedReplayState,
      });

      this.hasFinished = true;
    }

    return events;
  }

  public getInFlightCalls(): Map<number, InFlightToolCall> {
    return this.inFlightCalls;
  }
}
