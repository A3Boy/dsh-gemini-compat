import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { serializeRequest } from './serialize.js'
import { translate } from './translate.js'
import type { RouteSpecificReplayCodec } from '../replay/codec.js'

export interface GeminiCompatAdapterOptions {
  readonly baseURL: string
  readonly defaultModel: string
  readonly resolveApiKey: () => Promise<string>
  readonly replayCodec: RouteSpecificReplayCodec
}

/**
 * Gemini compatibility adapter for OpenAI-compatible endpoints (Google AI,
 * OpenRouter, etc.). Extends the official {@link LlmAdapter} and emits the
 * harness {@link StreamChunk} protocol.
 */
export class GeminiCompatAdapter extends LlmAdapter {
  constructor(private readonly config: GeminiCompatAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: 'Gemini (OpenAI-compat)',
    }
  }

  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = await this.config.resolveApiKey()
    const model = options.model || this.config.defaultModel

    const body = serializeRequest(options, model, this.config.replayCodec)
    const endpoint = `${this.config.baseURL.replace(/\/+$/, '')}/chat/completions`

    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal: options.signal ?? null,
      })
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error
      throw new LlmError(
        `Gemini compat transport request to ${endpoint} failed`,
        'TRANSPORT',
        { cause: error as Error },
      )
    }

    if (!response.ok) {
      let message = `Gemini compat HTTP ${response.status}`
      let providerError: { code?: string; type?: string; message?: string } | undefined
      try {
        const parsed = (await response.json()) as { error?: { code?: string; type?: string; message?: string } }
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        const text = await response.text().catch(() => '')
        if (text.length > 0) message = text.slice(0, 500)
      }
      const status = response.status
      let code: string
      if (status === 401 || status === 403) code = 'AUTH'
      else if (status === 429) code = 'RATE_LIMIT'
      else if (status >= 500) code = 'SERVER'
      else if (status === 400) code = 'INVALID_REQUEST'
      else code = `HTTP_${status}`

      const retryAfter = response.headers.get('retry-after')
      const delay =
        retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined

      throw new LlmError(message, code, {
        status,
        ...(delay !== undefined && Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
      })
    }

    if (!response.body) {
      throw new LlmError('Gemini compat response body is empty', 'EMPTY_RESPONSE')
    }

    yield* translate(response.body, options.signal ?? undefined, this.config.replayCodec)
  }
}