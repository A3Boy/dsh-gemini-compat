import { GeminiProtocolError } from './errors.js';
import { GeminiCompatReplayState } from '../replay/state.js';

export interface StreamEvent {
  type: 'block-start' | 'tool-call-delta' | 'block-end' | 'finish';
  blockIndex?: number;
  toolCall?: {
    id: string;
    name: string;
    argumentsDelta?: string;
    arguments?: string;
  };
  finishReason?: string;
  replayState?: GeminiCompatReplayState;
}

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
 */
export class GeminiStreamProcessor {
  private inFlightCalls = new Map<number, InFlightToolCall>();
  private accumulatedReplayState: GeminiCompatReplayState;

  constructor(protocol: 'openai-chat' | 'gemini-native' = 'openai-chat') {
    this.accumulatedReplayState = {
      kind: 'dsh-gemini-compat',
      version: 1,
      protocol,
      thoughtSignatures: {},
    };
  }

  public processChunk(chunk: any): StreamEvent[] {
    const events: StreamEvent[] = [];
    const choice = chunk.choices?.[0];

    if (!choice) {
      return events;
    }

    // 捕获 reasoning details / thought signature
    if (choice.delta?.reasoning_details || choice.delta?.thought_signature) {
      const sig = choice.delta.thought_signature || JSON.stringify(choice.delta.reasoning_details);
      // 缓存在当前未绑定的待处理状态中
      this.accumulatedReplayState.reasoningDetails = choice.delta.reasoning_details;
    }

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
            blockIndex: index,
            toolCall: {
              id: inFlight.id,
              name: inFlight.name,
            },
          });
        }

        if (tc.function?.arguments) {
          inFlight.argumentsBuffer += tc.function.arguments;
          events.push({
            type: 'tool-call-delta',
            blockIndex: index,
            toolCall: {
              id: inFlight.id,
              name: inFlight.name,
              argumentsDelta: tc.function.arguments,
            },
          });
        }

        if (tc.thought_signature && inFlight.id) {
          inFlight.thoughtSignature = tc.thought_signature;
          this.accumulatedReplayState.thoughtSignatures![inFlight.id] = tc.thought_signature;
        }
      }
    }

    if (choice.finish_reason) {
      // 结束时执行 JSON Integrity 校验
      for (const [index, inFlight] of this.inFlightCalls.entries()) {
        const finalJsonStr = inFlight.argumentsBuffer.trim();

        if (finalJsonStr.length === 0) {
          throw new GeminiProtocolError(
            `Tool call ${inFlight.name} (${inFlight.id}) finished with empty arguments buffer`,
            'MALFORMED_RESPONSE'
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(finalJsonStr);
        } catch (err) {
          throw new GeminiProtocolError(
            `Streamed tool-call arguments failed JSON integrity check for ${inFlight.name}: "${finalJsonStr}"`,
            'MALFORMED_RESPONSE'
          );
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new GeminiProtocolError(
            `Tool call arguments root must be an Object, received: ${typeof parsed}`,
            'INVALID_ARGUMENTS_JSON'
          );
        }

        events.push({
          type: 'block-end',
          blockIndex: index,
          toolCall: {
            id: inFlight.id,
            name: inFlight.name,
            arguments: finalJsonStr,
          },
        });
      }

      events.push({
        type: 'finish',
        finishReason: choice.finish_reason,
        replayState: this.accumulatedReplayState,
      });
    }

    return events;
  }
}
