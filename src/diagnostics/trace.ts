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
  route: string;
  model: string;
  tool: string;
  schemaHash: string;
  topLevelRequired: string[];
}

export interface TraceStageB {
  route: string;
  model: string;
  tool: string;
  wireToolName: string;
  toolsHash: string;
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

export interface FailureReport {
  provider: string;
  model: string;
  tool: string;
  requestSchemaHash?: string;
  providerRawArguments: string;
  assembledArguments: Record<string, unknown> | null;
  validation: {
    status: 'VALID' | 'INVALID_ARGS';
    message?: string;
  };
  classification: FailureClassification;
}

export class DiagnosticsCollector {
  private stageARecords: Map<string, TraceStageA> = new Map();
  private stageBRecords: Map<string, TraceStageB> = new Map();
  private stageDRecords: TraceStageD[] = [];

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

  public static hashSchema(schema: ToolSchema): string {
    const canonical = JSON.stringify({
      name: schema.name,
      parameters: schema.parameters,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  public recordStageA(route: string, model: string, schema: ToolSchema): TraceStageA {
    const required = Array.isArray((schema.parameters as any)?.required)
      ? ((schema.parameters as any).required as string[])
      : [];
    const record: TraceStageA = {
      route,
      model,
      tool: schema.name,
      schemaHash: DiagnosticsCollector.hashSchema(schema),
      topLevelRequired: required,
    };
    this.stageARecords.set(schema.name, record);
    return record;
  }

  public getStageA(toolName: string): TraceStageA | undefined {
    return this.stageARecords.get(toolName);
  }

  public recordStageB(route: string, model: string, schema: ToolSchema, wireToolName: string): TraceStageB {
    const hash = DiagnosticsCollector.hashSchema(schema);
    const record: TraceStageB = {
      route,
      model,
      tool: schema.name,
      wireToolName,
      toolsHash: hash,
    };
    this.stageBRecords.set(schema.name, record);
    return record;
  }

  public recordStageD(record: TraceStageD): void {
    this.stageDRecords.push(record);
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
        // raw string was not valid json
      }

      if (parsedRaw) {
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

  public generateFailureReport(
    provider: string,
    model: string,
    tool: string,
    rawProviderArgs: string,
    assembledArgs: Record<string, unknown> | null,
    validationError?: string,
    isStreamTruncated = false
  ): FailureReport {
    const classification = this.classifyFailure(
      rawProviderArgs,
      assembledArgs,
      validationError,
      isStreamTruncated
    );

    const stageA = this.stageARecords.get(tool);

    return {
      provider,
      model,
      tool,
      requestSchemaHash: stageA?.schemaHash,
      providerRawArguments: rawProviderArgs,
      assembledArguments: assembledArgs,
      validation: {
        status: validationError ? 'INVALID_ARGS' : 'VALID',
        message: validationError,
      },
      classification,
    };
  }

  public getMetrics(): Readonly<TelemetryMetrics> {
    return { ...this.metrics };
  }
}
