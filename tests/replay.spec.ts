import { describe, it, expect } from 'vitest';
import { JsonReplayCodec } from '../src/replay/codec.js';
import { injectReplayStateIntoMessages } from '../src/adapter/serialize-request.js';
import { GeminiCompatReplayState } from '../src/replay/state.js';

describe('Replay State & Codec', () => {
  it('should encode and decode replay state without loss', () => {
    const replayState: GeminiCompatReplayState = {
      kind: 'dsh-gemini-compat',
      version: 1,
      protocol: 'openai-chat',
      responseId: 'resp_abc123',
      thoughtSignatures: {
        call_1: 'sig_data_xyz',
      },
    };

    const codec = new JsonReplayCodec();
    const encoded = codec.encode(replayState);
    const decoded = codec.decode(encoded);

    expect(decoded.responseId).toBe('resp_abc123');
    expect(decoded.thoughtSignatures?.call_1).toBe('sig_data_xyz');
  });

  it('should restore thought_signature in assistant tool_calls', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'pwsh',
              arguments: '{"command":"dir","description":"run dir"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'success',
      },
    ];

    const replayState: GeminiCompatReplayState = {
      kind: 'dsh-gemini-compat',
      version: 1,
      protocol: 'openai-chat',
      thoughtSignatures: {
        call_1: 'sig_val_789',
      },
    };

    const restored = injectReplayStateIntoMessages(messages, replayState) as any[];
    expect(restored[0].tool_calls[0].thought_signature).toBe('sig_val_789');
    expect(restored[0].tool_calls[0].extra_content.google.thought_signature).toBe('sig_val_789');
  });
});
