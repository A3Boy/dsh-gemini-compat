export type WireProfile = 'google-openai' | 'generic-openai'

export type ToolSchemaReinforcement = 'off' | 'auto' | 'required-only'

export interface GeminiCompatConfig {
  apiKeyEnv?: string
  baseURL?: string
  defaultModel?: string
  wireProfile?: WireProfile
  toolSchemaReinforcement?: ToolSchemaReinforcement
  streamIdleTimeoutMs?: number
  enableDiagnostics?: boolean
}

export interface ResolvedGeminiCompatConfig {
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly defaultModel: string
  readonly wireProfile: WireProfile
  readonly toolSchemaReinforcement: ToolSchemaReinforcement
  readonly streamIdleTimeoutMs: number
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