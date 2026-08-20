import { ToolSchema } from '../diagnostics/trace.js';

export interface GeminiWireProfile {
  target: 'openai-chat' | 'gemini-native';
  allowDraftSchemaKeywords?: boolean;
}

export class IncompatibleSchemaError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly path: string,
    public readonly reason: string
  ) {
    super(`Incompatible tool schema for tool "${toolName}" at ${path}: ${reason}`);
    this.name = 'IncompatibleSchemaError';
  }
}

/**
 * 无损 Schema 投影 (Lossless Schema Projection)
 * 
 * 规则：
 * 1. 仅移除对验证语义无损的元数据关键字（如 $schema）
 * 2. 严禁静默删除关键验证关键字（如 additionalProperties，若目标协议不支持直接报错 Fail Loud）
 * 3. 返回纯净且符合 Gemini / Router wire 规范的 ToolSchema
 */
export function projectToolSchema(
  schema: ToolSchema,
  profile: GeminiWireProfile
): ToolSchema {
  const projectedParams = projectJsonSchemaNode(
    schema.name,
    '',
    schema.parameters,
    profile
  );

  return {
    name: schema.name,
    description: schema.description,
    parameters: projectedParams,
  };
}

function projectJsonSchemaNode(
  toolName: string,
  currentPath: string,
  node: unknown,
  profile: GeminiWireProfile
): Record<string, unknown> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return (node ?? {}) as Record<string, unknown>;
  }

  const record = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    // 移除不影响具体类型约束的 $schema 标头
    if (key === '$schema') {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const projectedProps: Record<string, unknown> = {};
      for (const [propName, propDef] of Object.entries(value as Record<string, unknown>)) {
        projectedProps[propName] = projectJsonSchemaNode(
          toolName,
          `${currentPath}.${propName}`,
          propDef,
          profile
        );
      }
      result[key] = projectedProps;
    } else if (key === 'items') {
      if (Array.isArray(value)) {
        result[key] = value.map((item, idx) =>
          projectJsonSchemaNode(toolName, `${currentPath}.items[${idx}]`, item, profile)
        );
      } else if (value && typeof value === 'object') {
        result[key] = projectJsonSchemaNode(
          toolName,
          `${currentPath}.items`,
          value,
          profile
        );
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
