import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * Extract the set of missing property names from an INVALID_ARGS error message.
 * The standard DSH error format is: `invalid arguments: missing required property "command"`
 * which matches `missing required property "([^"]+)"`.
 */
export function extractMissingFields(result: Readonly<ToolExecutionResult>): string[] {
  if (!result.isError || !result.error?.message) return []
  const matches = result.error.message.matchAll(
    /missing required property "([^"]+)"/g,
  )
  return [...matches].map((m) => m[1]!)
}

/** Generic key used when the failure is NOT a missing-required-property error. */
export const GENERIC_INVALID_ARGS_KEY = 'generic-invalid-args'

/**
 * Stable recovery key for one failure: tool name + sorted missing fields.
 * Non-missing-field failures collapse to a per-tool generic key — the
 * escalation state tracks "same tool, same failure" across retries.
 */
export function recoveryKey(exec: ToolExecution, result: Readonly<ToolExecutionResult>): string {
  const missing = extractMissingFields(result)
  if (missing.length === 0) {
    return JSON.stringify([exec.name, GENERIC_INVALID_ARGS_KEY])
  }
  return JSON.stringify([exec.name, ...missing.sort()])
}

/**
 * Per-agent INVALID_ARGS escalation tracker, aligned with the first-party
 * repeat-tool-reminder chain:
 *
 *   WeakMap<Agent, Chain>  where Chain = { key, count }
 *
 * - same key  -> count + 1
 * - new key   -> count = 1
 * - success   -> reset whole chain (any tool result that is not INVALID_ARGS)
 * - user msg  -> reset whole chain
 */
export class InvalidArgsEscalation {
  private readonly chains = new WeakMap<Agent, Chain>()
  readonly thresholds = [1, 2, 3]

  /**
   * Advance the consecutive-failure chain for one agent and return the count.
   * A different failure key starts a NEW chain at 1 — it is NOT accumulated
   * per historical key.
   */
  advance(exec: ToolExecution, result: Readonly<ToolExecutionResult>): number {
    if (!exec.agent) return 0
    const key = recoveryKey(exec, result)
    const previous = this.chains.get(exec.agent)
    const count = previous?.key === key ? previous.count + 1 : 1
    this.chains.set(exec.agent, { key, count })
    return count
  }

  /** Reset the whole chain for a given agent (success, or user interjection). */
  reset(agent: Agent): void {
    this.chains.delete(agent)
  }
}

interface Chain {
  key: string
  count: number
}

function missingFieldLabel(result: Readonly<ToolExecutionResult>): string | undefined {
  const missing = extractMissingFields(result)
  return missing.length > 0 ? missing[0]! : undefined
}

/**
 * Build a one-shot corrective notice for the next model request.
 * The text escalates with the consecutive-failure count.
 */
export function buildInvalidArgsRetryNotice(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  count: number,
): UserMessage {
  const toolName = exec.name
  const missingField = missingFieldLabel(result)

  // Concise summary for the notice header
  const summary = `Invalid ${toolName} arguments`

  let text: string
  if (missingField === undefined) {
    // Generic INVALID_ARGS (type mismatch, enum, nested schema, shape ...)
    if (count === 1) {
      text = `The previous \`${toolName}\` call was rejected by its JSON Schema:\n`
        + `- tool: ${toolName}\n`
        + `Do not repeat the same argument object.\n`
        + `Re-read the provided schema and rebuild the arguments, checking required fields,`
        + ` types, enum constraints, and object shape before retrying.`
    } else if (count === 2) {
      text = `The \`${toolName}\` argument object has been rejected ${count} times by its JSON Schema.\n\n`
        + `Stop retrying the previous argument pattern.\n\n`
        + `Before making another call:\n`
        + `1. re-read the currently provided \`${toolName}\` JSON Schema;\n`
        + `2. rebuild the argument object;\n`
        + `3. verify required fields, types, enums, and shape.`
    } else {
      text = `Do not call \`${toolName}\` again until you can provide an argument object` 
        + ` that satisfies its JSON Schema.\n`
        + `Choose another tool or gather the missing value first if necessary.\n`
        + `Inspect the provided JSON Schema for the complete required argument set.`
    }
  } else if (count === 1) {
    text = `The previous tool call was rejected before execution:\n`
      + `- tool: ${toolName}\n`
      + `- missing: ${missingField}\n`
      + `Before retrying, rebuild the argument object from the provided JSON Schema.`
      + ` Every required property must be present with the schema-defined name and type.`
      + ` Do not repeat the previous argument object.`
  } else if (count === 2) {
    text = `You have now submitted \`${toolName}\` ${count} times without the required \`${missingField}\` argument.\n\n`
      + `Stop retrying the previous argument pattern.\n\n`
      + `Before making another tool call:\n`
      + `1. inspect the currently provided \`${toolName}\` JSON Schema;\n`
      + `2. construct a fresh argument object;\n`
      + `3. verify every required property is present.`
  } else {
    text = `Do not call \`${toolName}\` again until you can provide every required argument.\n`
      + `Choose another tool or gather the missing value first if necessary.\n`
      + `Still missing: ${missingField}.\n`
      + `Inspect the provided JSON Schema for the complete required argument set.`
  }

  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-gemini-compat',
      form: 'notice',
      summary,
    },
  })
}

/**
 * Concise tool-result content for the INVALID_ARGS case.
 */
export function formatConciseResult(
  toolName: string,
  result: Readonly<ToolExecutionResult>,
): string {
  const msg = result.isError
    ? result.error.message || 'Arguments did not adhere to required JSON schema'
    : 'Arguments did not adhere to required JSON schema'
  return [
    'Tool call rejected before execution.',
    `Error: ${msg}`,
    'The tool did not execute.',
  ].join('\n')
}