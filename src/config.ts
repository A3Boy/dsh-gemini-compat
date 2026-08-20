import type { CodecStrategy } from './replay/codec.js'

export interface GeminiCompatConfig {
  /** Credential reference (environment-variable name) resolved per request; defaults to `GEMINI_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base URL; `/chat/completions` is appended. */
  baseURL?: string
  /** Default model id when `GenerateOptions.model` is not set by the caller. */
  defaultModel?: string
  /** Replay metadata extraction/injection strategy. */
  codecStrategy?: CodecStrategy
  /** Enable diagnostic tracing. */
  enableDiagnostics?: boolean
}

export interface ResolvedGeminiCompatConfig {
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly defaultModel: string
  readonly codecStrategy: CodecStrategy
  readonly enableDiagnostics: boolean
}
