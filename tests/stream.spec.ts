import { describe, it, expect } from 'vitest';
import { GeminiStreamProcessor } from '../src/adapter/parse-stream.js';
import { GeminiProtocolError } from '../src/adapter/errors.js';

describe('GeminiStreamProcessor & JSON Integrity Gate', () => {
  it('should accurately aggregate stream chunks and validate complete JSON', () => {
    const processor = new GeminiStreamProcessor('openai-chat');

    const chunk1 = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_123',
                function: {
                  name: 'pwsh',
                  arguments: '{"description":"Test command"',
                },
              },
            ],
          },
        },
      ],
    };

    const chunk2 = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: ',"command":"dir"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const events1 = processor.processChunk(chunk1);
    expect(events1).toHaveLength(2); // block-start, tool-call-delta

    const events2 = processor.processChunk(chunk2);
    expect(events2.some((e) => e.type === 'block-end')).toBe(true);

    const blockEnd = events2.find((e) => e.type === 'block-end');
    expect(blockEnd?.toolCall?.arguments).toBe('{"description":"Test command","command":"dir"}');
  });

  it('should throw GeminiProtocolError when json is truncated mid-stream', () => {
    const processor = new GeminiStreamProcessor('openai-chat');

    const chunk1 = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_999',
                function: {
                  name: 'pwsh',
                  arguments: '{"description":"Incomplete string',
                },
              },
            ],
          },
          finish_reason: 'length',
        },
      ],
    };

    expect(() => processor.processChunk(chunk1)).toThrow(GeminiProtocolError);
  });
});
