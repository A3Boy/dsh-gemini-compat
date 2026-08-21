import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/**
 * Deterministic cap for the reinforcement text. When a large MCP tool set is
 * present the reminder must still stay compact; it is truncated at whole-line
 * boundaries only.
 */
export const MAX_REINFORCEMENT_CHARS = 4000

export const REINFORCEMENT_OMITTED_SUFFIX =
  'Additional tools omitted from this reminder; their JSON Schemas remain authoritative.'

/**
 * Collect the root-level `required` names of one tool, in schema order.
 * Tools without a required list contribute nothing.
 */
export function requiredFields(tool: ToolSchema): readonly string[] {
  const required = (tool.parameters as Record<string, unknown>)?.['required']
  if (!Array.isArray(required)) return []
  return required.filter((x): x is string => typeof x === 'string')
}

/**
 * Build a compact provider-side reminder listing only root required argument
 * names, preserving the original tool order. It never reprints the full JSON
 * Schema, never emits a second tool protocol, and never contains tool-specific
 * prose — semantics stay owned by the ToolSchema.
 *
 * Returns `undefined` when there is nothing to remind (no tools, or no tool
 * declares `required`).
 */
export function buildToolSchemaReinforcement(
  tools: readonly ToolSchema[] | undefined,
): string | undefined {
  if (tools === undefined || tools.length === 0) return undefined

  const lines: string[] = [
    'Tool argument contract reminder:',
    "Before emitting any tool call, check the tool's provided JSON Schema.",
    'Every property listed as required MUST be present with the correct type.',
    'Use parameter names exactly as defined by the schema.',
    'Do not emit a partial tool call with missing required arguments.',
    'If a required value is unknown, obtain it first or choose another appropriate action.',
    'After an INVALID_ARGS result, re-check the schema before retrying.',
    '',
    'Required arguments:',
  ]

  let emittedAny = false
  for (const tool of tools) {
    const req = requiredFields(tool)
    if (req.length === 0) continue
    lines.push(`- ${tool.name}: ${req.join(', ')}`)
    emittedAny = true
  }

  if (!emittedAny) return undefined

  // Whole-line deterministic cap
  let joined = lines.join('\n')
  if (joined.length > MAX_REINFORCEMENT_CHARS) {
    const kept: string[] = []
    let size = 0
    for (const line of lines) {
      const next = size === 0 ? line : '\n' + line
      if (size + next.length > MAX_REINFORCEMENT_CHARS) break
      kept.push(line)
      size += next.length
    }
    joined = [joined.slice(0, size), REINFORCEMENT_OMITTED_SUFFIX].join('\n')
  }

  return joined
}