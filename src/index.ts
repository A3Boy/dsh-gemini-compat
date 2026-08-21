import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

import { GeminiCompatAdapter } from './adapter/adapter.js'
import type { GeminiCompatConfig, WireProfile } from './config.js'
import { projectToolSchema } from './schema/project.js'
import { RouteSpecificReplayCodec } from './replay/codec.js'
import {
  isInvalidArgsResult,
  formatInvalidArgsFeedback,
} from './feedback/invalid-args.js'
import {
  InvalidArgsEscalation,
  buildInvalidArgsRetryNotice,
  formatConciseResult,
} from './feedback/recovery.js'

export { GeminiCompatAdapter } from './adapter/adapter.js'
export type { GeminiCompatConfig, WireProfile, ToolSchemaReinforcement } from './config.js'
export { projectToolSchema } from './schema/project.js'
export { RouteSpecificReplayCodec } from './replay/codec.js'
export { formatInvalidArgsFeedback, isInvalidArgsResult } from './feedback/invalid-args.js'
export {
  InvalidArgsEscalation,
  buildInvalidArgsRetryNotice,
  formatConciseResult,
  extractMissingFields,
  recoveryKey,
} from './feedback/recovery.js'
export { buildToolSchemaReinforcement, requiredFields } from './prompt/tool-schema-reinforcement.js'
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
  toolSchemaReinforcement: z.union(['off', 'auto', 'required-only']).default('auto'),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  enableDiagnostics: z.boolean().default(false),
})

function resolveConfig(input: GeminiCompatConfig): Required<GeminiCompatConfig> {
  return {
    apiKeyEnv: input.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: input.baseURL ?? DEFAULT_BASE_URL,
    defaultModel: input.defaultModel ?? 'gemini-2.0-flash',
    wireProfile: (input.wireProfile ?? 'google-openai') as WireProfile,
    toolSchemaReinforcement: input.toolSchemaReinforcement ?? 'auto',
    streamIdleTimeoutMs: input.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    enableDiagnostics: input.enableDiagnostics ?? false,
  }
}

/**
 * Build a deterministic message source for corrective notices is owned by the
 * recovery module (`buildInvalidArgsRetryNotice`); this file only wires the
 * post-execute and pre-step listeners.
 */

export function apply(ctx: Context, config: GeminiCompatConfig): void {
  const resolved = resolveConfig(config)
  const replayCodec = new RouteSpecificReplayCodec(resolved.wireProfile)
  const escalation = new InvalidArgsEscalation()

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
    toolSchemaReinforcement: resolved.toolSchemaReinforcement,
    streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
    resolveApiKey,
    replayCodec,
  })

  ctx.effect(() => {
    return ctx.llm.registerAdapter([PROVIDER], adapter)
  })

  // INVALID_ARGS recovery: concise tool result + one-shot corrective notice
  // riding additionalContexts (next model request sees it right before
  // generating), with per-agent escalation on repeated identical failures.
  ctx.effect(() => {
    return ctx.on(
      'tools/post-execute',
      async (exec: ToolExecution, result, next): Promise<PostToolDecision> => {
        const decision = await next()

        if (!isInvalidArgsResult(result)) {
          // A successful call resets the recovery chain for this failure key.
          escalation.resetKey(exec, result)
          return decision
        }

        // Preserve downstream decisions: never override a non-accept decision
        if (decision.kind !== 'accept') return decision
        if ('value' in decision && decision.value !== undefined) return decision

        const count = escalation.advance(exec, result)
        const reminder = buildInvalidArgsRetryNotice(exec, result, count)

        // Keep the tool result concise; the corrective detail lives in the
        // notice that the inbox delivers immediately before the next call.
        return {
          kind: 'accept',
          content: [{ type: 'text', text: formatConciseResult(exec.name, result) }],
          additionalContexts: [reminder, ...(decision.additionalContexts ?? [])],
        }
      },
    )
  })

  // A user interjection changes the context; repetition across it is not a
  // loop (same reset rule as the first-party repeat-tool-reminder guard).
  ctx.effect(() => {
    return ctx.on(
      'agent/pre-step',
      ({ agent, messages }: { agent: Agent; messages: readonly UserMessage[] }, next): Promise<PreStepDecision> => {
        if (messages.some((message) => message.source.kind === 'user')) {
          escalation.reset(agent)
        }
        return next()
      },
    )
  })
}