import { GeminiCompatReplayState } from './state.js';

export interface ReplayCodec {
  encode(state: GeminiCompatReplayState): Record<string, unknown>;
  decode(raw: unknown): GeminiCompatReplayState;
}

export class JsonReplayCodec implements ReplayCodec {
  public encode(state: GeminiCompatReplayState): Record<string, unknown> {
    return {
      _dsh_gemini_replay: {
        v: 1,
        proto: state.protocol,
        resp_id: state.responseId,
        signatures: state.thoughtSignatures,
        details: state.reasoningDetails,
      },
    };
  }

  public decode(raw: unknown): GeminiCompatReplayState {
    if (!raw || typeof raw !== 'object') {
      return {
        kind: 'dsh-gemini-compat',
        version: 1,
        protocol: 'openai-chat',
      };
    }

    const container = (raw as any)._dsh_gemini_replay;
    if (!container || container.v !== 1) {
      return {
        kind: 'dsh-gemini-compat',
        version: 1,
        protocol: 'openai-chat',
      };
    }

    return {
      kind: 'dsh-gemini-compat',
      version: 1,
      protocol: container.proto ?? 'openai-chat',
      responseId: container.resp_id,
      thoughtSignatures: container.signatures ?? {},
      reasoningDetails: container.details,
    };
  }
}
