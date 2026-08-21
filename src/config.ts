export type WireProfile = 'google-openai' | 'generic-openai'

export type ToolSchemaReinforcement = 'off' | 'auto' | 'required-only'

export const DEFAULT_MODEL = 'gemini-3.7-flash'

/** Default Gemini 3.7 Flash context window: 1M tokens. */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576

/** Default Gemini 3.7 Flash max output tokens: 64K. */
export const DEFAULT_MAX_TOKENS = 65_536

export interface ModelCapacity {
  contextWindow?: number
  defaultMaxTokens?: number
}

/** Built-in capacity profiles for well-known exact Gemini model IDs. */
export const KNOWN_MODEL_CAPACITIES: Record<string, Required<ModelCapacity>> = {
  // Gemini 1.5 Pro: 2M context window, 8K max output
  'gemini-1.5-pro': { contextWindow: 2_097_152, defaultMaxTokens: 8_192 },
  'gemini-1.5-pro-latest': { contextWindow: 2_097_152, defaultMaxTokens: 8_192 },
  // Gemini 1.5 Flash: 1M context window, 8K max output
  'gemini-1.5-flash': { contextWindow: 1_048_576, defaultMaxTokens: 8_192 },
  'gemini-1.5-flash-latest': { contextWindow: 1_048_576, defaultMaxTokens: 8_192 },
  'gemini-1.5-flash-8b': { contextWindow: 1_048_576, defaultMaxTokens: 8_192 },
  // Gemini 2.0 Flash: 1M context window, 8K max output
  'gemini-2.0-flash': { contextWindow: 1_048_576, defaultMaxTokens: 8_192 },
  'gemini-2.0-flash-exp': { contextWindow: 1_048_576, defaultMaxTokens: 8_192 },
  // Gemini 2.5 Pro / Flash: 1M context window, 64K max output
  'gemini-2.5-pro': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-2.5-pro-preview-03-25': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-2.5-flash': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-2.5-flash-preview-05-20': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  // Gemini 3.7 Flash: 1M context window, 64K max output
  'gemini-3.7-flash': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-3.7-flash-latest': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-3.7-flash-thinking': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-3.7-flash-high': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-3.7-flash-medium': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
  'gemini-3.7-flash-low': { contextWindow: 1_048_576, defaultMaxTokens: 65_536 },
}

export function findKnownModelCapacity(model: string): ModelCapacity | undefined {
  return KNOWN_MODEL_CAPACITIES[model] ?? KNOWN_MODEL_CAPACITIES[model.toLowerCase()]
}

export function resolveModelCapacity(
  model: string,
  modelOverrides?: Record<string, ModelCapacity>,
  fallbackContextWindow = DEFAULT_CONTEXT_WINDOW,
  fallbackMaxTokens = DEFAULT_MAX_TOKENS,
): Required<ModelCapacity> {
  const custom = modelOverrides?.[model]
  const known = findKnownModelCapacity(model)
  return {
    contextWindow: custom?.contextWindow ?? known?.contextWindow ?? fallbackContextWindow,
    defaultMaxTokens: custom?.defaultMaxTokens ?? known?.defaultMaxTokens ?? fallbackMaxTokens,
  }
}

export interface GeminiCompatConfig {
  apiKeyEnv?: string
  baseURL?: string
  defaultModel?: string
  wireProfile?: WireProfile
  toolSchemaReinforcement?: ToolSchemaReinforcement
  streamIdleTimeoutMs?: number
  /** Fallback context window when model-specific capacity is not defined. */
  contextWindow?: number
  /** Fallback maximum output tokens when model-specific capacity is not defined. */
  defaultMaxTokens?: number
  /** Model-specific capacity overrides keyed by model name. */
  models?: Record<string, ModelCapacity>
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
  readonly models?: Record<string, ModelCapacity>
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