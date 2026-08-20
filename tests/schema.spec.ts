import { describe, it, expect } from 'vitest'
import { projectToolSchema } from '../src/schema/project.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

describe('Lossless Schema Projection', () => {
  it('should remove $schema without losing validation semantics', () => {
    const input: ToolSchema = {
      name: 'pwsh',
      description: 'Run powershell',
      parameters: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['command', 'description'],
      },
    }

    const projected = projectToolSchema(input, { target: 'openai-chat' })

    expect(projected.name).toBe('pwsh')
    expect(projected.parameters.$schema).toBeUndefined()
    expect(projected.parameters.properties!.command!.type).toBe('string')
    expect(projected.parameters.required).toEqual(['command', 'description'])
  })

  it('should recursively project nested schemas', () => {
    const input: ToolSchema = {
      name: 'workflow',
      description: 'Run workflow',
      parameters: {
        $schema: 'http://json-schema.org/schema#',
        type: 'object',
        properties: {
          meta: {
            $schema: 'http://json-schema.org/schema#',
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          },
        },
      },
    }

    const projected = projectToolSchema(input, { target: 'openai-chat' })
    expect(projected.parameters.$schema).toBeUndefined()
    expect(projected.parameters.properties!.meta!.$schema).toBeUndefined()
    expect(projected.parameters.properties!.meta!.properties!.name!.type).toBe('string')
  })

  it('should project array items', () => {
    const input: ToolSchema = {
      name: 'batch',
      description: 'Batch operation',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              $schema: 'http://json-schema.org/schema#',
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        },
      },
    }

    const projected = projectToolSchema(input, { target: 'openai-chat' })
    expect(projected.parameters.properties!.items!.items!.$schema).toBeUndefined()
    expect(projected.parameters.properties!.items!.items!.properties!.id!.type).toBe('string')
  })
})
