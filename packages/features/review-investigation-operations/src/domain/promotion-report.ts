import {
  InvestigationLegacyComparison,
  InvestigationTelemetrySource,
  type InvestigationTelemetrySample,
  validateTelemetrySample,
} from "./investigation-telemetry";

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

export type InvestigationPromotionThresholds = Readonly<{
  minSeededSamples: number;
  minShadowSamples: number;
  maxUnexplainedDisagreements: number;
  maxP95TotalTokens: number;
  maxP95DurationMs: number;
}>;

export type InvestigationPromotionMetrics = Readonly<{
  totalSamples: number;
  seededSamples: number;
  shadowSamples: number;
  allowlistedSamples: number;
  expectedDefects: number;
  detectedDefects: number;
  falseCleanCount: number;
  unexplainedDisagreementCount: number;
  securityViolationCount: number;
  replayHitCount: number;
  p50TotalTokens: number;
  p95TotalTokens: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p95CapacityWaitMs: number;
}>;

export type InvestigationPromotionReportBody = Readonly<{
  reportVersion: "review-investigation-promotion.v1";
  generatedAt: string;
  producerReleaseId: string;
  sampleSetHash: string;
  thresholds: InvestigationPromotionThresholds;
  metrics: InvestigationPromotionMetrics;
  decision: InvestigationPromotionDecision;
  blockers: readonly InvestigationPromotionBlocker[];
}>;

export function evaluatePromotion(input: {
  readonly generatedAt: string;
  readonly producerReleaseId: string;
  readonly sampleSetHash: string;
  readonly thresholds: InvestigationPromotionThresholds;
  readonly samples: readonly InvestigationTelemetrySample[];
}): InvestigationPromotionReportBody {
  input.samples.forEach(validateTelemetrySample);
  validateThresholds(input.thresholds);
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
  const values = (select: (sample: InvestigationTelemetrySample) => number) =>
    samples.map(select).sort((a, b) => a - b);
  const metrics: InvestigationPromotionMetrics = Object.freeze({
    totalSamples: samples.length,
    seededSamples: countSource(
      samples,
      InvestigationTelemetrySource.DisposableFixture,
    ),
    shadowSamples: countSource(samples, InvestigationTelemetrySource.Shadow),
    allowlistedSamples: countSource(
      samples,
      InvestigationTelemetrySource.Allowlisted,
    ),
    expectedDefects: sum(samples, (item) => item.expectedDefectCount),
    detectedDefects: sum(samples, (item) => item.detectedDefectCount),
    falseCleanCount: samples.filter((item) => item.falseClean).length,
    unexplainedDisagreementCount: samples.filter(
      (item) =>
        item.legacyComparison ===
        InvestigationLegacyComparison.UnexplainedDisagreement,
    ).length,
    securityViolationCount: sum(samples, (item) => item.securityViolationCount),
    replayHitCount: samples.filter((item) =>
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
  const blockers = blockersFor(metrics, input.thresholds);
  return Object.freeze({
    reportVersion: "review-investigation-promotion.v1",
    generatedAt: input.generatedAt,
    producerReleaseId: input.producerReleaseId,
    sampleSetHash: input.sampleSetHash,
    thresholds: Object.freeze({ ...input.thresholds }),
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
  if (metrics.p95TotalTokens > thresholds.maxP95TotalTokens)
    blockers.push(InvestigationPromotionBlocker.TokenBudgetExceeded);
  if (metrics.p95DurationMs > thresholds.maxP95DurationMs)
    blockers.push(InvestigationPromotionBlocker.LatencyBudgetExceeded);
  return blockers;
}

function validateThresholds(value: InvestigationPromotionThresholds): void {
  for (const [field, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${field}_invalid`);
    }
  }
}

function countSource(
  samples: readonly InvestigationTelemetrySample[],
  source: InvestigationTelemetrySource,
): number {
  return samples.filter((item) => item.source === source).length;
}

function sum(
  samples: readonly InvestigationTelemetrySample[],
  select: (sample: InvestigationTelemetrySample) => number,
): number {
  return samples.reduce((total, item) => total + select(item), 0);
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  return values[Math.ceil(values.length * ratio) - 1] ?? 0;
}
