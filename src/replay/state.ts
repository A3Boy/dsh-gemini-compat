export type SupportedProtocol = 'openai-chat';

export interface GeminiCompatReplayState {
  kind: 'dsh-gemini-compat';
  version: 1;
  protocol: SupportedProtocol;
  codecType: 'google-standard' | 'extra-content' | 'openrouter-reasoning' | 'passthrough';
  responseId?: string;
  thoughtSignatures?: Record<string, string>; // tool_call_id -> signature string
  reasoningDetails?: unknown[];
}

export function createEmptyReplayState(
  codecType: 'google-standard' | 'extra-content' | 'openrouter-reasoning' | 'passthrough' = 'google-standard'
): GeminiCompatReplayState {
  return {
    kind: 'dsh-gemini-compat',
    version: 1,
    protocol: 'openai-chat',
    codecType,
    thoughtSignatures: {},
  };
}

export function isGeminiCompatReplayState(obj: unknown): obj is GeminiCompatReplayState {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as any).kind === 'dsh-gemini-compat' &&
    (obj as any).version === 1
  );
}
