import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export function isInvalidArgsResult(result: Readonly<ToolExecutionResult>): boolean {
  return (
    result.isError === true &&
    result.error !== undefined &&
    result.error.info?.code === 'INVALID_ARGS'
  )
}

export function formatInvalidArgsFeedback(
  result: Readonly<ToolExecutionResult>
): string {
  const parts: string[] = ['The tool execution failed because the provided arguments were invalid.']

  if (result.error?.message) {
    parts.push('Error: ' + result.error.message)
  }

  parts.push(
    'Please review the tool schema, ensure all required properties are provided with valid types, and try again.'
  )

  return parts.join('\n\n')
}

export async function handleInvalidArgsPostExecute(
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>
): Promise<PostToolDecision> {
  const decision = await next()

  if (!isInvalidArgsResult(result)) {
    return decision
  }

  // If the downstream decision is already a block or non-accept, honor it
  if (decision.kind !== 'accept') {
    return decision
  }

  // If the downstream decision has custom value assignment, do not overwrite
  if ('value' in decision && (decision as { value?: unknown }).value !== undefined) {
    return decision
  }

  const feedbackText = formatInvalidArgsFeedback(result)

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
