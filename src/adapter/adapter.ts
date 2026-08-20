import { ToolSchema, DiagnosticsCollector } from '../diagnostics/trace.js';
import { GeminiWireProfile } from '../schema/project.js';
import { serializeToolsForWire, injectReplayStateIntoMessages } from './serialize-request.js';
import { GeminiStreamProcessor, StreamEvent } from './parse-stream.js';
import { GeminiCompatReplayState } from '../replay/state.js';

export interface GeminiCompatConfig {
  enabled: boolean;
  provider: {
    route: string;
    protocol: 'openai-chat' | 'gemini-native';
    baseURL: string;
    apiKeyEnv: string;
  };
  models: Array<{ id: string }>;
  replay?: {
    preserveProviderMetadata: boolean;
  };
  diagnostics?: {
    enabled: boolean;
  };
}

export class GeminiCompatAdapter {
  private diagnostics: DiagnosticsCollector;

  constructor(
    public readonly config: GeminiCompatConfig,
    diagnostics?: DiagnosticsCollector
  ) {
    this.diagnostics = diagnostics ?? new DiagnosticsCollector();
  }

  public prepareRequest(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[],
    replayState?: GeminiCompatReplayState
  ) {
    const profile: GeminiWireProfile = {
      target: this.config.provider.protocol,
    };

    if (this.config.diagnostics?.enabled) {
      for (const tool of tools) {
        this.diagnostics.recordStageA(tool);
      }
    }

    const wireTools = serializeToolsForWire(tools, profile);

    if (this.config.diagnostics?.enabled) {
      this.diagnostics.recordStageB(wireTools);
    }

    const preparedMessages = injectReplayStateIntoMessages(messages, replayState);

    return {
      messages: preparedMessages,
      tools: wireTools,
    };
  }

  public createStreamProcessor(): GeminiStreamProcessor {
    return new GeminiStreamProcessor(this.config.provider.protocol);
  }
}
