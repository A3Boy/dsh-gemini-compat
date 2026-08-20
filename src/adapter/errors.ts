export class GeminiProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: 'MALFORMED_RESPONSE' | 'STREAM_TRUNCATION' | 'UNSUPPORTED' | 'INVALID_ARGUMENTS_JSON'
  ) {
    super(`[GeminiAdapter ${code}] ${message}`);
    this.name = 'GeminiProtocolError';
  }
}
