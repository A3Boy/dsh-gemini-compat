import { createHash } from 'crypto';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type FailureClassification =
  | 'MODEL_ARGUMENT_CONTRACT_VIOLATION'
  | 'ADAPTER_ARGUMENT_LOSS'
  | 'SCHEMA_SERIALIZATION_DEFECT'
  | 'MALFORMED_STREAM_TRUNCATION'
  | 'PROVIDER_PROTOCOL_ERROR'
  | 'UNKNOWN';

export interface TraceStageA {
  tool: string;
  schemaHash: string;
  topLevelRequired: string[];
}

export interface TraceStageB {
  wireToolsCount: number;
  toolsHash: string;
  toolNames: string[];
}

export interface TraceStageC {
  callId?: string;
  toolName: string;
  rawArgumentsDelta: string;
  hasProviderMetadata: boolean;
}

export interface TraceStageD {
  toolName: string;
  finalRawJson: string;
  isJsonValid: boolean;
  validationStatus: 'VALID' | 'INVALID_ARGS';
  violationMessage?: string;
}

export interface TelemetryMetrics {
  gemini_tool_calls_total: number;
  gemini_invalid_args_total: number;
  gemini_invalid_args_rate: number;
  gemini_tool_call_json_invalid_total: number;
  gemini_wire_schema_error_total: number;
  gemini_replay_metadata_missing_total: number;
  gemini_provider_protocol_error_total: number;
  gemini_tool_execution_error_total: number;
  gemini_invalid_args_recovered_total: number;
  gemini_repeated_same_invalid_args_total: number;
}

export class DiagnosticsCollector {
  private metrics: TelemetryMetrics = {
    gemini_tool_calls_total: 0,
    gemini_invalid_args_total: 0,
    gemini_invalid_args_rate: 0,
    gemini_tool_call_json_invalid_total: 0,
    gemini_wire_schema_error_total: 0,
    gemini_replay_metadata_missing_total: 0,
    gemini_provider_protocol_error_total: 0,
    gemini_tool_execution_error_total: 0,
    gemini_invalid_args_recovered_total: 0,
    gemini_repeated_same_invalid_args_total: 0,
  };

  private traces: Array<{
    timestamp: number;
    stageA?: TraceStageA;
    stageB?: TraceStageB;
    stageC?: TraceStageC[];
    stageD?: TraceStageD;
    classification?: FailureClassification;
  }> = [];

  public static hashSchema(schema: ToolSchema): string {
    const canonical = JSON.stringify({
      name: schema.name,
      parameters: schema.parameters,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  public recordStageA(schema: ToolSchema): TraceStageA {
    const required = Array.isArray((schema.parameters as any)?.required)
      ? ((schema.parameters as any).required as string[])
      : [];
    return {
      tool: schema.name,
      schemaHash: DiagnosticsCollector.hashSchema(schema),
      topLevelRequired: required,
    };
  }

  public recordStageB(wireTools: Array<{ type: string; function?: { name: string; parameters?: unknown } }>): TraceStageB {
    const toolNames = wireTools.map((t) => t.function?.name ?? 'unknown');
    const hash = createHash('sha256').update(JSON.stringify(wireTools)).digest('hex').slice(0, 16);
    return {
      wireToolsCount: wireTools.length,
      toolsHash: hash,
      toolNames,
    };
  }

  public classifyFailure(
    rawProviderArgs: string,
    assembledArgs: Record<string, unknown> | null,
    validationError?: string,
    isStreamTruncated = false
  ): FailureClassification {
    this.metrics.gemini_tool_calls_total++;

    if (isStreamTruncated) {
      this.metrics.gemini_tool_call_json_invalid_total++;
      return 'MALFORMED_STREAM_TRUNCATION';
    }

    if (!assembledArgs) {
      this.metrics.gemini_tool_call_json_invalid_total++;
      return 'PROVIDER_PROTOCOL_ERROR';
    }

    if (validationError) {
      this.metrics.gemini_invalid_args_total++;
      this.metrics.gemini_invalid_args_rate =
        this.metrics.gemini_invalid_args_total / this.metrics.gemini_tool_calls_total;

      let parsedRaw: Record<string, unknown> | null = null;
      try {
        parsedRaw = JSON.parse(rawProviderArgs);
      } catch {
        // Raw was not valid json
      }

      if (parsedRaw) {
        // Check if raw had the missing fields that assembled dropped
        const rawKeys = Object.keys(parsedRaw);
        const assembledKeys = Object.keys(assembledArgs);
        const missingInAssembled = rawKeys.filter((k) => !assembledKeys.includes(k));

        if (missingInAssembled.length > 0) {
          return 'ADAPTER_ARGUMENT_LOSS';
        }
      }

      return 'MODEL_ARGUMENT_CONTRACT_VIOLATION';
    }

    return 'UNKNOWN';
  }

  public getMetrics(): Readonly<TelemetryMetrics> {
    return { ...this.metrics };
  }
}
