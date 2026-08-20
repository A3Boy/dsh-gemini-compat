import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export type FailureClassification =
  | 'MODEL_ARGUMENT_CONTRACT_VIOLATION'
  | 'ADAPTER_ARGUMENT_LOSS'
  | 'SCHEMA_SERIALIZATION_DEFECT'
  | 'MALFORMED_STREAM_TRUNCATION'
  | 'PROVIDER_PROTOCOL_ERROR'
  | 'UNKNOWN'

export interface FailureReport {
  readonly provider: string
  readonly model: string
  readonly tool: string
  readonly providerRawArguments: string
  readonly assembledArguments: Record<string, unknown> | null
  readonly validation: {
    readonly status: 'VALID' | 'INVALID_ARGS'
    readonly message?: string
  }
  readonly classification: FailureClassification
}

/**
 * 4-stage diagnostic tracer that classifies tool-call failures into
 * provider-neutral categories.
 */
export class DiagnosticsCollector {
  private toolCallsTotal = 0
  private invalidArgsTotal = 0
  private jsonInvalidTotal = 0

  public classifyFailure(
    rawProviderArgs: string,
    assembledArgs: Record<string, unknown> | null,
    validationError?: string,
    isStreamTruncated = false,
  ): FailureClassification {
    this.toolCallsTotal++

    if (isStreamTruncated) {
      this.jsonInvalidTotal++
      return 'MALFORMED_STREAM_TRUNCATION'
    }

    if (assembledArgs === null) {
      this.jsonInvalidTotal++
      return 'PROVIDER_PROTOCOL_ERROR'
    }

    if (validationError !== undefined) {
      this.invalidArgsTotal++

      let parsedRaw: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(rawProviderArgs)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          parsedRaw = parsed as Record<string, unknown>
        }
      } catch {
        // raw string was not valid json
      }

      if (parsedRaw !== null) {
        const rawKeys = Object.keys(parsedRaw)
        const assembledKeys = Object.keys(assembledArgs)
        const missingInAssembled = rawKeys.filter((k) => !assembledKeys.includes(k))
        if (missingInAssembled.length > 0) {
          return 'ADAPTER_ARGUMENT_LOSS'
        }
      }

      return 'MODEL_ARGUMENT_CONTRACT_VIOLATION'
    }

    return 'UNKNOWN'
  }

  public generateFailureReport(
    provider: string,
    model: string,
    tool: string,
    rawProviderArgs: string,
    assembledArgs: Record<string, unknown> | null,
    validationError?: string,
    isStreamTruncated = false,
  ): FailureReport {
    const classification = this.classifyFailure(
      rawProviderArgs,
      assembledArgs,
      validationError,
      isStreamTruncated,
    )

    return {
      provider,
      model,
      tool,
      providerRawArguments: rawProviderArgs,
      assembledArguments: assembledArgs,
      validation: {
        status: validationError !== undefined ? 'INVALID_ARGS' : 'VALID',
        ...(validationError !== undefined ? { message: validationError } : {}),
      },
      classification,
    }
  }

  public getMetrics(): Readonly<{
    toolCallsTotal: number
    invalidArgsTotal: number
    jsonInvalidTotal: number
    invalidArgsRate: number
  }> {
    return {
      toolCallsTotal: this.toolCallsTotal,
      invalidArgsTotal: this.invalidArgsTotal,
      jsonInvalidTotal: this.jsonInvalidTotal,
      invalidArgsRate: this.toolCallsTotal > 0 ? this.invalidArgsTotal / this.toolCallsTotal : 0,
    }
  }
}
