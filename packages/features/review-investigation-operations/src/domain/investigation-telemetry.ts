export enum InvestigationTelemetrySource {
  DisposableFixture = "disposable_fixture",
  Shadow = "shadow",
  Allowlisted = "allowlisted",
}

export enum InvestigationTelemetryProvider {
  Codex = "codex",
  Claude = "claude",
  Unknown = "unknown",
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

export type InvestigationTelemetrySample = Readonly<{
  sampleId: string;
  collectedAt: string;
  source: InvestigationTelemetrySource;
  repositoryScopeHash: string;
  reviewRevisionHash: string;
  stableReviewUnitHash: string;
  producerReleaseId: string;
  provider: InvestigationTelemetryProvider;
  actualModel: string;
  conclusion: InvestigationTelemetryConclusion;
  expectedDefectCount: number;
  detectedDefectCount: number;
  falseClean: boolean;
  legacyComparison: InvestigationLegacyComparison;
  replayOutcome: InvestigationReplayOutcome;
  failure: InvestigationOperationalFailure;
  semanticTurns: number;
  criticCycles: number;
  gatewayOperations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  timeToFirstFindingMs: number | null;
  capacityWaitMs: number;
  protocolBytes: number;
  retainedBytes: number;
  securityViolationCount: number;
}>;

const telemetryFields = Object.freeze([
  "sampleId",
  "collectedAt",
  "source",
  "repositoryScopeHash",
  "reviewRevisionHash",
  "stableReviewUnitHash",
  "producerReleaseId",
  "provider",
  "actualModel",
  "conclusion",
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
  identifier(sample.actualModel, "actual_model");
  for (const [field, value] of Object.entries(sample)) {
    if (typeof value === "number") nonNegative(value, field);
  }
  if (sample.detectedDefectCount > sample.expectedDefectCount) {
    throw new Error("detected_defect_count_exceeds_expected");
  }
  if (sample.totalTokens !== sample.promptTokens + sample.completionTokens) {
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
