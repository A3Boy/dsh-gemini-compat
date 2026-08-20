import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'

import { GeminiCompatAdapter } from './adapter/adapter.js'
import type { GeminiCompatConfig, ResolvedGeminiCompatConfig } from './config.js'
import { projectToolSchema } from './schema/project.js'
import { RouteSpecificReplayCodec } from './replay/codec.js'
import { formatInvalidArgsFeedback } from './feedback/invalid-args.js'

export { GeminiCompatAdapter } from './adapter/adapter.js'
export type { GeminiCompatConfig, ResolvedGeminiCompatConfig } from './config.js'
export { projectToolSchema } from './schema/project.js'
export { RouteSpecificReplayCodec } from './replay/codec.js'
export { formatInvalidArgsFeedback } from './feedback/invalid-args.js'
export { DiagnosticsCollector } from './diagnostics/trace.js'

export const name = 'dsh-gemini-compat'
export const inject = ['llm', 'tools'] as const

const PROVIDER = 'gemini-router'
const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

export type Config = GeminiCompatConfig

export const PluginConfig = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  defaultModel: z.string().default('gemini-2.0-flash'),
  codecStrategy: z
    .union(['google-standard', 'extra-content', 'openrouter-reasoning', 'passthrough'])
    .default('google-standard'),
  enableDiagnostics: z.boolean().default(false),
})

function resolveConfig(input: GeminiCompatConfig): ResolvedGeminiCompatConfig {
  return {
    apiKeyEnv: input.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: input.baseURL ?? DEFAULT_BASE_URL,
    defaultModel: input.defaultModel ?? 'gemini-2.0-flash',
    codecStrategy: input.codecStrategy ?? 'google-standard',
    enableDiagnostics: input.enableDiagnostics ?? false,
  }
}

export function apply(ctx: Context, config: GeminiCompatConfig): void {
  const resolved = resolveConfig(config)
  const replayCodec = new RouteSpecificReplayCodec(resolved.codecStrategy)

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
    resolveApiKey,
    replayCodec,
  })

  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
    return registration
  })

  ctx.effect(() => {
    return ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (result.isError && result.error?.info?.code === 'INVALID_ARGS') {
        return {
          kind: 'block' as const,
          feedback: [
            {
              type: 'text' as const,
              text: formatInvalidArgsFeedback(exec.name, exec.arguments, result),
            },
          ],
        }
      }
      return decision
    })
  })
}