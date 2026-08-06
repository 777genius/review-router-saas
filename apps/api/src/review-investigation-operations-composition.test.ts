import { createHash, generateKeyPairSync } from "node:crypto";
import { contextGatewayV4PolicyVersion } from "@reviewrouter/features-review-context-attestation";
import {
  canonicalInvestigationScope,
  ContextCriticDecision,
  InvestigationTurnProviderKind,
  ReviewInvestigationConclusion,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  type ReviewInvestigation,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationLegacyComparison,
  InvestigationEvaluationSignatureAlgorithm,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustProfileVersion,
  type InvestigationTerminalOperationalTelemetrySample,
} from "@reviewrouter/features-review-investigation-operations";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it, vi } from "vitest";
import {
  composePrismaReviewInvestigationOperations,
  composePrismaReviewInvestigationTerminalTelemetry,
  ReviewInvestigationOperationsDiagnosticCode,
  StoredReviewInvestigationTerminalTelemetrySamples,
} from "./review-investigation-operations-composition.js";
import { ReviewInvestigationOperatorOperation } from "./review-investigation-operator-routes.js";

const credential = "operations-composition-credential-with-32-characters";
const promotionCredential = "promotion-composition-credential-with-32-chars";
const importCredential = "evaluation-import-composition-credential-32";
const digest = "a".repeat(64);
const collectedAt = "2026-08-03T12:00:00.000Z";
const terminalScope = Object.freeze({
  workspaceId: "workspace-terminal",
  repositoryConnectionId: "repository-terminal",
  scmRepositoryIdentityId: "scm-terminal",
  pullRequestNumber: 42,
  trustDomain: "github-actions-oidc",
  authorizationScopeHash: digest,
});
const terminalScopeHash = createHash("sha256")
  .update(canonicalInvestigationScope(terminalScope))
  .digest("hex");

function fakePrisma() {
  const prisma = {
    producerRelease: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ producerReleaseId: "release-registered" }]),
    },
    reviewInvestigation: {
      findUnique: vi.fn().mockResolvedValue({
        investigationId: "investigation-1",
        authorizationScopeHash: digest,
        reviewRevisionHash: digest,
        state: "awaiting_turn",
        version: 4n,
        activeTurnId: null,
        nextEligibleAt: null,
        conclusion: null,
        certificateId: null,
        producerReleaseId: "release-registered",
        gatewayPolicyVersion: contextGatewayV4PolicyVersion,
        updatedAt: new Date(collectedAt),
      }),
    },
    reviewInvestigationObligation: {
      groupBy: vi.fn().mockResolvedValue([
        { state: "open", _count: { _all: 2 } },
        { state: "satisfied", _count: { _all: 3 } },
      ]),
    },
    reviewInvestigationTurn: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    reviewInvestigationTelemetrySample: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
    },
    reviewInvestigationPromotionReport: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
  return Object.assign(prisma, {
    $transaction: vi.fn(async (work: (transaction: unknown) => unknown) =>
      work({
        ...prisma,
        $queryRaw: vi.fn().mockResolvedValue([]),
      }),
    ),
  });
}

const { publicKey: evaluationPublicKey } = generateKeyPairSync("ed25519");

function evaluationPublicKeysJson() {
  return JSON.stringify([
    {
      keyId: "evaluation-key-current",
      publicKeySpkiBase64: evaluationPublicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      notBefore: "2026-08-01T00:00:00.000Z",
      verifyUntil: null,
    },
  ]);
}

function promotionPolicyProfilesJson() {
  return JSON.stringify([
    {
      identity: { id: "production", version: "2026-08.v1" },
      trustProfile: {
        profileVersion: InvestigationPromotionTrustProfileVersion.V1,
        corpusVersion: "corpus.v1",
        groundTruthSetHash: digest,
        evaluationPolicyVersion: "evaluation-policy.v1",
        freshness: {
          policy:
            InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
          issuedAtOrAfter: "2026-08-03T00:00:00.000Z",
        },
        signingKeys: {
          policy:
            InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
          lineageId: "evaluation-lineage",
          policyVersion: "evaluation-lineage-policy.v1",
          signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
          acceptedKeyIds: ["evaluation-key-current"],
        },
      },
      thresholds: {
        minSeededSamples: 1,
        minShadowSamples: 1,
        maxUnexplainedDisagreements: 0,
        maxP95TotalTokens: 20_000,
        maxP95DurationMs: 120_000,
      },
    },
  ]);
}

function sample(): InvestigationTerminalOperationalTelemetrySample {
  return {
    sampleId: "terminal-sample-1",
    collectedAt,
    source: InvestigationTelemetrySource.Shadow,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
    repositoryScopeHash: digest,
    reviewRevisionHash: digest,
    stableReviewUnitHash: digest,
    producerReleaseId: "release-registered",
    provider: InvestigationTelemetryProvider.Codex,
    actualModel: "gpt-5.6",
    conclusion: InvestigationTelemetryConclusion.Findings,
    findingCount: 1,
    expectedDefectCount: null,
    detectedDefectCount: null,
    falseClean: null,
    legacyComparison: InvestigationLegacyComparison.NotCompared,
    replayOutcome: InvestigationReplayOutcome.NotAttempted,
    failure: InvestigationOperationalFailure.None,
    semanticTurns: 2,
    criticCycles: 1,
    gatewayOperations: 7,
    promptTokens: 100,
    completionTokens: 30,
    totalTokens: 130,
    durationMs: 5_000,
    timeToFirstFindingMs: 2_000,
    capacityWaitMs: null,
    protocolBytes: 2_048,
    retainedBytes: 4_096,
    securityViolationCount: null,
  };
}

describe("review investigation operations production composition", () => {
  it("composes authenticated status, immutable reports, and telemetry over Prisma", async () => {
    const prisma = fakePrisma();
    const composition = composePrismaReviewInvestigationOperations({
      prisma: prisma as unknown as PrismaClient,
      operatorCredentialSha256: createHash("sha256")
        .update(credential)
        .digest("hex"),
      promotionCredentialSha256: createHash("sha256")
        .update(promotionCredential)
        .digest("hex"),
      evaluationPublicKeysJson: evaluationPublicKeysJson(),
      promotionPolicyProfilesJson: promotionPolicyProfilesJson(),
      now: () => new Date(collectedAt),
    });

    await expect(
      composition.operatorRoutes.authorization.authenticate({
        credential,
        operation: ReviewInvestigationOperatorOperation.ReadStatus,
      }),
    ).resolves.toBe(true);
    await expect(
      composition.operatorRoutes.authorization.authenticate({
        credential: "wrong-credential-with-at-least-32-characters",
        operation: ReviewInvestigationOperatorOperation.ReadStatus,
      }),
    ).resolves.toBe(false);
    await expect(
      composition.operatorRoutes.authorization.authenticate({
        credential,
        operation: ReviewInvestigationOperatorOperation.GeneratePromotionReport,
      }),
    ).resolves.toBe(false);
    await expect(
      composition.operatorRoutes.authorization.authenticate({
        credential: promotionCredential,
        operation: ReviewInvestigationOperatorOperation.GeneratePromotionReport,
      }),
    ).resolves.toBe(true);

    const status =
      await composition.operatorRoutes.status.execute("investigation-1");
    expect(status).toMatchObject({
      compatibility: "compatible",
      openObligationCount: 2,
      nextAction: "run_turn",
      protocolVersion: "2",
    });

    const report = await composition.operatorRoutes.promotionReports!.execute({
      producerReleaseId: "release-registered",
      profile: { id: "production", version: "2026-08.v1" },
    });
    expect(report.body.decision).toBe("blocked");
    expect(report.body.trustProfile).toMatchObject({
      corpusVersion: "corpus.v1",
      groundTruthSetHash: digest,
      evaluationPolicyVersion: "evaluation-policy.v1",
    });
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      prisma.reviewInvestigationPromotionReport.upsert,
    ).toHaveBeenCalledOnce();

    await composition.telemetry.record(sample());
    expect(
      prisma.reviewInvestigationTelemetrySample.create,
    ).toHaveBeenCalledOnce();
    const telemetryWrite =
      prisma.reviewInvestigationTelemetrySample.create.mock.calls[0]?.[0];
    expect(JSON.stringify(telemetryWrite)).not.toMatch(
      /promptText|sourceCode|searchQuery|secret/iu,
    );
  });

  it("exposes evaluation import only with its own credential and a valid key ring", async () => {
    const prisma = fakePrisma();
    const composition = composePrismaReviewInvestigationOperations({
      prisma: prisma as unknown as PrismaClient,
      operatorCredentialSha256: createHash("sha256")
        .update(credential)
        .digest("hex"),
      evaluationImportCredentialSha256: createHash("sha256")
        .update(importCredential)
        .digest("hex"),
      evaluationPublicKeysJson: evaluationPublicKeysJson(),
      now: () => new Date(collectedAt),
    });

    expect(composition.operatorRoutes.evaluationImports).toBeDefined();
    await expect(
      composition.operatorRoutes.authorization.authenticate({
        credential: importCredential,
        operation: ReviewInvestigationOperatorOperation.ImportEvaluation,
      }),
    ).resolves.toBe(true);
    await expect(
      composition.operatorRoutes.authorization.authenticate({
        credential: importCredential,
        operation: ReviewInvestigationOperatorOperation.GeneratePromotionReport,
      }),
    ).resolves.toBe(false);
    expect(() =>
      composePrismaReviewInvestigationOperations({
        prisma: prisma as unknown as PrismaClient,
        operatorCredentialSha256: createHash("sha256")
          .update(credential)
          .digest("hex"),
        evaluationImportCredentialSha256: createHash("sha256")
          .update(importCredential)
          .digest("hex"),
        evaluationPublicKeysJson: "[]",
      }),
    ).toThrow("evaluation_verification_key_count_invalid");
    expect(() =>
      composePrismaReviewInvestigationOperations({
        prisma: prisma as unknown as PrismaClient,
        operatorCredentialSha256: createHash("sha256")
          .update(credential)
          .digest("hex"),
        promotionCredentialSha256: createHash("sha256")
          .update(importCredential)
          .digest("hex"),
        evaluationImportCredentialSha256: createHash("sha256")
          .update(importCredential)
          .digest("hex"),
        evaluationPublicKeysJson: evaluationPublicKeysJson(),
        promotionPolicyProfilesJson: promotionPolicyProfilesJson(),
      }),
    ).toThrow("investigation_operator_credential_separation_required");
  });

  it("records a typed terminal sample and emits only fixed diagnostics on gaps", async () => {
    const prisma = fakePrisma();
    const diagnostics = { record: vi.fn() };
    const samples = {
      findTerminalSample: vi.fn().mockResolvedValue({
        investigationId: "investigation-1",
        sample: sample(),
      }),
    };
    const terminal = composePrismaReviewInvestigationTerminalTelemetry({
      prisma: prisma as unknown as PrismaClient,
      samples,
      diagnostics,
    });

    await terminal.recordConcluded({ investigationId: "investigation-1" });

    expect(samples.findTerminalSample).toHaveBeenCalledWith({
      investigationId: "investigation-1",
    });
    expect(
      prisma.reviewInvestigationTelemetrySample.create,
    ).toHaveBeenCalledOnce();
    expect(diagnostics.record).not.toHaveBeenCalled();

    samples.findTerminalSample.mockResolvedValueOnce(null);
    await terminal.recordConcluded({ investigationId: "investigation-2" });
    expect(diagnostics.record).toHaveBeenLastCalledWith(
      ReviewInvestigationOperationsDiagnosticCode.TerminalTelemetrySampleUnavailable,
    );
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain(
      "investigation-2",
    );

    samples.findTerminalSample.mockResolvedValueOnce({
      investigationId: "investigation-3",
      sample: { ...sample(), actualModel: "unsafe model metadata" },
    });
    await terminal.recordConcluded({ investigationId: "investigation-3" });
    expect(
      prisma.reviewInvestigationTelemetrySample.create,
    ).toHaveBeenCalledOnce();
    expect(diagnostics.record).toHaveBeenLastCalledWith(
      ReviewInvestigationOperationsDiagnosticCode.TerminalTelemetryRecordFailed,
    );
  });

  it("maps a concluded aggregate to truthful operational telemetry", async () => {
    const investigation = terminalInvestigation();
    const samples = new StoredReviewInvestigationTerminalTelemetrySamples(
      { findById: vi.fn().mockResolvedValue(investigation) },
      {
        resolveSource: vi
          .fn()
          .mockResolvedValue(InvestigationTelemetrySource.Shadow),
      },
    );

    const terminal = await samples.findTerminalSample({
      investigationId: investigation.investigationId,
    });

    expect(terminal).toEqual({
      investigationId: "investigation-terminal",
      sample: {
        sampleId: `terminal-${"b".repeat(64)}`,
        collectedAt,
        source: InvestigationTelemetrySource.Shadow,
        evidenceCompleteness:
          InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
        repositoryScopeHash: terminalScopeHash,
        reviewRevisionHash: "c".repeat(64),
        stableReviewUnitHash: createHash("sha256")
          .update("unit-terminal")
          .digest("hex"),
        producerReleaseId: "release-registered",
        provider: InvestigationTelemetryProvider.Codex,
        actualModel: "gpt-5.6",
        conclusion: InvestigationTelemetryConclusion.Findings,
        findingCount: 1,
        expectedDefectCount: null,
        detectedDefectCount: null,
        falseClean: null,
        legacyComparison: InvestigationLegacyComparison.NotCompared,
        replayOutcome: InvestigationReplayOutcome.Unknown,
        failure: InvestigationOperationalFailure.None,
        semanticTurns: 1,
        criticCycles: 0,
        gatewayOperations: 2,
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        durationMs: 1_000,
        timeToFirstFindingMs: null,
        capacityWaitMs: null,
        protocolBytes: Buffer.byteLength('{"findings":1}', "utf8"),
        retainedBytes: null,
        securityViolationCount: null,
      },
    });
  });

  it("uses the internal stored sample producer and appends idempotently", async () => {
    const prisma = fakePrisma();
    const diagnostics = { record: vi.fn() };
    const investigations = {
      findById: vi.fn().mockResolvedValue(terminalInvestigation()),
    };
    const terminal = composePrismaReviewInvestigationTerminalTelemetry({
      prisma: prisma as unknown as PrismaClient,
      investigations,
      diagnostics,
    });

    await terminal.recordConcluded({
      investigationId: "investigation-terminal",
    });
    const firstWrite =
      prisma.reviewInvestigationTelemetrySample.create.mock.calls[0]?.[0];
    prisma.reviewInvestigationTelemetrySample.findUnique.mockResolvedValueOnce({
      payloadHash: firstWrite?.data.payloadHash,
    });
    await terminal.recordConcluded({
      investigationId: "investigation-terminal",
    });

    expect(investigations.findById).toHaveBeenCalledTimes(2);
    expect(
      prisma.reviewInvestigationTelemetrySample.create,
    ).toHaveBeenCalledOnce();
    expect(diagnostics.record).not.toHaveBeenCalled();
  });
});

function terminalInvestigation(): ReviewInvestigation {
  const provenance = {
    turnId: "turn-discovery",
    purpose: ReviewInvestigationTurnPurpose.Discovery,
    actualProviderKind: InvestigationTurnProviderKind.Codex,
    actualModel: "gpt-5.6",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    inputTokens: 100,
    cachedInputTokens: 25,
    outputTokens: 10,
    reasoningOutputTokens: 5,
    totalTokens: 110,
    durationMs: 1_000,
    acceptedAttestationId: "attestation-discovery",
    acceptedAttestationHash: "d".repeat(64),
    terminalOutcomeHash: "e".repeat(64),
  } as const;
  return {
    investigationId: "investigation-terminal",
    scope: terminalScope,
    revision: { reviewRevisionHash: "c".repeat(64) },
    stableReviewUnitKey: "unit-terminal",
    contract: { producerReleaseId: "release-registered" },
    state: ReviewInvestigationState.Concluded,
    obligations: [
      {
        receipt: {
          operationReceiptIds: ["1".repeat(64), "2".repeat(64), "1".repeat(64)],
          replayProofId: null,
        },
      },
    ],
    findings: [{ fingerprint: "finding-1" }],
    semanticTurns: 1,
    criticCycles: 0,
    totalUsageTokens: 110,
    totalDurationMs: 1_000,
    turnProvenance: [provenance],
    conclusion: ReviewInvestigationConclusion.Findings,
    certificate: {
      certificateHash: "b".repeat(64),
      investigationId: "investigation-terminal",
      reviewRevisionHash: "c".repeat(64),
      stableReviewUnitKey: "unit-terminal",
      scopeHash: terminalScopeHash,
      producerReleaseId: "release-registered",
      terminalProviderKind: InvestigationTurnProviderKind.Codex,
      terminalActualModel: "gpt-5.6",
      conclusion: ReviewInvestigationConclusion.Findings,
      terminalObservationCanonicalJson: '{"findings":1}',
      issuedAt: collectedAt,
      criticDecision: ContextCriticDecision.Accept,
    },
  } as unknown as ReviewInvestigation;
}
