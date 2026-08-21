export type WireProfile = 'google-openai' | 'generic-openai'

export type ToolSchemaReinforcement = 'off' | 'auto' | 'required-only'

/** Default Gemini 3.7 Flash context window: 1M tokens. */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576

/** Default Gemini 3.7 Flash max output tokens: 64K. */
export const DEFAULT_MAX_TOKENS = 65_536

export interface GeminiCompatConfig {
  apiKeyEnv?: string
  baseURL?: string
  defaultModel?: string
  wireProfile?: WireProfile
  toolSchemaReinforcement?: ToolSchemaReinforcement
  streamIdleTimeoutMs?: number
  /** Provider-advertised context window for this route, used by DSH compaction. */
  contextWindow?: number
  /** Per-request output cap when the caller omits one. */
  defaultMaxTokens?: number
  enableDiagnostics?: boolean
}

export interface ResolvedGeminiCompatConfig {
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly defaultModel: string
  readonly wireProfile: WireProfile
  readonly toolSchemaReinforcement: ToolSchemaReinforcement
  readonly streamIdleTimeoutMs: number
  readonly contextWindow: number
  readonly defaultMaxTokens: number
  readonly enableDiagnostics: boolean
}

export function resolveReinforcement(
  wireProfile: WireProfile,
  reinforcement: ToolSchemaReinforcement,
): ToolSchemaReinforcement {
  if (reinforcement === 'auto') {
    return wireProfile === 'google-openai' ? 'required-only' : 'off'
  }
  return reinforcement
}