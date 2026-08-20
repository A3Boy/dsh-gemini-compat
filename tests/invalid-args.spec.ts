import { describe, it, expect } from 'vitest';
import {
  formatInvalidArgsFeedback,
  enhanceInvalidArgsPostExecute,
} from '../src/feedback/invalid-args.js';

describe('INVALID_ARGS Feedback Enhancer', () => {
  it('should format clean, diagnostic feedback without tool-specific branching', () => {
    const feedback = formatInvalidArgsFeedback(
      {
        name: 'pwsh',
        arguments: { description: 'Git commit and push changes' },
      },
      {
        isError: true,
        error: {
          message: 'invalid arguments: missing required property "command"',
          info: { code: 'INVALID_ARGS' },
        },
      }
    );

    expect(feedback).toContain('Tool call rejected before execution.');
    expect(feedback).toContain('Tool: pwsh');
    expect(feedback).toContain('missing required property "command"');
    expect(feedback).toContain('The tool did not execute.');
  });

  it('should catch INVALID_ARGS code and return overrideContent decision', () => {
    const decision = enhanceInvalidArgsPostExecute(
      {
        name: 'database_query',
        arguments: { sql: 'SELECT * FROM users' },
      },
      {
        isError: true,
        error: {
          info: {
            code: 'INVALID_ARGS',
            violations: ['missing required property "connection_id"'],
          },
        },
      }
    );

    expect(decision).not.toBeNull();
    expect(decision?.overrideContent).toContain('Tool: database_query');
    expect(decision?.overrideContent).toContain('missing required property "connection_id"');
  });

  it('should return null for non-contract business errors', () => {
    const decision = enhanceInvalidArgsPostExecute(
      {
        name: 'pwsh',
        arguments: { command: 'Get-NonExistentCommand', description: 'Run command' },
      },
      {
        isError: true,
        error: {
          message: 'CommandNotFoundException',
          info: { code: 'COMMAND_FAILED' },
        },
      }
    );

    expect(decision).toBeNull();
  });
});
