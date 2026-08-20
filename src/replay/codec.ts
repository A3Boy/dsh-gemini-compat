import { GeminiCompatReplayState, SupportedProtocol } from './state.js';
import { GeminiProtocolError } from '../adapter/errors.js';

export interface ReplayCodec {
  extractMetadata(response: any): GeminiCompatReplayState;
  injectMetadata(messages: any[], state: GeminiCompatReplayState): any[];
}

export type CodecStrategy = 'google-standard' | 'extra-content' | 'openrouter-reasoning' | 'passthrough';

/**
 * 严格按照特定 Route 配置的 Codec 实现元数据提取与注入。
 * 绝不同时喷洒（spray）多种字段到同一个请求。
 */
export class RouteSpecificReplayCodec implements ReplayCodec {
  constructor(
    private readonly strategy: CodecStrategy = 'google-standard',
    private readonly protocol: string = 'openai-chat'
  ) {
    if (protocol !== 'openai-chat') {
      throw new GeminiProtocolError(
        `Unsupported protocol "${protocol}". V1 only supports "openai-chat". Native Gemini protocol is reserved for future releases.`,
        'UNSUPPORTED'
      );
    }
  }

  extractMetadata(response: any): GeminiCompatReplayState {
    const state: GeminiCompatReplayState = {
      kind: 'dsh-gemini-compat',
      version: 1,
      protocol: 'openai-chat',
      codecType: this.strategy,
      responseId: response?.id,
      thoughtSignatures: {},
      reasoningDetails: [],
    };

    if (!response) return state;

    if (this.strategy === 'google-standard') {
      const choices = response.choices || [];
      for (const choice of choices) {
        const toolCalls = choice.message?.tool_calls || [];
        for (const tc of toolCalls) {
          if (tc.id && tc.thought_signature) {
            state.thoughtSignatures![tc.id] = tc.thought_signature;
          }
        }
      }
    } else if (this.strategy === 'extra-content') {
      const choices = response.choices || [];
      for (const choice of choices) {
        const extraGoogle = choice.message?.extra_content?.google;
        const toolCalls = choice.message?.tool_calls || [];
        for (const tc of toolCalls) {
          if (tc.id && extraGoogle?.thought_signature?.[tc.id]) {
            state.thoughtSignatures![tc.id] = extraGoogle.thought_signature[tc.id];
          }
        }
      }
    } else if (this.strategy === 'openrouter-reasoning') {
      const reasoning = response.choices?.[0]?.message?.reasoning_details;
      if (Array.isArray(reasoning)) {
        state.reasoningDetails = reasoning;
      }
    }

    return state;
  }

  injectMetadata(messages: any[], state: GeminiCompatReplayState): any[] {
    if (!state || !state.thoughtSignatures) return messages;

    return messages.map((msg) => {
      if (msg.role !== 'assistant') return msg;

      // 创建浅拷贝以防污染原始数据
      const cloned = { ...msg };

      if (cloned.tool_calls && Array.isArray(cloned.tool_calls)) {
        cloned.tool_calls = cloned.tool_calls.map((tc: any) => {
          const sig = state.thoughtSignatures?.[tc.id];
          if (!sig) return { ...tc };

          const updatedTc = { ...tc };

          // 仅按配置的单一策略进行精确注入
          if (this.strategy === 'google-standard') {
            updatedTc.thought_signature = sig;
          } else if (this.strategy === 'extra-content') {
            updatedTc.extra_content = {
              ...(updatedTc.extra_content || {}),
              google: {
                ...(updatedTc.extra_content?.google || {}),
                thought_signature: sig,
              },
            };
          }
          return updatedTc;
        });
      }

      if (this.strategy === 'openrouter-reasoning' && state.reasoningDetails && state.reasoningDetails.length > 0) {
        cloned.reasoning_details = state.reasoningDetails;
      }

      return cloned;
    });
  }
}
