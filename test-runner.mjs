import assert from 'node:assert';
import { projectToolSchema } from './src/schema/project.js';
import { GeminiStreamProcessor } from './src/adapter/parse-stream.js';
import { RouteSpecificReplayCodec } from './src/replay/codec.js';
import { enhanceInvalidArgsPostExecute } from './src/feedback/invalid-args.js';
import { DiagnosticsCollector } from './src/diagnostics/trace.js';

console.log('--- Starting dsh-gemini-compat self-tests ---');

// 1. Schema Projection Test
{
  const schema = {
    name: 'test_tool',
    description: 'desc',
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        pattern: { type: 'string' },
      },
      required: ['pattern'],
    },
  };
  const projected = projectToolSchema(schema, { wireFormat: 'openai-function' });
  assert.strictEqual(projected.parameters.$schema, undefined, 'Must strip $schema');
  assert.strictEqual(projected.name, 'test_tool');
  console.log('✔ Schema Projection test passed');
}

// 2. Stream Processor & JSON Integrity Gate
{
  const processor = new GeminiStreamProcessor('google-standard');

  processor.processChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: { name: 'pwsh', arguments: '{"command":"' },
            },
          ],
        },
      },
    ],
  });

  processor.processChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: 'dir","description":"list"}' },
            },
          ],
        },
      },
    ],
  });

  const finishEvents = processor.processChunk({
    choices: [
      {
        finish_reason: 'tool_calls',
      },
    ],
  });

  assert(finishEvents.some((e) => e.type === 'finish'), 'Must emit finish event');
  console.log('✔ Stream processor & integrity gate passed');
}

// 3. Replay Codec Isolation
{
  const codec = new RouteSpecificReplayCodec('google-standard', 'openai-chat');
  const messages = [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          function: { name: 'pwsh', arguments: '{}' },
        },
      ],
    },
  ];

  const state = {
    kind: 'dsh-gemini-compat',
    version: 1,
    protocol: 'openai-chat',
    thoughtSignatures: {
      call_1: 'test-signature',
    },
  };

  const injected = codec.injectMetadata(messages, state);
  assert.strictEqual(
    injected[0].tool_calls[0].thought_signature,
    'test-signature',
    'Must inject thought signature'
  );
  assert.strictEqual(
    injected[0].tool_calls[0].extra_content,
    undefined,
    'Must NOT spray duplicate extra_content'
  );
  console.log('✔ Replay Codec isolation passed');
}

// 4. INVALID_ARGS Feedback Enhancement
{
  const exec = {
    name: 'pwsh',
    arguments: { description: 'list files' },
  };
  const result = {
    isError: true,
    error: {
      info: {
        code: 'INVALID_ARGS',
      },
      message: 'missing required property "command"',
    },
    content: 'Error: invalid arguments: missing required property "command"',
  };

  const decision = enhanceInvalidArgsPostExecute(exec, result);
  assert(decision !== null, 'Decision must not be null');
  assert(decision.overrideContent.includes('Tool call rejected before execution.'));
  assert(decision.overrideContent.includes('missing required property "command"'));
  console.log('✔ INVALID_ARGS feedback enhancer passed');
}

// 5. Diagnostics & Classification
{
  const diag = new DiagnosticsCollector();
  diag.recordStageA('gemini-router', 'Gemini/gemini-3.7-flash-high', {
    name: 'pwsh',
    description: 'exec',
    parameters: { type: 'object', required: ['command'] },
  });

  const report = diag.generateFailureReport(
    'gemini-router',
    'Gemini/gemini-3.7-flash-high',
    'pwsh',
    '{"description":"list"}',
    { description: 'list' },
    'missing required property "command"'
  );

  assert.strictEqual(report.classification, 'MODEL_ARGUMENT_CONTRACT_VIOLATION');
  console.log('✔ Diagnostics & failure classification passed');
}

console.log('\nAll tests passed successfully!');
