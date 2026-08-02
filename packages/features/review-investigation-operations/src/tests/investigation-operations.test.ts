import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenerateInvestigationPromotionReport } from "../application/use-cases/generate-investigation-promotion-report";
import { GetInvestigationOperatorStatus } from "../application/use-cases/get-investigation-operator-status";
import { RecordInvestigationTelemetry } from "../application/use-cases/record-investigation-telemetry";
import {
  InvestigationLegacyComparison,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
  type InvestigationTelemetrySample,
} from "../domain/investigation-telemetry";
import {
  InvestigationPromotionBlocker,
  InvestigationPromotionDecision,
} from "../domain/promotion-report";
import {
  InvestigationCompatibilityStatus,
  InvestigationOperatorConclusion,
  InvestigationOperatorNextAction,
  InvestigationOperatorState,
} from "../domain/operator-status";
import {
  createInvestigationRolloutPolicy,
  evaluateInvestigationRollout,
  InvestigationRolloutCapability,
  InvestigationRolloutDecision,
  InvestigationRolloutProvider,
} from "../domain/investigation-rollout-policy";
import {
  alertsFromPromotionReport,
  InvestigationAlertCode,
} from "../domain/investigation-alerts";
import { InMemoryInvestigationOperations } from "../infrastructure/memory/in-memory-investigation-operations";

const release = "reviewrouter-action-fixture.1";
const thresholds = {
  minSeededSamples: 4,
  minShadowSamples: 0,
  maxUnexplainedDisagreements: 0,
  maxP95TotalTokens: 10_000,
  maxP95DurationMs: 60_000,
};
const digest = {
  digestUtf8: async (value: string) =>
    createHash("sha256").update(value).digest("hex"),
};

describe("review investigation operations", () => {
  it("generates an immutable, deterministic report for the disposable corpus", async () => {
    const first = await reportFor([
      sample("hidden-caller", 2, 2, 8_000, 2_500),
      sample("shared-schema", 1, 1, 12_000, 3_000),
      sample("delete-invalidation", 1, 1, 9_000, 2_000),
      sample("auth-policy", 1, 1, 10_000, 2_200),
    ]);
    const second = await reportFor([
      sample("auth-policy", 1, 1, 10_000, 2_200),
      sample("delete-invalidation", 1, 1, 9_000, 2_000),
      sample("shared-schema", 1, 1, 12_000, 3_000),
      sample("hidden-caller", 2, 2, 8_000, 2_500),
    ]);

    expect(first.reportHash).toBe(second.reportHash);
    expect(first.body).toMatchObject({
      decision: InvestigationPromotionDecision.Eligible,
      blockers: [],
      metrics: {
        seededSamples: 4,
        expectedDefects: 5,
        detectedDefects: 5,
        falseCleanCount: 0,
        p95TotalTokens: 3_000,
        p95DurationMs: 12_000,
      },
    });
  });

  it("blocks promotion on a false clean and missing shadow evidence", async () => {
    const unsafe = sample("false-clean", 1, 0, 5_000, 1_000, {
      conclusion: InvestigationTelemetryConclusion.VerifiedClean,
      falseClean: true,
    });
    const operations = new InMemoryInvestigationOperations();
    await new RecordInvestigationTelemetry(operations).execute(unsafe);
    const report = await new GenerateInvestigationPromotionReport(
      operations,
      digest,
      operations,
    ).execute({
      generatedAt: "2026-08-02T12:00:00.000Z",
      producerReleaseId: release,
      thresholds: { ...thresholds, minShadowSamples: 10 },
    });

    expect(report.body.decision).toBe(InvestigationPromotionDecision.Blocked);
    expect(report.body.blockers).toEqual(
      expect.arrayContaining([
        InvestigationPromotionBlocker.InsufficientSeededSamples,
        InvestigationPromotionBlocker.InsufficientShadowSamples,
        InvestigationPromotionBlocker.FalseCleanDetected,
        InvestigationPromotionBlocker.SeededDefectMissDetected,
      ]),
    );
    expect(alertsFromPromotionReport(report.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: InvestigationAlertCode.FalseClean }),
        expect.objectContaining({
          code: InvestigationAlertCode.SeededDefectMiss,
        }),
        expect.objectContaining({
          code: InvestigationAlertCode.EvidenceInsufficient,
        }),
      ]),
    );
  });

  it("keeps append idempotent and rejects conflicting sample identity", async () => {
    const operations = new InMemoryInvestigationOperations();
    const recorder = new RecordInvestigationTelemetry(operations);
    const original = sample("same", 0, 0, 100, 10);
    await recorder.execute(original);
    await recorder.execute(original);
    await expect(
      recorder.execute({ ...original, durationMs: 101 }),
    ).rejects.toThrow("telemetry_sample_id_conflict");
  });

  it("rejects unknown telemetry enums and additional payload fields", async () => {
    const operations = new InMemoryInvestigationOperations();
    const recorder = new RecordInvestigationTelemetry(operations);
    await expect(
      recorder.execute({
        ...sample("unknown-enum", 0, 0, 100, 10),
        provider: "future-provider",
      } as unknown as InvestigationTelemetrySample),
    ).rejects.toThrow("provider_invalid");
    await expect(
      recorder.execute({
        ...sample("extra-field", 0, 0, 100, 10),
        rawPrompt: "must-not-survive",
      } as InvestigationTelemetrySample),
    ).rejects.toThrow("telemetry_fields_invalid");
  });

  it("exposes only the sanitized operator projection", async () => {
    const operations = new InMemoryInvestigationOperations();
    operations.setStatus({
      investigationId: "investigation-1",
      repositoryScopeHash: "a".repeat(64),
      reviewRevisionHash: "b".repeat(64),
      state: InvestigationOperatorState.AwaitingTurn,
      version: 7,
      openObligationCount: 2,
      satisfiedObligationCount: 4,
      unresolvableObligationCount: 0,
      nextAction: InvestigationOperatorNextAction.AwaitCapacity,
      capacityEligibleAt: "2026-08-02T13:00:00.000Z",
      lastFailureCode: "capacity_unavailable",
      conclusion: InvestigationOperatorConclusion.None,
      compatibility: InvestigationCompatibilityStatus.Compatible,
      producerReleaseId: release,
      protocolVersion: "2",
      gatewayPolicyVersion: "context-gateway-v4",
      updatedAt: "2026-08-02T12:00:00.000Z",
    });

    const status = await new GetInvestigationOperatorStatus(operations).execute(
      "investigation-1",
    );
    expect(status).toMatchObject({
      nextAction: InvestigationOperatorNextAction.AwaitCapacity,
      lastFailureCode: "capacity_unavailable",
      openObligationCount: 2,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /authToken|secret|prompt|sourceCode|canonicalJson/iu,
    );
  });

  it("makes emergency disable win over every capability and selector", () => {
    const policy = createInvestigationRolloutPolicy({
      emergencyDisabled: true,
      enabledCapabilities: Object.values(InvestigationRolloutCapability),
      selectors: {
        [InvestigationRolloutCapability.ProductionEffects]: [
          { repositoryConnectionIds: ["repository-1"] },
        ],
      },
    });
    const target = {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      provider: InvestigationRolloutProvider.Codex,
      trustDomain: "trusted",
      producerReleaseId: release,
    };
    for (const capability of Object.values(InvestigationRolloutCapability)) {
      expect(evaluateInvestigationRollout(policy, capability, target)).toBe(
        InvestigationRolloutDecision.EmergencyDisabled,
      );
    }
  });

  it("rejects unsafe flag dependency combinations", () => {
    expect(() =>
      createInvestigationRolloutPolicy({
        emergencyDisabled: false,
        enabledCapabilities: [InvestigationRolloutCapability.VerifiedClean],
      }),
    ).toThrow("rollout_dependency_missing:verified_clean:context_critic");
  });
});

async function reportFor(samples: readonly InvestigationTelemetrySample[]) {
  const operations = new InMemoryInvestigationOperations();
  const recorder = new RecordInvestigationTelemetry(operations);
  for (const item of samples) await recorder.execute(item);
  return new GenerateInvestigationPromotionReport(
    operations,
    digest,
    operations,
  ).execute({
    generatedAt: "2026-08-02T12:00:00.000Z",
    producerReleaseId: release,
    thresholds,
  });
}

function sample(
  id: string,
  expectedDefectCount: number,
  detectedDefectCount: number,
  durationMs: number,
  totalTokens: number,
  overrides: Partial<InvestigationTelemetrySample> = {},
): InvestigationTelemetrySample {
  return {
    sampleId: id,
    collectedAt: "2026-08-02T12:00:00.000Z",
    source: InvestigationTelemetrySource.DisposableFixture,
    repositoryScopeHash: "a".repeat(64),
    reviewRevisionHash: createHash("sha256").update(id).digest("hex"),
    stableReviewUnitHash: createHash("sha256")
      .update(`unit:${id}`)
      .digest("hex"),
    producerReleaseId: release,
    provider: InvestigationTelemetryProvider.Codex,
    actualModel: "fixture-agent",
    conclusion:
      expectedDefectCount > 0
        ? InvestigationTelemetryConclusion.Findings
        : InvestigationTelemetryConclusion.VerifiedClean,
    expectedDefectCount,
    detectedDefectCount,
    falseClean: false,
    legacyComparison: InvestigationLegacyComparison.Agree,
    replayOutcome: InvestigationReplayOutcome.NotAttempted,
    failure: InvestigationOperationalFailure.None,
    semanticTurns: 2,
    criticCycles: 1,
    gatewayOperations: 8,
    promptTokens: Math.floor(totalTokens / 2),
    completionTokens: totalTokens - Math.floor(totalTokens / 2),
    totalTokens,
    durationMs,
    timeToFirstFindingMs: expectedDefectCount > 0 ? durationMs / 2 : null,
    capacityWaitMs: 0,
    protocolBytes: 2_048,
    retainedBytes: 4_096,
    securityViolationCount: 0,
    ...overrides,
  };
}
