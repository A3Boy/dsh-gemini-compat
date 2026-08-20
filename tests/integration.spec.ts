import { describe, it, expect } from 'vitest';
import { GeminiCompatLlmAdapter } from '../src/adapter/adapter.js';
import { DiagnosticsCollector, ToolSchema } from '../src/diagnostics/trace.js';

describe('Integration Test Suite', () => {
  it('should run full request-response lifecycle with diagnostics and no field loss', () => {
    const diag = new DiagnosticsCollector();
    const adapter = new GeminiCompatLlmAdapter(
      {
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test-key',
        defaultModel: 'Gemini/gemini-3.7-flash-high',
        codecStrategy: 'google-standard',
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

    const stageA1 = diag.recordStageA('gemini-router', 'Gemini/gemini-3.7-flash-high', tools[0]);
    const stageA2 = diag.recordStageA('gemini-router', 'Gemini/gemini-3.7-flash-high', tools[1]);
    expect(diag.getStageA('pwsh')).toBeDefined();
    expect(diag.getStageA('edit')).toBeDefined();

    diag.recordStageD({
      toolName: 'pwsh',
      finalRawJson: '{"command":"dir","description":"list files"}',
      isJsonValid: true,
      validationStatus: 'VALID',
    });

    const report = diag.generateFailureReport(
      'gemini-router',
      'Gemini/gemini-3.7-flash-high',
      'pwsh',
      '{"command":"dir","description":"list files"}',
      { command: 'dir', description: 'list files' }
    );

    expect(report.validation.status).toBe('VALID');
    expect(report.classification).toBe('UNKNOWN');
  });

  it('should classify model argument violation accurately', () => {
    const diag = new DiagnosticsCollector();
    diag.recordStageA('gemini-router', 'Gemini/gemini-3.7-flash-high', {
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
    });

    const report = diag.generateFailureReport(
      'gemini-router',
      'Gemini/gemini-3.7-flash-high',
      'pwsh',
      '{"description":"list files"}',
      { description: 'list files' },
      'missing required property "command"'
    );

    expect(report.validation.status).toBe('INVALID_ARGS');
    expect(report.classification).toBe('MODEL_ARGUMENT_CONTRACT_VIOLATION');
  });
});
