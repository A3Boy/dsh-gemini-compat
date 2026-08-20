import { describe, it, expect } from 'vitest';
import { projectToolSchema } from '../src/schema/project.js';
import { ToolSchema } from '../src/diagnostics/trace.js';

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
    };

    const projected = projectToolSchema(input, { target: 'openai-chat' });

    expect(projected.name).toBe('pwsh');
    expect(projected.parameters.$schema).toBeUndefined();
    expect((projected.parameters.properties as any).command.type).toBe('string');
    expect(projected.parameters.required).toEqual(['command', 'description']);
  });

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
    };

    const projected = projectToolSchema(input, { target: 'openai-chat' });
    expect(projected.parameters.$schema).toBeUndefined();
    expect((projected.parameters.properties as any).meta.$schema).toBeUndefined();
    expect((projected.parameters.properties as any).meta.properties.name.type).toBe('string');
  });
});
