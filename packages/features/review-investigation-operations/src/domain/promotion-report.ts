import {
  InvestigationLegacyComparison,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetrySource,
  isFullyEvaluatedTelemetrySample,
  type InvestigationFullyEvaluatedTelemetrySample,
  type InvestigationTelemetrySample,
  validateTelemetrySample,
} from "./investigation-telemetry";
import {
  normalizeInvestigationPromotionPolicyProfile,
  type InvestigationPromotionPolicyProfile,
  type InvestigationPromotionProfileIdentity,
  type InvestigationPromotionThresholds,
} from "./promotion-policy";

export enum InvestigationPromotionReportVersion {
  V3 = "review-investigation-promotion.v3",
}

export enum InvestigationPromotionDecision {
  Eligible = "eligible",
  Blocked = "blocked",
}

export enum InvestigationPromotionBlocker {
  InsufficientSeededSamples = "insufficient_seeded_samples",
  InsufficientShadowSamples = "insufficient_shadow_samples",
  FalseCleanDetected = "false_clean_detected",
  SeededDefectMissDetected = "seeded_defect_miss_detected",
  UnexplainedDisagreementBudgetExceeded = "unexplained_disagreement_budget_exceeded",
  SecurityViolationDetected = "security_violation_detected",
  TokenBudgetExceeded = "token_budget_exceeded",
  LatencyBudgetExceeded = "latency_budget_exceeded",
}

export type InvestigationPromotionMetrics = Readonly<{
  totalSamples: number;
  fullyEvaluatedSamples: number;
  terminalOperationalSamples: number;
  incompleteSamples: number;
  seededSamples: number;
  shadowSamples: number;
  allowlistedSamples: number;
  observedFindingCount: number;
  expectedDefects: number;
  detectedDefects: number;
  falseCleanCount: number;
  unexplainedDisagreementCount: number;
  securityViolationCount: number;
  replayHitCount: number;
  p50TotalTokens: number | null;
  p95TotalTokens: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p95CapacityWaitMs: number | null;
}>;

export type InvestigationPromotionReportBody = Readonly<{
  reportVersion: InvestigationPromotionReportVersion.V3;
  generatedAt: string;
  producerReleaseId: string;
  profile: InvestigationPromotionProfileIdentity;
  trustProfile: InvestigationPromotionPolicyProfile["trustProfile"];
  sampleSetHash: string;
  thresholds: InvestigationPromotionThresholds;
  metrics: InvestigationPromotionMetrics;
  decision: InvestigationPromotionDecision;
  blockers: readonly InvestigationPromotionBlocker[];
}>;

export function evaluatePromotion(input: {
  readonly generatedAt: string;
  readonly producerReleaseId: string;
  readonly policy: InvestigationPromotionPolicyProfile;
  readonly sampleSetHash: string;
  readonly samples: readonly InvestigationTelemetrySample[];
}): InvestigationPromotionReportBody {
  if (
    !input.generatedAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    throw new Error("promotion_generated_at_invalid");
  }
  if (
    !input.producerReleaseId ||
    input.producerReleaseId.trim() !== input.producerReleaseId
  ) {
    throw new Error("promotion_producer_release_invalid");
  }
  input.samples.forEach(validateTelemetrySample);
  const policy = normalizeInvestigationPromotionPolicyProfile(input.policy);
  const samples = [...input.samples].sort((a, b) =>
    a.sampleId.localeCompare(b.sampleId, "en"),
  );
  if (new Set(samples.map((item) => item.sampleId)).size !== samples.length) {
    throw new Error("promotion_sample_id_duplicate");
  }
  if (
    samples.some((item) => item.producerReleaseId !== input.producerReleaseId)
  ) {
    throw new Error("promotion_producer_release_mismatch");
  }
  const fullyEvaluated = samples.filter(isFullyEvaluatedTelemetrySample);
  const values = (
    select: (
      sample: InvestigationFullyEvaluatedTelemetrySample,
    ) => number | null,
  ) =>
    fullyEvaluated
      .map(select)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
  const metrics: InvestigationPromotionMetrics = Object.freeze({
    totalSamples: samples.length,
    fullyEvaluatedSamples: fullyEvaluated.length,
    terminalOperationalSamples: samples.filter(
      (item) =>
        item.evidenceCompleteness ===
        InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
    ).length,
    incompleteSamples: samples.length - fullyEvaluated.length,
    seededSamples: countSource(
      fullyEvaluated,
      InvestigationTelemetrySource.DisposableFixture,
    ),
    shadowSamples: countSource(
      fullyEvaluated,
      InvestigationTelemetrySource.Shadow,
    ),
    allowlistedSamples: countSource(
      fullyEvaluated,
      InvestigationTelemetrySource.Allowlisted,
    ),
    observedFindingCount: sum(samples, (item) => item.findingCount),
    expectedDefects: sum(fullyEvaluated, (item) => item.expectedDefectCount),
    detectedDefects: sum(fullyEvaluated, (item) => item.detectedDefectCount),
    falseCleanCount: fullyEvaluated.filter((item) => item.falseClean).length,
    unexplainedDisagreementCount: fullyEvaluated.filter(
      (item) =>
        item.legacyComparison ===
        InvestigationLegacyComparison.UnexplainedDisagreement,
    ).length,
    securityViolationCount: sum(
      fullyEvaluated,
      (item) => item.securityViolationCount,
    ),
    replayHitCount: fullyEvaluated.filter((item) =>
      item.replayOutcome.endsWith("_hit"),
    ).length,
    p50TotalTokens: percentile(
      values((item) => item.totalTokens),
      0.5,
    ),
    p95TotalTokens: percentile(
      values((item) => item.totalTokens),
      0.95,
    ),
    p50DurationMs: percentile(
      values((item) => item.durationMs),
      0.5,
    ),
    p95DurationMs: percentile(
      values((item) => item.durationMs),
      0.95,
    ),
    p95CapacityWaitMs: percentile(
      values((item) => item.capacityWaitMs),
      0.95,
    ),
  });
  const blockers = blockersFor(metrics, policy.thresholds);
  return Object.freeze({
    reportVersion: InvestigationPromotionReportVersion.V3,
    generatedAt: input.generatedAt,
    producerReleaseId: input.producerReleaseId,
    profile: policy.identity,
    trustProfile: policy.trustProfile,
    sampleSetHash: input.sampleSetHash,
    thresholds: policy.thresholds,
    metrics,
    decision:
      blockers.length === 0
        ? InvestigationPromotionDecision.Eligible
        : InvestigationPromotionDecision.Blocked,
    blockers: Object.freeze(blockers),
  });
}

function blockersFor(
  metrics: InvestigationPromotionMetrics,
  thresholds: InvestigationPromotionThresholds,
): InvestigationPromotionBlocker[] {
  const blockers: InvestigationPromotionBlocker[] = [];
  if (metrics.seededSamples < thresholds.minSeededSamples)
    blockers.push(InvestigationPromotionBlocker.InsufficientSeededSamples);
  if (metrics.shadowSamples < thresholds.minShadowSamples)
    blockers.push(InvestigationPromotionBlocker.InsufficientShadowSamples);
  if (metrics.falseCleanCount > 0)
    blockers.push(InvestigationPromotionBlocker.FalseCleanDetected);
  if (metrics.detectedDefects < metrics.expectedDefects)
    blockers.push(InvestigationPromotionBlocker.SeededDefectMissDetected);
  if (
    metrics.unexplainedDisagreementCount >
    thresholds.maxUnexplainedDisagreements
  )
    blockers.push(
      InvestigationPromotionBlocker.UnexplainedDisagreementBudgetExceeded,
    );
  if (metrics.securityViolationCount > 0)
    blockers.push(InvestigationPromotionBlocker.SecurityViolationDetected);
  if (
    metrics.p95TotalTokens !== null &&
    metrics.p95TotalTokens > thresholds.maxP95TotalTokens
  )
    blockers.push(InvestigationPromotionBlocker.TokenBudgetExceeded);
  if (
    metrics.p95DurationMs !== null &&
    metrics.p95DurationMs > thresholds.maxP95DurationMs
  )
    blockers.push(InvestigationPromotionBlocker.LatencyBudgetExceeded);
  return blockers;
}

function countSource<T extends InvestigationTelemetrySample>(
  samples: readonly T[],
  source: InvestigationTelemetrySource,
): number {
  return samples.filter((item) => item.source === source).length;
}

function sum<T>(samples: readonly T[], select: (sample: T) => number): number {
  return samples.reduce((total, item) => total + select(item), 0);
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  return values[Math.ceil(values.length * ratio) - 1] ?? null;
}
