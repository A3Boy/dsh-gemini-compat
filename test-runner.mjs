import { projectToolSchema } from './src/schema/project.js';
import { GeminiStreamProcessor } from './src/adapter/parse-stream.js';
import { JsonReplayCodec } from './src/replay/codec.js';
import { injectReplayStateIntoMessages } from './src/adapter/serialize-request.js';
import { formatInvalidArgsFeedback, enhanceInvalidArgsPostExecute } from './src/feedback/invalid-args.js';
import { GeminiCompatAdapter } from './src/adapter/adapter.js';
import { DiagnosticsCollector } from './src/diagnostics/trace.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`[PASS] ${message}`);
  } else {
    failed++;
    console.error(`[FAIL] ${message}`);
  }
}

console.log('--- Running Schema Projection Tests ---');
const projected = projectToolSchema(
  {
    name: 'pwsh',
    description: 'Run powershell',
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command', 'description'],
    },
  },
  { target: 'openai-chat' }
);
assert(projected.name === 'pwsh', 'Tool name preserved');
assert(projected.parameters.$schema === undefined, '$schema stripped');
assert(projected.parameters.required.length === 2, 'Required fields preserved');

console.log('\n--- Running Stream & JSON Integrity Gate Tests ---');
const processor = new GeminiStreamProcessor('openai-chat');
const events1 = processor.processChunk({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_123',
            function: { name: 'pwsh', arguments: '{"description":"Test command"' },
          },
        ],
      },
    },
  ],
});
assert(events1.length === 2, 'Stream chunk processed 2 events');

const events2 = processor.processChunk({
  choices: [
    {
      delta: { tool_calls: [{ index: 0, function: { arguments: ',"command":"dir"}' } }] },
      finish_reason: 'tool_calls',
    },
  ],
});
const blockEnd = events2.find((e) => e.type === 'block-end');
assert(
  blockEnd?.toolCall?.arguments === '{"description":"Test command","command":"dir"}',
  'JSON arguments assembled accurately'
);

console.log('\n--- Running Replay Codec Tests ---');
const codec = new JsonReplayCodec();
const encoded = codec.encode({
  kind: 'dsh-gemini-compat',
  version: 1,
  protocol: 'openai-chat',
  responseId: 'resp_123',
  thoughtSignatures: { call_1: 'signature_abc' },
});
const decoded = codec.decode(encoded);
assert(decoded.thoughtSignatures.call_1 === 'signature_abc', 'Thought signature properly decoded');

const restored = injectReplayStateIntoMessages(
  [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'pwsh', arguments: '{}' },
        },
      ],
    },
  ],
  decoded
);
assert(restored[0].tool_calls[0].thought_signature === 'signature_abc', 'Replay signature injected correctly');

console.log('\n--- Running Feedback Enhancer Tests ---');
const feedback = formatInvalidArgsFeedback(
  { name: 'pwsh', arguments: { description: 'test' } },
  { isError: true, error: { message: 'missing required property "command"', info: { code: 'INVALID_ARGS' } } }
);
assert(feedback.includes('Tool: pwsh'), 'Feedback includes tool name');
assert(feedback.includes('missing required property "command"'), 'Feedback includes violation details');
assert(feedback.includes('The tool did not execute.'), 'Feedback asserts no side-effects');

console.log(`\n============================`);
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);
