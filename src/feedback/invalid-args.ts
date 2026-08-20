export interface ToolExecutionDetail {
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface ToolResultLike {
  isError: boolean;
  content?: string;
  error?: {
    message?: string;
    info?: {
      code?: string;
      violations?: string[];
      [key: string]: unknown;
    };
  };
}

export interface PostToolDecision {
  overrideContent?: string;
}

/**
 * 通用 INVALID_ARGS Feedback Enhancer
 * 
 * 遵守架构规范：
 * 1. 绝不写 `if (exec.name === 'pwsh')` 等具体工具特判
 * 2. 仅在 code === "INVALID_ARGS" 时介入
 * 3. 明确向模型传达：工具未实际执行，请参考 schema 提供完整参数后重试
 * 4. 不引入自动重试状态机，让 DSH Agent Loop 自然驱动
 */
export function formatInvalidArgsFeedback(
  exec: ToolExecutionDetail,
  result: ToolResultLike
): string {
  const argsFormatted =
    typeof exec.arguments === 'string'
      ? exec.arguments
      : JSON.stringify(exec.arguments, null, 2);

  const violationMessage =
    result.error?.message ||
    (result.error?.info?.violations
      ? result.error.info.violations.join('; ')
      : 'Arguments did not adhere to required JSON schema');

  return [
    'Tool call rejected before execution.',
    `Tool: ${exec.name}`,
    '',
    'Provided arguments:',
    argsFormatted,
    '',
    'Validation error:',
    violationMessage,
    '',
    "The tool did not execute. Re-check this tool's provided schema and retry with a complete argument object. Do not invent parameter names.",
  ].join('\n');
}

export function enhanceInvalidArgsPostExecute(
  exec: ToolExecutionDetail,
  result: ToolResultLike
): PostToolDecision | null {
  if (
    result.isError &&
    (result.error?.info?.code === 'INVALID_ARGS' ||
      result.error?.message?.includes('invalid arguments') ||
      result.error?.message?.includes('missing required property'))
  ) {
    return {
      overrideContent: formatInvalidArgsFeedback(exec, result),
    };
  }

  return null;
}
