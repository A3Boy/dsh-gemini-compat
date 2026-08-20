import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * Format the INVALID_ARGS feedback text that tells the model the tool call was
 * rejected before execution and should retry with complete arguments.
 *
 * Never uses tool-specific branching — strictly relies on the structured
 * `error.info.code === 'INVALID_ARGS'` signal.
 */
export function formatInvalidArgsFeedback(
  toolName: string,
  args: unknown,
  result: Readonly<ToolExecutionResult>,
): string {
  const argsFormatted =
    typeof args === 'string'
      ? args
      : JSON.stringify(args, null, 2)

  const violationMessage =
    result.isError
      ? result.error.message
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
    "The tool did not execute. Re-check this tool's provided schema and retry with a complete argument object. Do not invent parameter names.",
  ].join('\n')
}