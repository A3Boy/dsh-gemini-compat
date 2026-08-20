import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'

import { GeminiCompatAdapter } from './adapter/adapter.js'
import type { GeminiCompatConfig, WireProfile } from './config.js'
import { projectToolSchema } from './schema/project.js'
import { RouteSpecificReplayCodec } from './replay/codec.js'
import { formatInvalidArgsFeedback, isInvalidArgsResult } from './feedback/invalid-args.js'

export { GeminiCompatAdapter } from './adapter/adapter.js'
export type { GeminiCompatConfig, WireProfile } from './config.js'
export { projectToolSchema } from './schema/project.js'
export { RouteSpecificReplayCodec } from './replay/codec.js'
export { formatInvalidArgsFeedback, isInvalidArgsResult } from './feedback/invalid-args.js'
export { DiagnosticsCollector } from './diagnostics/trace.js'

export const name = 'dsh-gemini-compat'
export const inject = ['llm', 'tools'] as const

const PROVIDER = 'gemini-router'
const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export type Config = GeminiCompatConfig

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  defaultModel: z.string().default('gemini-2.0-flash'),
  wireProfile: z.union(['google-openai', 'generic-openai']).default('google-openai'),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  enableDiagnostics: z.boolean().default(false),
})

function resolveConfig(input: GeminiCompatConfig): Required<GeminiCompatConfig> {
  return {
    apiKeyEnv: input.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: input.baseURL ?? DEFAULT_BASE_URL,
    defaultModel: input.defaultModel ?? 'gemini-2.0-flash',
    wireProfile: (input.wireProfile ?? 'google-openai') as WireProfile,
    streamIdleTimeoutMs: input.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    enableDiagnostics: input.enableDiagnostics ?? false,
  }
}

export function apply(ctx: Context, config: GeminiCompatConfig): void {
  const resolved = resolveConfig(config)
  const replayCodec = new RouteSpecificReplayCodec(resolved.wireProfile)

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(resolved.apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return hit.value
    }
    const ambient = launchEnvironmentOf(ctx).get(resolved.apiKeyEnv)
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    throw new LlmError(
      `dsh-gemini-compat: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service, or export ${resolved.apiKeyEnv} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new GeminiCompatAdapter({
    baseURL: resolved.baseURL,
    defaultModel: resolved.defaultModel,
    wireProfile: resolved.wireProfile,
    streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
    resolveApiKey,
    replayCodec,
  })

  ctx.effect(() => {
    return ctx.llm.registerAdapter([PROVIDER], adapter)
  })

  ctx.effect(() => {
    return ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()

      if (!isInvalidArgsResult(result)) return decision

      // Preserve downstream decisions
      if (decision.kind !== 'accept') return decision
      if ('value' in decision && decision.value !== undefined) return decision

      const feedbackText = formatInvalidArgsFeedback(exec.name, exec.arguments, result)

      // Use `block` so the Agent Loop treats this as a rejected call
      // that needs retry, not a completed call with custom content.
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: feedbackText }],
        ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
      }
    })
  })
}