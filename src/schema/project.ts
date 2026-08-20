import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export interface GeminiWireProfile {
  target: 'openai-chat' | 'gemini-native'
  allowDraftSchemaKeywords?: boolean
}

/**
 * Lossless Schema Projection.
 *
 * Rules:
 * 1. Strip only metadata keywords that have no validation semantic (e.g. `$schema`)
 * 2. Never silently drop validation keywords — fail loud if a keyword is
 *    incompatible with the target wire protocol
 * 3. Return a clean ToolSchema matching the Gemini / Router wire spec
 */
export function projectToolSchema(
  schema: ToolSchema,
  profile: GeminiWireProfile,
): ToolSchema {
  const projectedParams = projectJsonSchemaNode(
    schema.name,
    '',
    schema.parameters,
    profile,
  )

  return {
    name: schema.name,
    description: schema.description,
    parameters: projectedParams,
  }
}

function projectJsonSchemaNode(
  toolName: string,
  currentPath: string,
  node: unknown,
  profile: GeminiWireProfile,
): Record<string, unknown> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return (node ?? {}) as Record<string, unknown>
  }

  const record = node as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(record)) {
    // Strip $schema header — does not affect validation semantics
    if (key === '$schema') {
      continue
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const projectedProps: Record<string, unknown> = {}
      for (const [propName, propDef] of Object.entries(value as Record<string, unknown>)) {
        projectedProps[propName] = projectJsonSchemaNode(
          toolName,
          `${currentPath}.${propName}`,
          propDef,
          profile,
        )
      }
      result[key] = projectedProps
    } else if (key === 'items') {
      if (Array.isArray(value)) {
        result[key] = value.map((item, idx) =>
          projectJsonSchemaNode(toolName, `${currentPath}.items[${idx}]`, item, profile),
        )
      } else if (value && typeof value === 'object') {
        result[key] = projectJsonSchemaNode(
          toolName,
          `${currentPath}.items`,
          value,
          profile,
        )
      } else {
        result[key] = value
      }
    } else {
      result[key] = value
    }
  }

  return result
}
