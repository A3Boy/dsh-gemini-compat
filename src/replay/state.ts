export interface GeminiCompatReplayState {
  kind: 'dsh-gemini-compat';
  version: 1;
  protocol: 'openai-chat' | 'gemini-native';
  responseId?: string;
  thoughtSignatures?: Record<string, string>; // tool_call_id -> signature string
  reasoningDetails?: unknown[];
}

export function createEmptyReplayState(
  protocol: 'openai-chat' | 'gemini-native' = 'openai-chat'
): GeminiCompatReplayState {
  return {
    kind: 'dsh-gemini-compat',
    version: 1,
    protocol,
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
