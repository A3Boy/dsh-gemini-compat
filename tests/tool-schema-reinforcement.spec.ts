import { describe, it, expect } from 'vitest'
import { buildToolSchemaReinforcement, requiredFields, MAX_REINFORCEMENT_CHARS, REINFORCEMENT_OMITTED_SUFFIX } from '../src/prompt/tool-schema-reinforcement.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

describe('buildToolSchemaReinforcement — pure function', () => {
  const pwshSchema: ToolSchema = {
    name: 'pwsh',
    description: 'Execute PowerShell command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['command', 'description'],
    },
  }

  const noRequiredSchema: ToolSchema = {
    name: 'glob',
    description: 'Find files',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
      },
    },
  }

  it('returns undefined for empty tools', () => {
    expect(buildToolSchemaReinforcement(undefined)).toBeUndefined()
    expect(buildToolSchemaReinforcement([])).toBeUndefined()
  })

  it('returns undefined when no tool has required fields', () => {
    expect(buildToolSchemaReinforcement([noRequiredSchema])).toBeUndefined()
  })

  it('lists required fields for a tool with required', () => {
    const result = buildToolSchemaReinforcement([pwshSchema])
    expect(result).toBeDefined()
    expect(result).toContain('pwsh: command, description')
    expect(result).toContain('Tool argument contract reminder')
    expect(result).toContain('Every property listed as required MUST be present')
  })

  it('preserves tool order from the input array', () => {
    const editSchema: ToolSchema = {
      name: 'edit',
      description: 'Edit file',
      parameters: {
        type: 'object',
        required: ['file_path', 'old_string', 'new_string'],
      },
    }
    const result = buildToolSchemaReinforcement([pwshSchema, editSchema])
    const pwshIdx = result!.indexOf('pwsh: command, description')
    const editIdx = result!.indexOf('edit: file_path, old_string, new_string')
    expect(pwshIdx).toBeGreaterThan(0)
    expect(editIdx).toBeGreaterThan(pwshIdx)
  })

  it('does not contain the full JSON Schema or <tool_call>', () => {
    const result = buildToolSchemaReinforcement([pwshSchema])
    expect(result).not.toContain('"type": "object"')
    expect(result).not.toContain('"properties"')
    expect(result).not.toContain('<tool_call>')
    expect(result).not.toContain('"type":"object"')
  })

  it('is byte-for-byte deterministic for the same input', () => {
    const a = buildToolSchemaReinforcement([pwshSchema])
    const b = buildToolSchemaReinforcement([pwshSchema])
    const c = buildToolSchemaReinforcement([pwshSchema])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('does not contain tool-specific prose (no pwsh special case)', () => {
    const result = buildToolSchemaReinforcement([pwshSchema])
    expect(result).not.toContain('command contains PowerShell')
    expect(result).not.toContain('is NOT the command')
    expect(result).not.toContain('CRITICAL')
  })

  it('respects the char cap by truncating whole lines', () => {
    // Create many tools to exceed the cap
    const manyTools: ToolSchema[] = []
    for (let i = 0; i < 200; i++) {
      manyTools.push({
        name: `tool_${i}`,
        description: '',
        parameters: { required: ['a', 'b', 'c'] },
      })
    }
    const result = buildToolSchemaReinforcement(manyTools)
    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(MAX_REINFORCEMENT_CHARS + REINFORCEMENT_OMITTED_SUFFIX.length + 1)
    expect(result).toContain(REINFORCEMENT_OMITTED_SUFFIX)
  })

  it('skips tools without required fields', () => {
    const result = buildToolSchemaReinforcement([pwshSchema, noRequiredSchema])
    expect(result).toContain('pwsh: command, description')
    expect(result).not.toContain('glob')
  })
})

describe('requiredFields', () => {
  it('extracts required array from parameters', () => {
    const schema: ToolSchema = {
      name: 't',
      description: '',
      parameters: { required: ['a', 'b'] },
    }
    expect(requiredFields(schema)).toEqual(['a', 'b'])
  })

  it('returns empty array when required is missing', () => {
    const schema: ToolSchema = {
      name: 't',
      description: '',
      parameters: { type: 'object' },
    }
    expect(requiredFields(schema)).toEqual([])
  })

  it('returns empty array when required is not an array', () => {
    const schema: ToolSchema = {
      name: 't',
      description: '',
      parameters: { required: 'command' },
    }
    expect(requiredFields(schema)).toEqual([])
  })
})