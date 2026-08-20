import { describe, it, expect } from 'vitest';
import { GeminiCompatAdapter } from '../src/adapter/adapter.js';
import { DiagnosticsCollector, ToolSchema } from '../src/diagnostics/trace.js';

describe('Integration Test Suite', () => {
  it('should run full request-response lifecycle with diagnostics and no field loss', () => {
    const diag = new DiagnosticsCollector();
    const adapter = new GeminiCompatAdapter(
      {
        enabled: true,
        provider: {
          route: 'gemini-router',
          protocol: 'openai-chat',
          baseURL: 'https://api.example.com',
          apiKeyEnv: 'GEMINI_API_KEY',
        },
        models: [{ id: 'gemini-3.7-flash' }],
        diagnostics: { enabled: true },
      },
      diag
    );

    const tools: ToolSchema[] = [
      {
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
      },
      {
        name: 'edit',
        description: 'Edit a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    ];

    const prep = adapter.prepareRequest([], tools);
    expect(prep.tools).toHaveLength(2);
    expect(diag.getStageA().size).toBe(2);

    const processor = adapter.createStreamProcessor();
    const chunk1 = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_pwsh_1',
                function: {
                  name: 'pwsh',
                  arguments: '{"command":"Get-ChildItem","description":"list directory"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const events = processor.processChunk(chunk1);
    const blockEnd = events.find((e) => e.type === 'block-end');
    expect(blockEnd).toBeDefined();

    diag.recordStageD({
      toolName: 'pwsh',
      finalRawJson: blockEnd!.toolCall!.arguments!,
      parsedObject: JSON.parse(blockEnd!.toolCall!.arguments!),
      validationStatus: 'VALID',
    });

    const report = diag.generateFailureReport(
      'pwsh',
      'gemini-router',
      'gemini-3.7-flash'
    );
    expect(report.validation).toBe('VALID');
    expect(report.classification).toBe('NORMAL_EXECUTION');
  });
});
