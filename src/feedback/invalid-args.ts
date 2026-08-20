import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export function isInvalidArgsResult(result: Readonly<ToolExecutionResult>): boolean {
  return (
    result.isError === true &&
    result.error !== undefined &&
    result.error.info?.code === 'INVALID_ARGS'
  )
}

/**
 * Format a highly actionable INVALID_ARGS feedback that tells the model:
 * 1. The tool call was rejected BEFORE execution (no side effects happened).
 * 2. Which tool it was.
 * 3. What arguments were actually provided (so the model can see the gap).
 * 4. The specific validation error.
 * 5. An explicit instruction to re-check the schema and retry completely.
 */
export function formatInvalidArgsFeedback(
  toolName: string,
  args: unknown,
  result: Readonly<ToolExecutionResult>,
): string {
  const argsFormatted =
    typeof args === 'string'
      ? args.trim()
      : JSON.stringify(args, null, 2) ?? String(args)

  const violationMessage = result.isError
    ? result.error.message || 'Arguments did not adhere to required JSON schema'
    : 'Arguments did not adhere to required JSON schema'

  return [
    'Tool call rejected before execution.',
    `Tool: ${toolName}`,
    '',
    'Provided arguments:',
    argsFormatted,
    '',
    'Validation error:',
    violationMessage,
    '',
    "The tool did NOT execute and no side effects occurred. Re-check this tool's declared schema: the required property is missing or has an invalid type. Retry with a COMPLETE argument object that satisfies every required property. Do not invent parameter names and do not omit required fields.",
  ].join('\n')
}

export async function handleInvalidArgsPostExecute(
  toolName: string,
  args: unknown,
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>,
): Promise<PostToolDecision> {
  const decision = await next()

  if (!isInvalidArgsResult(result)) {
    return decision
  }

  // Preserve downstream decisions: never override a non-accept decision
  if (decision.kind !== 'accept') {
    return decision
  }

  // Preserve downstream value-bearing decisions
  if ('value' in decision && decision.value !== undefined) {
    return decision
  }

  const feedbackText = formatInvalidArgsFeedback(toolName, args, result)

  return {
    kind: 'accept',
    content: [
      {
        type: 'text',
        text: feedbackText,
      },
    ],
    ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
  }
}