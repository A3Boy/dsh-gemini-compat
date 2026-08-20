export type WireProfile = 'google-openai' | 'generic-openai'

export interface GeminiCompatConfig {
  apiKeyEnv?: string
  baseURL?: string
  defaultModel?: string
  wireProfile?: WireProfile
  streamIdleTimeoutMs?: number
  enableDiagnostics?: boolean
}

export interface ResolvedGeminiCompatConfig {
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly defaultModel: string
  readonly wireProfile: WireProfile
  readonly streamIdleTimeoutMs: number
  readonly enableDiagnostics: boolean
}