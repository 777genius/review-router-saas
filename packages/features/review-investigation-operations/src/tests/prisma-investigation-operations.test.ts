import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  InvestigationPromotionTelemetryReadStatus,
  maximumInvestigationPromotionTelemetrySamples,
  type InvestigationEvaluationSignatureVerifierPort,
} from "../application/ports/operations-ports";
import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationSignatureAlgorithm,
  canonicalEvaluationJson,
  deriveFullyEvaluatedTelemetrySample,
  type InvestigationEvaluationRecord,
  type InvestigationEvaluationAttestationPayload,
} from "../domain/investigation-evaluation";
import { GenerateInvestigationPromotionReport } from "../application/use-cases/generate-investigation-promotion-report";
import {
  InvestigationLegacyComparison,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
} from "../domain/investigation-telemetry";
import {
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustErrorCode,
  InvestigationPromotionTrustProfileVersion,
  type InvestigationPromotionTrustProfile,
} from "../domain/promotion-trust-profile";
import { PrismaInvestigationEvaluationRepository } from "../infrastructure/prisma/prisma-investigation-evaluation-repository";
import { PrismaInvestigationOperations } from "../infrastructure/prisma/prisma-investigation-operations";
import { ConfiguredEd25519InvestigationEvaluationVerifier } from "../infrastructure/crypto/configured-ed25519-investigation-evaluation-verifier";
import { ConfiguredInvestigationPromotionPolicyRegistry } from "../infrastructure/environment/configured-investigation-promotion-policy-registry";

const validAt = "2026-08-03T12:00:00.000Z";
const trustProfile = Object.freeze({
  profileVersion: InvestigationPromotionTrustProfileVersion.V1,
  corpusVersion: "corpus.v1",
  groundTruthSetHash: sha("ground-truth.v1"),
  evaluationPolicyVersion: "evaluation-policy.v1",
  freshness: {
    policy:
      InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
    issuedAtOrAfter: "2026-08-03T11:00:00.000Z",
  },
  signingKeys: {
    policy: InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
    lineageId: "evaluator-lineage",
    policyVersion: "evaluator-lineage-policy.v1",
    signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
    acceptedKeyIds: ["evaluator-key-current"],
  },
}) satisfies InvestigationPromotionTrustProfile;

describe("PrismaInvestigationOperations promotion telemetry", () => {
  it("retries the complete snapshot/build/save unit after a serialization conflict", async () => {
    const reportCanonicalJson = canonicalEvaluationJson({
      producerReleaseId: "release-1",
      generatedAt: validAt,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      reviewInvestigationTelemetrySample: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      reviewInvestigationEvaluationAttestation: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      reviewInvestigationPromotionReport: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };
    let attempt = 0;
    const prisma = {
      $transaction: vi.fn(async (work) => {
        const result = await work(transaction);
        attempt += 1;
        if (attempt === 1) {
          throw new Prisma.PrismaClientKnownRequestError(
            "serialization conflict",
            { code: "P2034", clientVersion: "test" },
          );
        }
        return result;
      }),
    };
    const operations = new PrismaInvestigationOperations(prisma as never, {
      currentProtocolVersion: "review-action-v2",
      supportedGatewayPolicyVersions: new Set(),
      acceptedProducerReleaseIds: new Set(),
    });
    const build = vi.fn(async () => ({
      result: "committed",
      reportCanonicalJson,
      reportHash: sha(reportCanonicalJson),
    }));

    await expect(
      operations.withPromotionSnapshot(promotionReadInput(), build),
    ).resolves.toBe("committed");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(
      transaction.reviewInvestigationTelemetrySample.findMany,
    ).toHaveBeenCalledTimes(2);
    expect(
      transaction.reviewInvestigationPromotionReport.upsert,
    ).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("uses a deterministic max-plus-one query and reports an oversized set", async () => {
    const findMany = vi.fn().mockResolvedValue(
      Array.from(
        { length: maximumInvestigationPromotionTelemetrySamples + 1 },
        (_, index) => ({
          sampleId: `sample-${index}`,
          producerReleaseId: "release-1",
          payload: {},
          payloadHash: "0".repeat(64),
        }),
      ),
    );
    const operations = createOperations(findMany);

    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).resolves.toEqual({
      status: InvestigationPromotionTelemetryReadStatus.TooLarge,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { producerReleaseId: "release-1" },
      orderBy: { sampleId: "asc" },
      take: maximumInvestigationPromotionTelemetrySamples + 1,
      select: {
        sampleId: true,
        producerReleaseId: true,
        payload: true,
        payloadHash: true,
      },
    });
  });

  it("returns a frozen complete empty set", async () => {
    const operations = createOperations(vi.fn().mockResolvedValue([]));

    const result =
      await operations.readPromotionSampleSet(promotionReadInput());

    expect(result).toEqual({
      status: InvestigationPromotionTelemetryReadStatus.Complete,
      samples: [],
    });
    if (result.status === InvestigationPromotionTelemetryReadStatus.Complete) {
      expect(Object.isFrozen(result.samples)).toBe(true);
    }
  });

  it("rejects a fully evaluated row without its trusted attestation record", async () => {
    const fixture = evaluationFixture();
    const operations = createOperations(
      vi.fn().mockResolvedValue([fixture.telemetryRow]),
      vi.fn().mockResolvedValue([]),
    );

    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
    });
  });

  it("returns evaluated rows only through a bounded, fully bound attestation read", async () => {
    const fixture = evaluationFixture();
    const evaluationFindMany = vi
      .fn()
      .mockResolvedValue([fixture.attestationRow]);
    const verify = vi.fn().mockResolvedValue(true);
    const operations = createOperations(
      vi.fn().mockResolvedValue([fixture.telemetryRow]),
      evaluationFindMany,
      { verify },
    );

    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).resolves.toEqual({
      status: InvestigationPromotionTelemetryReadStatus.Complete,
      samples: [fixture.sample],
    });
    expect(evaluationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { derivedSampleId: { in: [fixture.sample.sampleId] } },
        orderBy: { derivedSampleId: "asc" },
        take: 2,
        select: expect.objectContaining({
          attestationHash: true,
          corpusVersion: true,
          evaluationPolicyVersion: true,
          payloadCanonicalJson: true,
          payload: true,
          signingKeyId: true,
        }),
      }),
    );
    expect(verify).toHaveBeenCalledWith({
      algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
      keyId: "evaluator-key-current",
      payloadCanonicalJson: fixture.attestationRow.payloadCanonicalJson,
      signature: "A".repeat(86),
      issuedAt: fixture.attestationRow.payload.issuedAt,
      now: new Date(validAt),
    });
  });

  it("rejects a shape-valid dummy signature during promotion reverification", async () => {
    const fixture = evaluationFixture();
    const { publicKey } = generateKeyPairSync("ed25519");
    const verifier = new ConfiguredEd25519InvestigationEvaluationVerifier([
      {
        keyId: "evaluator-key-current",
        publicKeySpkiBase64: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
        notBefore: "2026-08-03T00:00:00.000Z",
        verifyUntil: "2026-08-04T00:00:00.000Z",
      },
    ]);
    const operations = createOperations(
      vi.fn().mockResolvedValue([fixture.telemetryRow]),
      vi.fn().mockResolvedValue([fixture.attestationRow]),
      verifier,
    );

    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
    });
  });

  it("honors key verifyUntil when reverifying a valid stored signature", async () => {
    const fixture = evaluationFixture();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signatureValue = sign(
      null,
      Buffer.from(fixture.attestationRow.payloadCanonicalJson, "utf8"),
      privateKey,
    ).toString("base64url");
    const signature = {
      algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
      keyId: "evaluator-key-current",
      value: signatureValue,
    } as const;
    const attestation = {
      ...fixture.attestationRow,
      signatureValue,
      envelopeHash: sha(
        canonicalEvaluationJson({
          payload: fixture.attestationRow.payload,
          signature,
        }),
      ),
    };
    const verifier = new ConfiguredEd25519InvestigationEvaluationVerifier([
      {
        keyId: signature.keyId,
        publicKeySpkiBase64: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
        notBefore: "2026-08-03T00:00:00.000Z",
        verifyUntil: validAt,
      },
    ]);
    const operations = createOperations(
      vi.fn().mockResolvedValue([fixture.telemetryRow]),
      vi.fn().mockResolvedValue([attestation]),
      verifier,
    );

    await expect(
      operations.readPromotionSampleSet({
        ...promotionReadInput(),
        validAt: "2026-08-03T11:59:59.999Z",
      }),
    ).resolves.toMatchObject({
      status: InvestigationPromotionTelemetryReadStatus.Complete,
    });
    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
    });
  });

  it("holds the release lock through report save before a concurrent evaluation import", async () => {
    const fixture = evaluationCommitFixture();
    const reportReadStarted = deferred<void>();
    const continueReportRead = deferred<void>();
    const importLockAttempted = deferred<void>();
    const acquireLock = serialMutex();
    const events: string[] = [];
    const lockKeys: unknown[] = [];
    const telemetry = new Map([
      [
        fixture.terminal.sampleId,
        {
          sampleId: fixture.terminal.sampleId,
          producerReleaseId: fixture.terminal.producerReleaseId,
          payload: fixture.terminal,
          payloadHash: sha(canonicalEvaluationJson(fixture.terminal)),
        },
      ],
    ]);
    const transactionLevels: unknown[] = [];
    let lockAttempts = 0;
    const persistence = {
      $transaction: vi.fn(async (work, options) => {
        transactionLevels.push(options?.isolationLevel);
        let release: (() => void) | undefined;
        const transaction = {
          $queryRaw: vi.fn(async (_query, lockKey) => {
            lockKeys.push(lockKey);
            lockAttempts += 1;
            if (lockAttempts === 2) importLockAttempted.resolve();
            release = await acquireLock();
            return [];
          }),
          reviewInvestigationTelemetrySample: {
            findMany: vi.fn(async () => {
              const snapshot = [...telemetry.values()];
              events.push("report-read");
              reportReadStarted.resolve();
              await continueReportRead.promise;
              return snapshot;
            }),
            findUnique: vi.fn(
              async ({ where }) => telemetry.get(where.sampleId) ?? null,
            ),
            create: vi.fn(async ({ data }) => {
              events.push("evaluation-sample-create");
              telemetry.set(data.sampleId, {
                sampleId: data.sampleId,
                producerReleaseId: data.producerReleaseId,
                payload: data.payload,
                payloadHash: data.payloadHash,
              });
            }),
          },
          reviewInvestigationEvaluationAttestation: {
            findMany: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn(async () => {
              events.push("evaluation-attestation-create");
            }),
          },
          reviewInvestigationPromotionReport: {
            upsert: vi.fn(async () => {
              events.push("report-save");
            }),
          },
          reviewInvestigationCertificate: {
            findUnique: vi.fn().mockResolvedValue(fixture.certificate),
          },
        };
        try {
          return await work(transaction);
        } finally {
          release?.();
        }
      }),
      reviewInvestigationTelemetrySample: {
        findUnique: vi.fn(
          async ({ where }) => telemetry.get(where.sampleId) ?? null,
        ),
      },
      reviewInvestigationEvaluationAttestation: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const signatures = { verify: vi.fn().mockResolvedValue(true) };
    const operations = new PrismaInvestigationOperations(
      persistence as never,
      {
        currentProtocolVersion: "review-action-v2",
        supportedGatewayPolicyVersions: new Set(),
        acceptedProducerReleaseIds: new Set(),
      },
      signatures,
    );
    const reportUseCase = new GenerateInvestigationPromotionReport(
      new ConfiguredInvestigationPromotionPolicyRegistry([
        {
          identity: { id: "production", version: "2026-08.v1" },
          trustProfile,
          thresholds: {
            minSeededSamples: 1,
            minShadowSamples: 1,
            maxUnexplainedDisagreements: 0,
            maxP95TotalTokens: 10_000,
            maxP95DurationMs: 60_000,
          },
        },
      ]),
      operations,
      { digestUtf8: async (value) => sha(value) },
    );
    const repository = new PrismaInvestigationEvaluationRepository(
      persistence as never,
      {
        signatures,
        clock: { now: () => new Date(validAt) },
      },
    );

    const reportPromise = reportUseCase.execute({
      generatedAt: validAt,
      producerReleaseId: "release-1",
      profile: { id: "production", version: "2026-08.v1" },
    });
    await reportReadStarted.promise;
    const importPromise = repository.commit({
      record: fixture.record,
      derivedSample: fixture.derived,
    });
    await importLockAttempted.promise;

    expect(events).toEqual(["report-read"]);
    continueReportRead.resolve();
    const report = await reportPromise;
    await importPromise;

    expect(report.body.metrics).toMatchObject({
      totalSamples: 1,
      fullyEvaluatedSamples: 0,
      terminalOperationalSamples: 1,
    });
    expect(events).toEqual([
      "report-read",
      "report-save",
      "evaluation-sample-create",
      "evaluation-attestation-create",
    ]);
    expect(transactionLevels).toEqual(["ReadCommitted", "ReadCommitted"]);
    expect(lockKeys).toEqual([
      "review-investigation-promotion:release-1",
      "review-investigation-promotion:release-1",
    ]);
  });

  it.each([
    ["corpus", { corpusVersion: "corpus.other" }],
    ["ground truth", { groundTruthSetHash: "f".repeat(64) }],
    ["evaluation policy", { evaluationPolicyVersion: "policy.other" }],
    ["signing key", { signingKeyId: "evaluator-key-retired" }],
  ])(
    "rejects a release containing mixed %s attestations",
    async (_label, change) => {
      const approved = evaluationFixture({}, "approved");
      const mismatched = evaluationFixture(change, "mismatched");
      const operations = createOperations(
        vi
          .fn()
          .mockResolvedValue([approved.telemetryRow, mismatched.telemetryRow]),
        vi
          .fn()
          .mockResolvedValue([
            approved.attestationRow,
            mismatched.attestationRow,
          ]),
      );

      await expect(
        operations.readPromotionSampleSet(promotionReadInput()),
      ).rejects.toMatchObject({
        code: InvestigationPromotionTrustErrorCode.EvaluationTrustMismatch,
      });
    },
  );

  it("rejects evidence older than the selected freshness epoch", async () => {
    const stale = evaluationFixture(
      { issuedAt: "2026-08-03T10:59:59.999Z" },
      "stale",
    );
    const operations = createOperations(
      vi.fn().mockResolvedValue([stale.telemetryRow]),
      vi.fn().mockResolvedValue([stale.attestationRow]),
    );

    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationEvidenceStale,
    });
  });

  it("rejects persisted payload drift even when indexed columns still match", async () => {
    const fixture = evaluationFixture();
    const operations = createOperations(
      vi.fn().mockResolvedValue([fixture.telemetryRow]),
      vi.fn().mockResolvedValue([
        {
          ...fixture.attestationRow,
          payload: {
            ...fixture.attestationRow.payload,
            evaluationPolicyVersion: "tampered-policy",
          },
        },
      ]),
    );

    await expect(
      operations.readPromotionSampleSet(promotionReadInput()),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
    });
  });

  it("loads a terminal sample with its independently persisted certificate", async () => {
    const certificateHash = sha("certificate");
    const terminal = {
      sampleId: `terminal-${certificateHash}`,
      collectedAt: validAt,
      source: InvestigationTelemetrySource.Shadow,
      evidenceCompleteness:
        InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
      repositoryScopeHash: sha("scope"),
      reviewRevisionHash: sha("revision"),
      stableReviewUnitHash: sha("unit"),
      producerReleaseId: "release-1",
      provider: InvestigationTelemetryProvider.Codex,
      actualModel: "gpt-5.6",
      conclusion: InvestigationTelemetryConclusion.VerifiedClean,
      findingCount: 0,
      expectedDefectCount: null,
      detectedDefectCount: null,
      falseClean: null,
      legacyComparison: InvestigationLegacyComparison.NotCompared,
      replayOutcome: InvestigationReplayOutcome.Miss,
      failure: InvestigationOperationalFailure.None,
      semanticTurns: 1,
      criticCycles: 1,
      gatewayOperations: 2,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      durationMs: 100,
      timeToFirstFindingMs: null,
      capacityWaitMs: null,
      protocolBytes: 100,
      retainedBytes: null,
      securityViolationCount: null,
    } as const;
    const canonical = canonicalEvaluationJson(terminal);
    const repository = new PrismaInvestigationEvaluationRepository(
      {
        reviewInvestigationTelemetrySample: {
          findUnique: vi.fn().mockResolvedValue({
            sampleId: terminal.sampleId,
            payload: terminal,
            payloadHash: sha(canonical),
          }),
        },
        reviewInvestigationCertificate: {
          findUnique: vi.fn().mockResolvedValue({
            certificateId: "certificate-1",
            certificateHash,
            investigationId: "investigation-1",
            producerReleaseId: "release-1",
            scopeHash: terminal.repositoryScopeHash,
            reviewRevisionHash: terminal.reviewRevisionHash,
            stableReviewUnitKey: "unit",
            conclusion: "verified_clean",
          }),
        },
      } as never,
      {
        signatures: { verify: async () => false },
        clock: { now: () => new Date(validAt) },
      },
    );

    await expect(
      repository.findSubject({
        terminalSampleId: terminal.sampleId,
        certificateId: "certificate-1",
      }),
    ).resolves.toMatchObject({
      terminalSample: terminal,
      terminalSamplePayloadHash: sha(canonical),
      investigationId: "investigation-1",
      certificateHash,
      certificateConclusion: "verified_clean",
    });
  });
});

function createOperations(
  findMany: ReturnType<typeof vi.fn>,
  evaluationFindMany = vi.fn().mockResolvedValue([]),
  signatures: InvestigationEvaluationSignatureVerifierPort = {
    verify: vi.fn().mockResolvedValue(true),
  },
) {
  return new PrismaInvestigationOperations(
    {
      reviewInvestigationTelemetrySample: { findMany },
      reviewInvestigationEvaluationAttestation: {
        findMany: evaluationFindMany,
      },
    } as never,
    {
      currentProtocolVersion: "review-action-v2",
      supportedGatewayPolicyVersions: new Set(),
      acceptedProducerReleaseIds: new Set(),
    },
    signatures,
  );
}

function promotionReadInput(
  profile: InvestigationPromotionTrustProfile = trustProfile,
) {
  return {
    producerReleaseId: "release-1",
    trustProfile: profile,
    validAt,
  } as const;
}

function evaluationFixture(
  overrides: Readonly<{
    corpusVersion?: string;
    groundTruthSetHash?: string;
    evaluationPolicyVersion?: string;
    signingKeyId?: string;
    issuedAt?: string;
    expiresAt?: string;
  }> = {},
  seed = "default",
) {
  const producerReleaseId = "release-1";
  const payload: InvestigationEvaluationAttestationPayload = {
    attestationVersion: InvestigationEvaluationAttestationVersion.V1,
    attestationId: `evaluation-${seed}`,
    issuedAt: overrides.issuedAt ?? "2026-08-03T11:30:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-08-03T13:00:00.000Z",
    subject: {
      terminalSampleId: `terminal-${seed}`,
      terminalSamplePayloadHash: sha(`terminal-payload-${seed}`),
      investigationId: `investigation-${seed}`,
      certificateId: `certificate-${seed}`,
      certificateHash: sha(`certificate-${seed}`),
      producerReleaseId,
      repositoryScopeHash: sha(`scope-${seed}`),
      reviewRevisionHash: sha(`revision-${seed}`),
      stableReviewUnitHash: sha(`unit-${seed}`),
    },
    corpus: {
      version: overrides.corpusVersion ?? trustProfile.corpusVersion,
      groundTruthSetHash:
        overrides.groundTruthSetHash ?? trustProfile.groundTruthSetHash,
    },
    evaluationPolicyVersion:
      overrides.evaluationPolicyVersion ?? trustProfile.evaluationPolicyVersion,
    facts: {
      groundTruth: {
        expectedDefectCount: 1,
        detectedDefectCount: 1,
        detectedDefectSetHash: sha(`detected-${seed}`),
      },
      security: {
        evaluationHash: sha(`security-${seed}`),
        violationCount: 0,
      },
      legacy: {
        resultHash: sha(`legacy-${seed}`),
        comparison: InvestigationLegacyComparison.Agree,
      },
    },
  };
  const signature = {
    algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
    keyId: overrides.signingKeyId ?? "evaluator-key-current",
    value: "A".repeat(86),
  } as const;
  const payloadCanonicalJson = canonicalEvaluationJson(payload);
  const attestationHash = sha(payloadCanonicalJson);
  const sample = {
    sampleId: `evaluated-${attestationHash}`,
    collectedAt: validAt,
    source: InvestigationTelemetrySource.Shadow,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated,
    repositoryScopeHash: payload.subject.repositoryScopeHash,
    reviewRevisionHash: payload.subject.reviewRevisionHash,
    stableReviewUnitHash: payload.subject.stableReviewUnitHash,
    producerReleaseId,
    provider: InvestigationTelemetryProvider.Codex,
    actualModel: "gpt-5.6",
    conclusion: InvestigationTelemetryConclusion.Findings,
    findingCount: 1,
    expectedDefectCount: 1,
    detectedDefectCount: 1,
    falseClean: false,
    legacyComparison: InvestigationLegacyComparison.Agree,
    replayOutcome: InvestigationReplayOutcome.Miss,
    failure: InvestigationOperationalFailure.None,
    semanticTurns: 1,
    criticCycles: 1,
    gatewayOperations: 2,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    durationMs: 100,
    timeToFirstFindingMs: 50,
    capacityWaitMs: 0,
    protocolBytes: 100,
    retainedBytes: 200,
    securityViolationCount: 0,
  } as const;
  return {
    sample,
    telemetryRow: {
      sampleId: sample.sampleId,
      producerReleaseId,
      payload: sample,
      payloadHash: sha(canonicalEvaluationJson(sample)),
    },
    attestationRow: {
      attestationId: payload.attestationId,
      attestationVersion: payload.attestationVersion,
      attestationHash,
      envelopeHash: sha(canonicalEvaluationJson({ payload, signature })),
      signingKeyId: signature.keyId,
      signatureAlgorithm: signature.algorithm,
      signatureValue: signature.value,
      terminalSampleId: payload.subject.terminalSampleId,
      terminalSamplePayloadHash: payload.subject.terminalSamplePayloadHash,
      derivedSampleId: sample.sampleId,
      investigationId: payload.subject.investigationId,
      certificateId: payload.subject.certificateId,
      certificateHash: payload.subject.certificateHash,
      producerReleaseId,
      corpusVersion: payload.corpus.version,
      evaluationPolicyVersion: payload.evaluationPolicyVersion,
      payloadCanonicalJson,
      payload,
    },
  } as const;
}

function evaluationCommitFixture() {
  const certificateHash = sha("race-certificate");
  const stableReviewUnitKey = "race-unit";
  const terminal = {
    sampleId: `terminal-${certificateHash}`,
    collectedAt: "2026-08-03T11:00:00.000Z",
    source: InvestigationTelemetrySource.Shadow,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
    repositoryScopeHash: sha("race-scope"),
    reviewRevisionHash: sha("race-revision"),
    stableReviewUnitHash: sha(stableReviewUnitKey),
    producerReleaseId: "release-1",
    provider: InvestigationTelemetryProvider.Codex,
    actualModel: "gpt-5.6",
    conclusion: InvestigationTelemetryConclusion.VerifiedClean,
    findingCount: 0,
    expectedDefectCount: null,
    detectedDefectCount: null,
    falseClean: null,
    legacyComparison: InvestigationLegacyComparison.NotCompared,
    replayOutcome: InvestigationReplayOutcome.Miss,
    failure: InvestigationOperationalFailure.None,
    semanticTurns: 1,
    criticCycles: 1,
    gatewayOperations: 2,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    durationMs: 100,
    timeToFirstFindingMs: null,
    capacityWaitMs: null,
    protocolBytes: 100,
    retainedBytes: null,
    securityViolationCount: null,
  } as const;
  const payload: InvestigationEvaluationAttestationPayload = {
    attestationVersion: InvestigationEvaluationAttestationVersion.V1,
    attestationId: "race-evaluation",
    issuedAt: "2026-08-03T11:30:00.000Z",
    expiresAt: "2026-08-03T13:00:00.000Z",
    subject: {
      terminalSampleId: terminal.sampleId,
      terminalSamplePayloadHash: sha(canonicalEvaluationJson(terminal)),
      investigationId: "race-investigation",
      certificateId: "race-certificate",
      certificateHash,
      producerReleaseId: terminal.producerReleaseId,
      repositoryScopeHash: terminal.repositoryScopeHash,
      reviewRevisionHash: terminal.reviewRevisionHash,
      stableReviewUnitHash: terminal.stableReviewUnitHash,
    },
    corpus: {
      version: trustProfile.corpusVersion,
      groundTruthSetHash: trustProfile.groundTruthSetHash,
    },
    evaluationPolicyVersion: trustProfile.evaluationPolicyVersion,
    facts: {
      groundTruth: {
        expectedDefectCount: 1,
        detectedDefectCount: 1,
        detectedDefectSetHash: sha("race-defects"),
      },
      security: {
        evaluationHash: sha("race-security"),
        violationCount: 0,
      },
      legacy: {
        resultHash: sha("race-legacy"),
        comparison: InvestigationLegacyComparison.Agree,
      },
    },
  };
  const signature = {
    algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
    keyId: "evaluator-key-current",
    value: "A".repeat(86),
  } as const;
  const payloadCanonicalJson = canonicalEvaluationJson(payload);
  const attestationHash = sha(payloadCanonicalJson);
  const derived = deriveFullyEvaluatedTelemetrySample({
    terminal,
    attestationHash,
    evaluatedAt: payload.issuedAt,
    expectedDefectCount: payload.facts.groundTruth.expectedDefectCount,
    detectedDefectCount: payload.facts.groundTruth.detectedDefectCount,
    securityViolationCount: payload.facts.security.violationCount,
    legacyComparison: payload.facts.legacy.comparison,
  });
  const record: InvestigationEvaluationRecord = {
    attestationId: payload.attestationId,
    attestationVersion: payload.attestationVersion,
    attestationHash,
    envelopeHash: sha(canonicalEvaluationJson({ payload, signature })),
    signingKeyId: signature.keyId,
    signatureAlgorithm: signature.algorithm,
    signatureValue: signature.value,
    terminalSampleId: payload.subject.terminalSampleId,
    terminalSamplePayloadHash: payload.subject.terminalSamplePayloadHash,
    derivedSampleId: derived.sampleId,
    investigationId: payload.subject.investigationId,
    certificateId: payload.subject.certificateId,
    certificateHash: payload.subject.certificateHash,
    producerReleaseId: payload.subject.producerReleaseId,
    corpusVersion: payload.corpus.version,
    evaluationPolicyVersion: payload.evaluationPolicyVersion,
    payloadCanonicalJson,
    importedAt: validAt,
  };
  return {
    terminal,
    derived,
    record,
    certificate: {
      certificateId: payload.subject.certificateId,
      certificateHash,
      investigationId: payload.subject.investigationId,
      producerReleaseId: terminal.producerReleaseId,
      scopeHash: terminal.repositoryScopeHash,
      reviewRevisionHash: terminal.reviewRevisionHash,
      stableReviewUnitKey,
      conclusion: "verified_clean",
    },
  } as const;
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve: (value?: Value) => resolve(value as Value),
  };
}

function serialMutex() {
  let tail = Promise.resolve();
  return async (): Promise<() => void> => {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = current;
    await previous;
    return release;
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
