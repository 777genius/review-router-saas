import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GenerateInvestigationPromotionReport } from "../application/use-cases/generate-investigation-promotion-report";
import { GetInvestigationOperatorStatus } from "../application/use-cases/get-investigation-operator-status";
import { RecordInvestigationTelemetry } from "../application/use-cases/record-investigation-telemetry";
import { ResolveInvestigationRollout } from "../application/use-cases/resolve-investigation-rollout";
import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationSignatureAlgorithm,
} from "../domain/investigation-evaluation";
import {
  InvestigationLegacyComparison,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
  isFullyEvaluatedTelemetrySample,
  type InvestigationFullyEvaluatedTelemetrySample,
  type InvestigationTelemetrySample,
  type InvestigationTerminalOperationalTelemetrySample,
} from "../domain/investigation-telemetry";
import {
  InvestigationPromotionBlocker,
  InvestigationPromotionDecision,
  InvestigationPromotionReportVersion,
} from "../domain/promotion-report";
import {
  InvestigationPromotionPolicyErrorCode,
  type InvestigationPromotionThresholds,
} from "../domain/promotion-policy";
import {
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustErrorCode,
  InvestigationPromotionTrustProfileVersion,
  type InvestigationPromotionEvaluationEvidence,
  type InvestigationPromotionTrustProfile,
} from "../domain/promotion-trust-profile";
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
import { ConfiguredInvestigationPromotionPolicyRegistry } from "../infrastructure/environment/configured-investigation-promotion-policy-registry";
import {
  EnvironmentInvestigationRolloutPolicyQuery,
  investigationEmergencyDisabledEnv,
  investigationProductionEffectsEnabledEnv,
  investigationRecordingEnabledEnv,
  investigationRolloutSelectorsEnv,
  investigationShadowEnabledEnv,
  investigationContextCriticEnabledEnv,
} from "../infrastructure/environment/environment-investigation-rollout-policy";
import { RunControlInvestigationEmergencyStopQuery } from "../infrastructure/run-control/run-control-investigation-emergency-stop-query";
import { InvestigationPromotionTelemetryReadStatus } from "../application/ports/operations-ports";

const release = "reviewrouter-action-fixture.1";
const generatedAt = "2026-08-02T12:00:00.000Z";
const trustProfile = promotionTrustProfile();
const profileIdentity = Object.freeze({
  id: "production-evaluation",
  version: "2026-08-02.v1",
});
const thresholds = Object.freeze({
  minSeededSamples: 4,
  minShadowSamples: 1,
  maxUnexplainedDisagreements: 0,
  maxP95TotalTokens: 10_000,
  maxP95DurationMs: 60_000,
}) satisfies InvestigationPromotionThresholds;
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
      reportVersion: InvestigationPromotionReportVersion.V3,
      profile: profileIdentity,
      trustProfile,
      decision: InvestigationPromotionDecision.Blocked,
      blockers: [InvestigationPromotionBlocker.InsufficientShadowSamples],
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

  it("includes normalized trust identifiers in the canonical report hash", async () => {
    const first = await reportFor(
      [],
      promotionTrustProfile(["key-b", "key-a"]),
    );
    const reordered = await reportFor(
      [],
      promotionTrustProfile(["key-a", "key-b"]),
    );
    const differentLineage = await reportFor([], {
      ...promotionTrustProfile(["key-a", "key-b"]),
      signingKeys: {
        ...promotionTrustProfile(["key-a", "key-b"]).signingKeys,
        lineageId: "evaluation-lineage-next",
      },
    });

    expect(first.reportHash).toBe(reordered.reportHash);
    expect(first.body.trustProfile.signingKeys.acceptedKeyIds).toEqual([
      "key-a",
      "key-b",
    ]);
    expect(differentLineage.reportHash).not.toBe(first.reportHash);
    expect(first.canonicalJson).toContain("groundTruthSetHash");
    expect(first.canonicalJson).toContain("evaluation-lineage");
  });

  it("blocks promotion on a false clean and missing shadow evidence", async () => {
    const unsafe = sample("false-clean", 1, 0, 5_000, 1_000, {
      conclusion: InvestigationTelemetryConclusion.VerifiedClean,
      falseClean: true,
    });
    const operations = new InMemoryInvestigationOperations();
    operations.seedFullyEvaluatedTelemetrySample(unsafe, evidenceFor(unsafe));
    const report = await new GenerateInvestigationPromotionReport(
      promotionPolicies(trustProfile, {
        ...thresholds,
        minShadowSamples: 10,
      }),
      operations,
      digest,
    ).execute({
      generatedAt,
      producerReleaseId: release,
      profile: profileIdentity,
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

  it("rejects unsafe thresholds in authoritative configuration", () => {
    expect(() =>
      promotionPolicies(trustProfile, {
        ...thresholds,
        minShadowSamples: 0,
      }),
    ).toThrow("promotion_evidence_threshold_zero");
  });

  it("fails closed before reading telemetry for an unconfigured profile", async () => {
    const operations = new InMemoryInvestigationOperations();
    const snapshot = vi.spyOn(operations, "withPromotionSnapshot");
    await expect(
      new GenerateInvestigationPromotionReport(
        promotionPolicies(),
        operations,
        digest,
      ).execute({
        generatedAt,
        producerReleaseId: release,
        profile: { ...profileIdentity, version: "retired.v0" },
      }),
    ).rejects.toMatchObject({
      code: InvestigationPromotionPolicyErrorCode.ProfileNotConfigured,
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("fails closed without hashing or saving an incomplete telemetry set", async () => {
    const digestSpy = vi.fn();
    const withPromotionSnapshot = vi.fn(async (_input, build) =>
      build({ status: InvestigationPromotionTelemetryReadStatus.TooLarge }),
    );
    const report = new GenerateInvestigationPromotionReport(
      promotionPolicies(),
      { withPromotionSnapshot },
      { digestUtf8: digestSpy },
    );

    await expect(
      report.execute({
        generatedAt,
        producerReleaseId: release,
        profile: profileIdentity,
      }),
    ).rejects.toThrow("promotion_telemetry_sample_set_too_large");
    expect(digestSpy).not.toHaveBeenCalled();
    expect(withPromotionSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    ["corpus", { corpusVersion: "corpus.other" }],
    ["ground truth", { groundTruthSetHash: "f".repeat(64) }],
    ["evaluation policy", { evaluationPolicyVersion: "policy.other" }],
    ["signing key", { signingKeyId: "key-unapproved" }],
  ])("fails closed on mixed %s evidence", async (_label, mismatch) => {
    const operations = new InMemoryInvestigationOperations();
    const valid = sample("trusted", 1, 1, 100, 10);
    const mixed = sample("mixed", 1, 1, 100, 10);
    operations.seedFullyEvaluatedTelemetrySample(valid, evidenceFor(valid));
    operations.seedFullyEvaluatedTelemetrySample(
      mixed,
      evidenceFor(mixed, mismatch),
    );
    const digestSpy = vi.fn(digest.digestUtf8);

    await expect(
      new GenerateInvestigationPromotionReport(
        promotionPolicies(),
        operations,
        { digestUtf8: digestSpy },
      ).execute({
        generatedAt,
        producerReleaseId: release,
        profile: profileIdentity,
      }),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationTrustMismatch,
    });
    expect(digestSpy).not.toHaveBeenCalled();
    expect(operations.reports.size).toBe(0);
  });

  it.each([
    ["older than the approved epoch", { issuedAt: "2026-07-31T23:59:59.999Z" }],
    ["expired at report generation", { expiresAt: generatedAt }],
  ])("does not let %s evidence satisfy minimums", async (_label, stale) => {
    const operations = new InMemoryInvestigationOperations();
    const evaluated = sample("stale", 1, 1, 100, 10);
    operations.seedFullyEvaluatedTelemetrySample(
      evaluated,
      evidenceFor(evaluated, stale),
    );

    await expect(
      new GenerateInvestigationPromotionReport(
        promotionPolicies(trustProfile, {
          ...thresholds,
          minSeededSamples: 1,
        }),
        operations,
        digest,
      ).execute({
        generatedAt,
        producerReleaseId: release,
        profile: profileIdentity,
      }),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationEvidenceStale,
    });
    expect(operations.reports.size).toBe(0);
  });

  it("keeps append idempotent and rejects conflicting sample identity", async () => {
    const operations = new InMemoryInvestigationOperations();
    const recorder = new RecordInvestigationTelemetry(operations);
    const original = terminalSample("same");
    await recorder.execute(original);
    await recorder.execute(original);
    await expect(
      recorder.execute({ ...original, durationMs: 101 }),
    ).rejects.toThrow("telemetry_sample_id_conflict");
  });

  it("rejects an unsigned fully evaluated sample at the recorder boundary", async () => {
    const operations = new InMemoryInvestigationOperations();
    const recorder = new RecordInvestigationTelemetry(operations);

    await expect(
      recorder.execute(
        sample(
          "unsigned-evaluation",
          0,
          0,
          100,
          10,
        ) as unknown as InvestigationTerminalOperationalTelemetrySample,
      ),
    ).rejects.toThrow("telemetry_trusted_evaluation_required");
  });

  it("rejects unknown telemetry enums and additional payload fields", async () => {
    const operations = new InMemoryInvestigationOperations();
    const recorder = new RecordInvestigationTelemetry(operations);
    await expect(
      recorder.execute({
        ...terminalSample("unknown-enum"),
        provider: "future-provider",
      } as unknown as InvestigationTerminalOperationalTelemetrySample),
    ).rejects.toThrow("provider_invalid");
    await expect(
      recorder.execute({
        ...terminalSample("extra-field"),
        rawPrompt: "must-not-survive",
      } as unknown as InvestigationTerminalOperationalTelemetrySample),
    ).rejects.toThrow("telemetry_fields_invalid");
  });

  it("keeps terminal operational telemetry visible but promotion-ineligible", async () => {
    const evaluated = sample("operational", 1, 1, 5_000, 1_000);
    const operational: InvestigationTelemetrySample = {
      ...evaluated,
      source: InvestigationTelemetrySource.Shadow,
      evidenceCompleteness:
        InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
      findingCount: 1,
      expectedDefectCount: null,
      detectedDefectCount: null,
      falseClean: null,
      legacyComparison: InvestigationLegacyComparison.NotCompared,
      capacityWaitMs: null,
      securityViolationCount: null,
    };

    const report = await reportFor([operational]);

    expect(report.body.decision).toBe(InvestigationPromotionDecision.Blocked);
    expect(report.body.metrics).toMatchObject({
      totalSamples: 1,
      fullyEvaluatedSamples: 0,
      terminalOperationalSamples: 1,
      incompleteSamples: 1,
      seededSamples: 0,
      shadowSamples: 0,
      observedFindingCount: 1,
      expectedDefects: 0,
      securityViolationCount: 0,
      p95TotalTokens: null,
      p95DurationMs: null,
      p95CapacityWaitMs: null,
    });
    expect(report.body.blockers).toEqual(
      expect.arrayContaining([
        InvestigationPromotionBlocker.InsufficientSeededSamples,
        InvestigationPromotionBlocker.InsufficientShadowSamples,
      ]),
    );
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
        [InvestigationRolloutCapability.VerifiedClean]: [
          { repositoryConnectionIds: ["repository-1"] },
        ],
        [InvestigationRolloutCapability.CrossRevisionReplay]: [
          { repositoryConnectionIds: ["repository-1"] },
        ],
      },
    });
    const target = {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "scm-repository-1",
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

  it("requires explicit cohorts for effectful and cross-revision capabilities", () => {
    expect(() =>
      createInvestigationRolloutPolicy({
        emergencyDisabled: false,
        enabledCapabilities: [
          InvestigationRolloutCapability.Recording,
          InvestigationRolloutCapability.Shadow,
          InvestigationRolloutCapability.ContextCritic,
          InvestigationRolloutCapability.ProductionEffects,
        ],
      }),
    ).toThrow("rollout_selector_required:production_effects");
  });

  it("requires every dependency cohort to match the same target", () => {
    const policy = createInvestigationRolloutPolicy({
      emergencyDisabled: false,
      enabledCapabilities: [
        InvestigationRolloutCapability.Recording,
        InvestigationRolloutCapability.Shadow,
        InvestigationRolloutCapability.ContextCritic,
        InvestigationRolloutCapability.ProductionEffects,
      ],
      selectors: {
        [InvestigationRolloutCapability.Recording]: [
          { repositoryConnectionIds: ["repository-shadow"] },
        ],
        [InvestigationRolloutCapability.Shadow]: [
          { repositoryConnectionIds: ["repository-shadow"] },
        ],
        [InvestigationRolloutCapability.ContextCritic]: [
          { repositoryConnectionIds: ["repository-shadow"] },
        ],
        [InvestigationRolloutCapability.ProductionEffects]: [
          { repositoryConnectionIds: ["repository-production"] },
        ],
      },
    });

    expect(
      evaluateInvestigationRollout(
        policy,
        InvestigationRolloutCapability.ProductionEffects,
        {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-production",
          scmRepositoryIdentityId: "scm-repository-1",
          provider: InvestigationRolloutProvider.Codex,
          trustDomain: "trusted",
          producerReleaseId: release,
        },
      ),
    ).toBe(InvestigationRolloutDecision.OutsideCohort);
  });

  it("re-reads emergency and cohort policy for every effect decision", async () => {
    const env: Record<string, string | undefined> = {
      [investigationRecordingEnabledEnv]: "1",
      [investigationShadowEnabledEnv]: "1",
      [investigationContextCriticEnabledEnv]: "1",
      [investigationProductionEffectsEnabledEnv]: "1",
      [investigationRolloutSelectorsEnv]: JSON.stringify({
        [InvestigationRolloutCapability.ProductionEffects]: [
          { repositoryConnectionIds: ["repository-1"] },
        ],
      }),
    };
    const resolver = new ResolveInvestigationRollout(
      new EnvironmentInvestigationRolloutPolicyQuery(env),
      { isEmergencyStopped: async () => false },
    );
    const target = {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "scm-repository-1",
      provider: InvestigationRolloutProvider.Codex,
      trustDomain: "trusted",
      producerReleaseId: release,
    };

    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target,
      }),
    ).resolves.toBe(InvestigationRolloutDecision.Allowed);

    env[investigationEmergencyDisabledEnv] = "1";
    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target,
      }),
    ).resolves.toBe(InvestigationRolloutDecision.EmergencyDisabled);
  });

  it("resolves all six target-scoped capabilities from one policy snapshot and emergency check", async () => {
    const readCurrentPolicy = vi.fn(async () =>
      createInvestigationRolloutPolicy({
        emergencyDisabled: false,
        enabledCapabilities: [...Object.values(InvestigationRolloutCapability)],
        selectors: {
          [InvestigationRolloutCapability.CrossRevisionReplay]: [
            { providers: [InvestigationRolloutProvider.Claude] },
          ],
          [InvestigationRolloutCapability.ProductionEffects]: [
            { providers: [InvestigationRolloutProvider.Codex] },
          ],
          [InvestigationRolloutCapability.VerifiedClean]: [
            { providers: [InvestigationRolloutProvider.Codex] },
          ],
        },
      }),
    );
    const isEmergencyStopped = vi.fn(async () => false);
    const resolver = new ResolveInvestigationRollout(
      { readCurrentPolicy },
      { isEmergencyStopped },
    );

    const decisions = await resolver.executeAll({
      target: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        scmRepositoryIdentityId: "scm-repository-1",
        provider: InvestigationRolloutProvider.Codex,
        trustDomain: "trusted",
        producerReleaseId: release,
      },
    });

    expect(readCurrentPolicy).toHaveBeenCalledOnce();
    expect(isEmergencyStopped).toHaveBeenCalledOnce();
    expect(decisions).toEqual({
      [InvestigationRolloutCapability.ContextCritic]:
        InvestigationRolloutDecision.Allowed,
      [InvestigationRolloutCapability.CrossRevisionReplay]:
        InvestigationRolloutDecision.OutsideCohort,
      [InvestigationRolloutCapability.ProductionEffects]:
        InvestigationRolloutDecision.Allowed,
      [InvestigationRolloutCapability.Recording]:
        InvestigationRolloutDecision.Allowed,
      [InvestigationRolloutCapability.Shadow]:
        InvestigationRolloutDecision.Allowed,
      [InvestigationRolloutCapability.VerifiedClean]:
        InvestigationRolloutDecision.Allowed,
    });
  });

  it("resolves every provider row from the same policy and emergency snapshot", async () => {
    const readCurrentPolicy = vi.fn(async () =>
      createInvestigationRolloutPolicy({
        emergencyDisabled: false,
        enabledCapabilities: [...Object.values(InvestigationRolloutCapability)],
        selectors: {
          [InvestigationRolloutCapability.CrossRevisionReplay]: [
            { providers: [InvestigationRolloutProvider.Claude] },
          ],
          [InvestigationRolloutCapability.ProductionEffects]: [
            { providers: [InvestigationRolloutProvider.Codex] },
          ],
          [InvestigationRolloutCapability.VerifiedClean]: [
            { providers: [InvestigationRolloutProvider.Codex] },
          ],
        },
      }),
    );
    const isEmergencyStopped = vi.fn(async () => false);
    const resolver = new ResolveInvestigationRollout(
      { readCurrentPolicy },
      { isEmergencyStopped },
    );
    const common = {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "scm-repository-1",
      trustDomain: "trusted",
      producerReleaseId: release,
    } as const;

    const [codex, claude] = await resolver.executeAllForTargets({
      targets: [
        { ...common, provider: InvestigationRolloutProvider.Codex },
        { ...common, provider: InvestigationRolloutProvider.Claude },
      ],
    });

    expect(readCurrentPolicy).toHaveBeenCalledOnce();
    expect(isEmergencyStopped).toHaveBeenCalledOnce();
    expect(codex?.[InvestigationRolloutCapability.ProductionEffects]).toBe(
      InvestigationRolloutDecision.Allowed,
    );
    expect(codex?.[InvestigationRolloutCapability.CrossRevisionReplay]).toBe(
      InvestigationRolloutDecision.OutsideCohort,
    );
    expect(claude?.[InvestigationRolloutCapability.ProductionEffects]).toBe(
      InvestigationRolloutDecision.OutsideCohort,
    );
    expect(claude?.[InvestigationRolloutCapability.CrossRevisionReplay]).toBe(
      InvestigationRolloutDecision.Allowed,
    );
  });

  it("re-reads shared run-control emergency state without restarting", async () => {
    let stopped = false;
    const resolver = new ResolveInvestigationRollout(
      new EnvironmentInvestigationRolloutPolicyQuery({
        [investigationRecordingEnabledEnv]: "1",
      }),
      new RunControlInvestigationEmergencyStopQuery({
        async findApplicable() {
          return [
            {
              global: true,
              stopped,
            },
          ];
        },
      }),
    );
    const target = {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "scm-repository-1",
      provider: InvestigationRolloutProvider.Codex,
      trustDomain: "trusted",
      producerReleaseId: release,
    };

    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.Recording,
        target,
      }),
    ).resolves.toBe(InvestigationRolloutDecision.Allowed);
    stopped = true;
    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.Recording,
        target,
      }),
    ).resolves.toBe(InvestigationRolloutDecision.EmergencyDisabled);
  });

  it("fails closed when current selector configuration is malformed", async () => {
    const env: Record<string, string | undefined> = {
      [investigationRecordingEnabledEnv]: "1",
      [investigationRolloutSelectorsEnv]: "{not-json",
    };
    const resolver = new ResolveInvestigationRollout(
      new EnvironmentInvestigationRolloutPolicyQuery(env),
      { isEmergencyStopped: async () => false },
    );

    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.Recording,
        target: {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-1",
          scmRepositoryIdentityId: "scm-repository-1",
          provider: InvestigationRolloutProvider.Codex,
          trustDomain: "trusted",
          producerReleaseId: release,
        },
      }),
    ).resolves.toBe(InvestigationRolloutDecision.Unavailable);
  });

  it("fails closed when the emergency toggle is malformed", async () => {
    const resolver = new ResolveInvestigationRollout(
      new EnvironmentInvestigationRolloutPolicyQuery({
        [investigationRecordingEnabledEnv]: "1",
        [investigationEmergencyDisabledEnv]: "true",
      }),
      { isEmergencyStopped: async () => false },
    );

    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.Recording,
        target: {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-1",
          scmRepositoryIdentityId: "scm-repository-1",
          provider: InvestigationRolloutProvider.Codex,
          trustDomain: "trusted",
          producerReleaseId: release,
        },
      }),
    ).resolves.toBe(InvestigationRolloutDecision.Unavailable);
  });

  it("rejects ambiguous empty cohort selectors", async () => {
    const resolver = new ResolveInvestigationRollout(
      new EnvironmentInvestigationRolloutPolicyQuery({
        [investigationRecordingEnabledEnv]: "1",
        [investigationRolloutSelectorsEnv]: JSON.stringify({
          [InvestigationRolloutCapability.Recording]: [
            { repositoryConnectionIds: [] },
          ],
        }),
      }),
      { isEmergencyStopped: async () => false },
    );

    await expect(
      resolver.execute({
        capability: InvestigationRolloutCapability.Recording,
        target: {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-1",
          scmRepositoryIdentityId: "scm-repository-1",
          provider: InvestigationRolloutProvider.Codex,
          trustDomain: "trusted",
          producerReleaseId: release,
        },
      }),
    ).resolves.toBe(InvestigationRolloutDecision.Unavailable);
  });
});

async function reportFor(
  samples: readonly InvestigationTelemetrySample[],
  profile: InvestigationPromotionTrustProfile = trustProfile,
) {
  const operations = new InMemoryInvestigationOperations();
  const recorder = new RecordInvestigationTelemetry(operations);
  for (const item of samples) {
    if (isFullyEvaluatedTelemetrySample(item)) {
      operations.seedFullyEvaluatedTelemetrySample(item, evidenceFor(item));
    } else {
      await recorder.execute(item);
    }
  }
  return new GenerateInvestigationPromotionReport(
    promotionPolicies(profile),
    operations,
    digest,
  ).execute({
    generatedAt,
    producerReleaseId: release,
    profile: profileIdentity,
  });
}

function promotionPolicies(
  profile: InvestigationPromotionTrustProfile = trustProfile,
  configuredThresholds: InvestigationPromotionThresholds = thresholds,
): ConfiguredInvestigationPromotionPolicyRegistry {
  return new ConfiguredInvestigationPromotionPolicyRegistry([
    {
      identity: profileIdentity,
      trustProfile: profile,
      thresholds: configuredThresholds,
    },
  ]);
}

function sample(
  id: string,
  expectedDefectCount: number,
  detectedDefectCount: number,
  durationMs: number,
  totalTokens: number,
  overrides: Partial<InvestigationFullyEvaluatedTelemetrySample> = {},
): InvestigationFullyEvaluatedTelemetrySample {
  return {
    sampleId: `evaluated-${sha(id)}`,
    collectedAt: "2026-08-02T12:00:00.000Z",
    source: InvestigationTelemetrySource.DisposableFixture,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated,
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
    findingCount: detectedDefectCount,
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

function promotionTrustProfile(
  acceptedKeyIds: readonly string[] = ["key-current"],
): InvestigationPromotionTrustProfile {
  return {
    profileVersion: InvestigationPromotionTrustProfileVersion.V1,
    corpusVersion: "corpus.v1",
    groundTruthSetHash: sha("ground-truth.v1"),
    evaluationPolicyVersion: "evaluation-policy.v1",
    freshness: {
      policy:
        InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
      issuedAtOrAfter: "2026-08-01T00:00:00.000Z",
    },
    signingKeys: {
      policy: InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
      lineageId: "evaluation-lineage",
      policyVersion: "evaluation-lineage-policy.v1",
      signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
      acceptedKeyIds,
    },
  };
}

function evidenceFor(
  sample: InvestigationFullyEvaluatedTelemetrySample,
  overrides: Partial<InvestigationPromotionEvaluationEvidence> = {},
): InvestigationPromotionEvaluationEvidence {
  return {
    attestationVersion: InvestigationEvaluationAttestationVersion.V1,
    attestationHash: sample.sampleId.slice("evaluated-".length),
    derivedSampleId: sample.sampleId,
    producerReleaseId: sample.producerReleaseId,
    corpusVersion: trustProfile.corpusVersion,
    groundTruthSetHash: trustProfile.groundTruthSetHash,
    evaluationPolicyVersion: trustProfile.evaluationPolicyVersion,
    issuedAt: "2026-08-02T10:00:00.000Z",
    expiresAt: "2026-08-03T12:00:00.000Z",
    signingKeyId: "key-current",
    signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
    ...overrides,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function terminalSample(
  id: string,
): InvestigationTerminalOperationalTelemetrySample {
  const evaluated = sample(id, 0, 0, 100, 10);
  return {
    ...evaluated,
    source: InvestigationTelemetrySource.Shadow,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
    expectedDefectCount: null,
    detectedDefectCount: null,
    falseClean: null,
    legacyComparison: InvestigationLegacyComparison.NotCompared,
    capacityWaitMs: null,
    securityViolationCount: null,
  };
}
