import { ToolSchema } from '../diagnostics/trace.js';
import { projectToolSchema, GeminiWireProfile } from '../schema/project.js';
import { GeminiCompatReplayState } from '../replay/state.js';

export interface OpenAiWireFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export function serializeToolsForWire(
  tools: ToolSchema[],
  profile: GeminiWireProfile
): OpenAiWireFunctionTool[] {
  return tools.map((tool) => {
    const projected = projectToolSchema(tool, profile);
    return {
      type: 'function',
      function: {
        name: projected.name,
        description: projected.description,
        parameters: projected.parameters,
      },
    };
  });
}

export function injectReplayStateIntoMessages(
  messages: Array<Record<string, unknown>>,
  replayState?: GeminiCompatReplayState
): Array<Record<string, unknown>> {
  if (!replayState || !replayState.thoughtSignatures || Object.keys(replayState.thoughtSignatures).length === 0) {
    return messages;
  }

  // 匹配历史助手消息中的 tool_calls，恢复 provider 级 thought signature
  return messages.map((msg) => {
    if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
      const updatedToolCalls = (msg as any).tool_calls.map((tc: any) => {
        const sig = replayState.thoughtSignatures?.[tc.id];
        if (sig) {
          return {
            ...tc,
            thought_signature: sig,
            extra_content: {
              google: {
                thought_signature: sig,
              },
            },
          };
        }
        return tc;
      });

      return {
        ...msg,
        tool_calls: updatedToolCalls,
      };
    }
    return msg;
  });
}
