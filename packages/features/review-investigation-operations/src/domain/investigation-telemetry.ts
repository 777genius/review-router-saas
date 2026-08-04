export enum InvestigationTelemetrySource {
  DisposableFixture = "disposable_fixture",
  Shadow = "shadow",
  Allowlisted = "allowlisted",
}

export enum InvestigationTelemetryProvider {
  Codex = "codex",
  Claude = "claude",
  ClaudeCode = "claude_code",
  Unknown = "unknown",
}

export enum InvestigationTelemetryEvidenceCompleteness {
  TerminalOperational = "terminal_operational",
  FullyEvaluated = "fully_evaluated",
}

export enum InvestigationTelemetryConclusion {
  VerifiedClean = "verified_clean",
  Findings = "findings",
  Inconclusive = "inconclusive",
}

export enum InvestigationLegacyComparison {
  Agree = "agree",
  InvestigationImproved = "investigation_improved",
  LegacyImproved = "legacy_improved",
  UnexplainedDisagreement = "unexplained_disagreement",
  NotCompared = "not_compared",
}

export enum InvestigationReplayOutcome {
  ExactHit = "exact_hit",
  CrossRevisionHit = "cross_revision_hit",
  Miss = "miss",
  NotAttempted = "not_attempted",
  Unknown = "unknown",
}

export enum InvestigationOperationalFailure {
  None = "none",
  Auth = "auth",
  Capacity = "capacity",
  Infrastructure = "infrastructure",
  Protocol = "protocol",
  Security = "security",
  Unknown = "unknown",
}

type InvestigationTelemetrySampleBase = Readonly<{
  sampleId: string;
  collectedAt: string;
  source: InvestigationTelemetrySource;
  evidenceCompleteness: InvestigationTelemetryEvidenceCompleteness;
  repositoryScopeHash: string;
  reviewRevisionHash: string;
  stableReviewUnitHash: string;
  producerReleaseId: string;
  provider: InvestigationTelemetryProvider;
  actualModel: string | null;
  conclusion: InvestigationTelemetryConclusion;
  findingCount: number;
  legacyComparison: InvestigationLegacyComparison;
  replayOutcome: InvestigationReplayOutcome;
  failure: InvestigationOperationalFailure;
  semanticTurns: number;
  criticCycles: number;
  gatewayOperations: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number;
  durationMs: number;
  timeToFirstFindingMs: number | null;
  capacityWaitMs: number | null;
  protocolBytes: number | null;
  retainedBytes: number | null;
}>;

export type InvestigationTerminalOperationalTelemetrySample =
  InvestigationTelemetrySampleBase &
    Readonly<{
      evidenceCompleteness: InvestigationTelemetryEvidenceCompleteness.TerminalOperational;
      expectedDefectCount: null;
      detectedDefectCount: null;
      falseClean: null;
      securityViolationCount: null;
    }>;

export type InvestigationFullyEvaluatedTelemetrySample =
  InvestigationTelemetrySampleBase &
    Readonly<{
      evidenceCompleteness: InvestigationTelemetryEvidenceCompleteness.FullyEvaluated;
      expectedDefectCount: number;
      detectedDefectCount: number;
      falseClean: boolean;
      securityViolationCount: number;
    }>;

export type InvestigationTelemetrySample =
  | InvestigationTerminalOperationalTelemetrySample
  | InvestigationFullyEvaluatedTelemetrySample;

const telemetryFields = Object.freeze([
  "sampleId",
  "collectedAt",
  "source",
  "evidenceCompleteness",
  "repositoryScopeHash",
  "reviewRevisionHash",
  "stableReviewUnitHash",
  "producerReleaseId",
  "provider",
  "actualModel",
  "conclusion",
  "findingCount",
  "expectedDefectCount",
  "detectedDefectCount",
  "falseClean",
  "legacyComparison",
  "replayOutcome",
  "failure",
  "semanticTurns",
  "criticCycles",
  "gatewayOperations",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "durationMs",
  "timeToFirstFindingMs",
  "capacityWaitMs",
  "protocolBytes",
  "retainedBytes",
  "securityViolationCount",
] as const);

export function validateTelemetrySample(
  sample: InvestigationTelemetrySample,
): void {
  const fields = Object.keys(sample).sort();
  const expectedFields = [...telemetryFields].sort();
  if (
    fields.length !== expectedFields.length ||
    fields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new Error("telemetry_fields_invalid");
  }
  enumValue(InvestigationTelemetrySource, sample.source, "telemetry_source");
  enumValue(
    InvestigationTelemetryEvidenceCompleteness,
    sample.evidenceCompleteness,
    "evidence_completeness",
  );
  enumValue(InvestigationTelemetryProvider, sample.provider, "provider");
  enumValue(InvestigationTelemetryConclusion, sample.conclusion, "conclusion");
  enumValue(
    InvestigationLegacyComparison,
    sample.legacyComparison,
    "legacy_comparison",
  );
  enumValue(InvestigationReplayOutcome, sample.replayOutcome, "replay_outcome");
  enumValue(InvestigationOperationalFailure, sample.failure, "failure");
  identifier(sample.sampleId, "sample_id");
  timestamp(sample.collectedAt, "collected_at");
  digest(sample.repositoryScopeHash, "repository_scope_hash");
  digest(sample.reviewRevisionHash, "review_revision_hash");
  digest(sample.stableReviewUnitHash, "stable_review_unit_hash");
  identifier(sample.producerReleaseId, "producer_release_id");
  if (sample.actualModel !== null) {
    identifier(sample.actualModel, "actual_model");
  }
  for (const [field, value] of [
    ["finding_count", sample.findingCount],
    ["semantic_turns", sample.semanticTurns],
    ["critic_cycles", sample.criticCycles],
    ["total_tokens", sample.totalTokens],
    ["duration_ms", sample.durationMs],
  ] as const) {
    nonNegative(value, field);
  }
  for (const [field, value] of [
    ["gateway_operations", sample.gatewayOperations],
    ["prompt_tokens", sample.promptTokens],
    ["completion_tokens", sample.completionTokens],
    ["time_to_first_finding_ms", sample.timeToFirstFindingMs],
    ["capacity_wait_ms", sample.capacityWaitMs],
    ["protocol_bytes", sample.protocolBytes],
    ["retained_bytes", sample.retainedBytes],
  ] as const) {
    nullableNonNegative(value, field);
  }
  if ((sample.promptTokens === null) !== (sample.completionTokens === null)) {
    throw new Error("token_breakdown_completeness_mismatch");
  }
  if (
    sample.promptTokens !== null &&
    sample.completionTokens !== null &&
    sample.totalTokens !== sample.promptTokens + sample.completionTokens
  ) {
    throw new Error("total_tokens_mismatch");
  }
  if (
    sample.timeToFirstFindingMs !== null &&
    sample.timeToFirstFindingMs > sample.durationMs
  ) {
    throw new Error("time_to_first_finding_exceeds_duration");
  }
  if (
    sample.falseClean &&
    (sample.conclusion !== InvestigationTelemetryConclusion.VerifiedClean ||
      sample.expectedDefectCount === 0)
  ) {
    throw new Error("false_clean_semantics_invalid");
  }
  if (
    sample.conclusion === InvestigationTelemetryConclusion.VerifiedClean &&
    sample.findingCount !== 0
  ) {
    throw new Error("verified_clean_finding_count_invalid");
  }
  if (
    sample.evidenceCompleteness ===
    InvestigationTelemetryEvidenceCompleteness.TerminalOperational
  ) {
    if (
      sample.expectedDefectCount !== null ||
      sample.detectedDefectCount !== null ||
      sample.falseClean !== null ||
      sample.securityViolationCount !== null ||
      sample.capacityWaitMs !== null ||
      sample.legacyComparison !== InvestigationLegacyComparison.NotCompared ||
      sample.failure !== InvestigationOperationalFailure.None
    ) {
      throw new Error("terminal_operational_evidence_semantics_invalid");
    }
    return;
  }
  nonNegative(sample.expectedDefectCount, "expected_defect_count");
  nonNegative(sample.detectedDefectCount, "detected_defect_count");
  nonNegative(sample.securityViolationCount, "security_violation_count");
  if (sample.detectedDefectCount > sample.expectedDefectCount) {
    throw new Error("detected_defect_count_exceeds_expected");
  }
  if (
    sample.falseClean !==
    (sample.conclusion === InvestigationTelemetryConclusion.VerifiedClean &&
      sample.expectedDefectCount > 0)
  ) {
    throw new Error("false_clean_semantics_invalid");
  }
  if (
    sample.source !== InvestigationTelemetrySource.DisposableFixture &&
    sample.legacyComparison === InvestigationLegacyComparison.NotCompared
  ) {
    throw new Error("fully_evaluated_comparison_missing");
  }
}

export function isFullyEvaluatedTelemetrySample(
  sample: InvestigationTelemetrySample,
): sample is InvestigationFullyEvaluatedTelemetrySample {
  return (
    sample.evidenceCompleteness ===
    InvestigationTelemetryEvidenceCompleteness.FullyEvaluated
  );
}

function enumValue<T extends string>(
  values: Readonly<Record<string, T>>,
  value: string,
  field: string,
): void {
  if (!Object.values(values).includes(value as T)) {
    throw new Error(`${field}_invalid`);
  }
}

function identifier(value: string, field: string): void {
  if (!value || value.length > 512 || value.trim() !== value) {
    throw new Error(`${field}_invalid`);
  }
}

function digest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field}_invalid`);
}

function timestamp(value: string, field: string): void {
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field}_invalid`);
  }
}

function nonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

function nullableNonNegative(value: number | null, field: string): void {
  if (value !== null) nonNegative(value, field);
}
