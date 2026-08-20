import {
  serializeGeminiRequest,
  GeminiRequestSerializerOptions,
} from './serialize-request.js';
import { GeminiStreamProcessor, DshStreamChunk } from './parse-stream.js';
import { RouteSpecificReplayCodec, CodecStrategy } from '../replay/codec.js';
import { GeminiCompatReplayState, isGeminiCompatReplayState } from '../replay/state.js';
import { DiagnosticsCollector } from '../diagnostics/trace.js';
import { GeminiProtocolError } from './errors.js';
import { enhanceInvalidArgsPostExecute, ToolExecutionDetail, ToolResultLike } from '../feedback/invalid-args.js';

export interface GeminiAdapterConfig {
  baseURL: string;
  apiKey: string;
  defaultModel?: string;
  codecStrategy?: CodecStrategy;
  protocol?: 'openai-chat';
  enableDiagnostics?: boolean;
}

export interface DshGenerateOptions {
  model?: string;
  messages: any[];
  tools?: any[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  replayState?: unknown;
}

/**
 * 满足 DeepSeek Harness (DSH) LlmAdapter 规范的 Gemini 适配器。
 * 遵循官方 adding-an-llm-adapter 契约：
 * 1. 产生 AsyncIterable<DshStreamChunk>
 * 2. 保证 Usage 在 finish 之前
 * 3. 工具参数保持 raw JSON 传输，并在 finish 前进行完整性门控
 * 4. 支持并透传 AbortSignal
 * 5. 精确提取与重放 replayState
 */
export class GeminiCompatLlmAdapter {
  private replayCodec: RouteSpecificReplayCodec;
  private diagnostics?: DiagnosticsCollector;

  constructor(
    private readonly config: GeminiAdapterConfig,
    diagnostics?: DiagnosticsCollector
  ) {
    if (config.protocol && config.protocol !== 'openai-chat') {
      throw new GeminiProtocolError(
        `Unsupported protocol "${config.protocol}". V1 only supports "openai-chat".`,
        'UNSUPPORTED'
      );
    }
    this.replayCodec = new RouteSpecificReplayCodec(
      config.codecStrategy || 'google-standard',
      'openai-chat'
    );
    this.diagnostics = diagnostics;
  }

  async *stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    const model = options.model || this.config.defaultModel || 'Gemini/gemini-3.7-flash-high';
    
    // 1. 恢复 Replay State
    let replayState: GeminiCompatReplayState | undefined;
    if (isGeminiCompatReplayState(options.replayState)) {
      replayState = options.replayState;
    }

    // 2. 序列化请求体
    const requestPayload = serializeGeminiRequest(
      {
        model,
        messages: options.messages,
        tools: options.tools,
        system: options.system,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      },
      {
        targetProtocol: 'openai-chat',
        enableLosslessProjection: true,
        replayCodec: this.replayCodec,
      },
      replayState
    );

    // 记录诊断 Stage A & B
    if (this.diagnostics && options.tools) {
      for (const tool of options.tools) {
        this.diagnostics.recordStageA('gemini-router', model, tool);
        this.diagnostics.recordStageB('gemini-router', model, tool, tool.name);
      }
    }

    const endpoint = `${this.config.baseURL.replace(/\/+$/, '')}/chat/completions`;

    // 3. 执行 Transport I/O
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestPayload),
        signal: options.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw err;
      }
      throw new GeminiProtocolError(`Transport connection failed: ${err.message}`, 'MALFORMED_RESPONSE');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new GeminiProtocolError(
        `Upstream HTTP ${response.status}: ${errorText}`,
        'MALFORMED_RESPONSE'
      );
    }

    if (!response.body) {
      throw new GeminiProtocolError('Upstream response body is empty', 'MALFORMED_RESPONSE');
    }

    // 4. 解析 SSE 文本流并进行完整性门控处理
    const streamProcessor = new GeminiStreamProcessor(this.config.codecStrategy || 'google-standard');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (options.signal?.aborted) {
          await reader.cancel();
          throw new DOMException('Operation aborted', 'AbortError');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              const streamChunks = streamProcessor.processChunk(parsed);
              for (const chunk of streamChunks) {
                yield chunk;
              }
            } catch (e: any) {
              if (e instanceof GeminiProtocolError) {
                throw e;
              }
              // 忽略个别 malformed interim SSE chunks
            }
          }
        }
      }

      // 如果流结束而没有任何 finishChunk，说明流发生异常截断
      const inFlights = streamProcessor.getInFlightCalls();
      if (inFlights.size > 0 && !response.bodyUsed) {
        throw new GeminiProtocolError('SSE Stream ended prematurely without finish_reason', 'STREAM_TRUNCATION');
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * 官方标准 Cordis / DSH 插件入口
 */
export const name = 'dsh-gemini-compat';
export const inject = ['llm', 'tools'] as const;

export function apply(ctx: any, config: GeminiAdapterConfig) {
  const diagnostics = config.enableDiagnostics ? new DiagnosticsCollector() : undefined;
  const adapter = new GeminiCompatLlmAdapter(config, diagnostics);

  // 1. 注册专用的 LLM Provider Route (gemini-router)
  if (ctx.llm?.registerAdapter) {
    ctx.llm.registerAdapter(['gemini-router'], adapter);
  }

  // 2. 注册通用 tools/post-execute 钩子以强化 INVALID_ARGS 反馈
  if (ctx.tools?.on) {
    ctx.tools.on('tools/post-execute', async (exec: ToolExecutionDetail, result: ToolResultLike, next: () => Promise<void>) => {
      const decision = enhanceInvalidArgsPostExecute(exec, result);
      if (decision && decision.overrideContent) {
        result.content = decision.overrideContent;
      }
      return next();
    });
  }
}
