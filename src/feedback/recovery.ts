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

/**
 * Stable recovery key for one failure: tool name + sorted missing fields.
 * This lets the escalation state track "same tool, same missing field" across retries.
 */
export function recoveryKey(exec: ToolExecution, result: Readonly<ToolExecutionResult>): string {
  const missing = extractMissingFields(result).sort()
  return JSON.stringify([exec.name, ...missing])
}

/**
 * Per-agent INVALID_ARGS escalation tracker.
 * Mirrors the repeat-tool-reminder pattern: thresholds insert
 * increasingly strong corrective context into the next model request.
 */
export class InvalidArgsEscalation {
  private readonly chains = new WeakMap<Agent, Map<string, number>>()
  readonly thresholds = [1, 2, 3]

  /**
   * Advance the chain for one agent+key and return the escalation count.
   * Returns 0 when there is no agent (direct ctx.tools.execute() caller).
   */
  advance(exec: ToolExecution, result: Readonly<ToolExecutionResult>): number {
    if (!exec.agent) return 0
    const key = recoveryKey(exec, result)
    let agentMap = this.chains.get(exec.agent)
    if (agentMap === undefined) {
      agentMap = new Map()
      this.chains.set(exec.agent, agentMap)
    }
    const count = (agentMap.get(key) ?? 0) + 1
    agentMap.set(key, count)
    return count
  }

  /** Reset the chain for a given agent (e.g. on user interjection). */
  reset(agent: Agent): void {
    this.chains.delete(agent)
  }

  /** Reset for a specific tool+missing combination (e.g. on success). */
  resetKey(exec: ToolExecution, result: Readonly<ToolExecutionResult>): void {
    if (!exec.agent) return
    const agentMap = this.chains.get(exec.agent)
    if (agentMap === undefined) return
    agentMap.delete(recoveryKey(exec, result))
  }
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
  const missing = extractMissingFields(result)
  const missingField = missing.length > 0 ? missing[0]! : 'a required field'
  const toolName = exec.name

  // Concise summary for the notice header
  const summary = `Invalid ${toolName} arguments`

  let text: string
  if (count === 1) {
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
      + `Required: ${missing.join(', ')}.\n`
      + `Missing: ${missingField}.`
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