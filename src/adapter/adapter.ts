import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  isContextWindowExceededError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'

import { serializeRequest } from './serialize.js'
import { translate } from './translate.js'
import type { RouteSpecificReplayCodec, WireProfile } from '../replay/codec.js'

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const STREAM_IDLE_TIMEOUT_CODE = 'GEMINI_COMPAT_STREAM_IDLE_TIMEOUT'

export interface GeminiCompatAdapterOptions {
  readonly baseURL: string
  readonly defaultModel: string
  readonly wireProfile: WireProfile
  readonly streamIdleTimeoutMs: number
  readonly resolveApiKey: () => Promise<string>
  readonly replayCodec: RouteSpecificReplayCodec
}

export class GeminiCompatAdapter extends LlmAdapter {
  constructor(private readonly opts: GeminiCompatAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Gemini (OpenAI-compat)' }
  }

  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = await this.opts.resolveApiKey()
    const model = options.model || this.opts.defaultModel

    const body = serializeRequest(options, model, this.opts.wireProfile, this.opts.replayCodec)
    const endpoint = `${this.opts.baseURL.replace(/\/+$/, '')}/chat/completions`
    const payload = JSON.stringify(body)

    const consumer = new AbortController()
    const watchdog = idleWatchdog(
      options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal]),
      this.opts.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    )

    const headers: Record<string, string> = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    let response: Response
    try {
      // Debug: write the tool schemas we're actually sending to a file
      if (body.tools !== undefined && body.tools.length > 0) {
        try {
          const { writeFileSync } = await import('node:fs')
          const toolDump = body.tools.map((t) => ({
            name: t.function.name,
            strict: (t.function as Record<string, unknown>)['strict'],
            required: (t.function.parameters as Record<string, unknown>)['required'],
            description: t.function.description.slice(0, 300),
          }))
          writeFileSync('D:/web/dsh-plugins/dsh-gemini-compat/debug-tool-schema.json', JSON.stringify(toolDump, null, 2) + '\n', 'utf8')
        } catch { /* ignore */ }
      }
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal: watchdog.signal,
      })
    } catch (error: unknown) {
      consumer.abort('request complete')
      checkTimeoutOrAbort(error, options.signal, watchdog.signal, this.opts.streamIdleTimeoutMs)
      throw new LlmError(
        `Gemini compat transport request to ${endpoint} failed`,
        'TRANSPORT',
        { cause: error as Error },
      )
    }

    if (!response.ok) {
      consumer.abort('request complete')
      const status = response.status
      let message = `Gemini compat HTTP ${status}`
      let providerError: { code?: string; type?: string; message?: string } | undefined
      try {
        const parsed = (await response.json()) as { error?: { code?: string; type?: string; message?: string } }
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        const text = await response.text().catch(() => '')
        if (text.length > 0) message = text.slice(0, 500)
      }

      let code: string
      if (status === 401 || status === 403) code = 'AUTH'
      else if (status === 429) code = 'RATE_LIMIT'
      else if (status >= 500) code = 'SERVER'
      else if (status === 400) {
        const detail = [providerError?.code, providerError?.type, providerError?.message]
          .filter(Boolean)
          .join(' ')
        if (isContextWindowExceededError(detail)) {
          code = CONTEXT_WINDOW_EXCEEDED_CODE
        } else {
          code = 'INVALID_REQUEST'
        }
      } else {
        code = `HTTP_${status}`
      }

      const retryAfter = response.headers.get('retry-after')
      const delay =
        retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined

      throw new LlmError(message, code, {
        status,
        ...(delay !== undefined && Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
      })
    }

    if (!response.body) {
      consumer.abort('request complete')
      throw new LlmError('Gemini compat response body is empty', 'EMPTY_RESPONSE')
    }

    // Stream body reads with idle watchdog
    try {
      const iterator = translate(response.body, this.opts.replayCodec, watchdog.signal)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted && iterator.return !== undefined) {
          await iterator.return()
        }
      }
    } catch (error: unknown) {
      checkTimeoutOrAbort(error, options.signal, watchdog.signal, this.opts.streamIdleTimeoutMs)
      throw error
    } finally {
      consumer.abort('stream complete')
    }
  }
}

function checkTimeoutOrAbort(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  watchdogSignal: AbortSignal,
  timeoutMs: number,
): void {
  const timeout = timeoutOf(watchdogSignal, STREAM_IDLE_TIMEOUT_CODE)
  if (timeout !== undefined) {
    throw new LlmError(
      `Gemini compat stream idle timeout after ${timeoutMs}ms`,
      'TIMEOUT',
      { cause: error as Error },
    )
  }
  if (callerSignal?.aborted) {
    throw new LlmError('Gemini compat request aborted by caller', 'ABORTED', { cause: error as Error })
  }
}