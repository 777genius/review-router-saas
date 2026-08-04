import {
  generateKeyPairSync,
  sign,
  createHash,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ImportSignedInvestigationEvaluation } from "../application/use-cases/import-signed-investigation-evaluation";
import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationImportError,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  InvestigationEvaluationSignatureAlgorithm,
  canonicalEvaluationJson,
  type InvestigationEvaluationAttestationPayload,
  type InvestigationEvaluationRecord,
  type SignedInvestigationEvaluationAttestation,
} from "../domain/investigation-evaluation";
import {
  InvestigationLegacyComparison,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
  type InvestigationTelemetrySample,
  type InvestigationTerminalOperationalTelemetrySample,
} from "../domain/investigation-telemetry";
import {
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustProfileVersion,
} from "../domain/promotion-trust-profile";
import { ConfiguredEd25519InvestigationEvaluationVerifier } from "../infrastructure/crypto/configured-ed25519-investigation-evaluation-verifier";
import { InMemoryInvestigationOperations } from "../infrastructure/memory/in-memory-investigation-operations";
import { PrismaInvestigationEvaluationRepository } from "../infrastructure/prisma/prisma-investigation-evaluation-repository";

const now = new Date("2026-08-03T12:00:00.000Z");
const certificateHash = sha("certificate");
const terminalSample = Object.freeze({
  sampleId: `terminal-${certificateHash}`,
  collectedAt: "2026-08-03T11:50:00.000Z",
  source: InvestigationTelemetrySource.Shadow,
  evidenceCompleteness:
    InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
  repositoryScopeHash: sha("scope"),
  reviewRevisionHash: sha("revision"),
  stableReviewUnitHash: sha("unit-key"),
  producerReleaseId: "release-1",
  provider: InvestigationTelemetryProvider.Codex,
  actualModel: "gpt-5.6",
  conclusion: InvestigationTelemetryConclusion.VerifiedClean,
  findingCount: 0,
  expectedDefectCount: null,
  detectedDefectCount: null,
  falseClean: null,
  legacyComparison: InvestigationLegacyComparison.NotCompared,
  replayOutcome: InvestigationReplayOutcome.ExactHit,
  failure: InvestigationOperationalFailure.None,
  semanticTurns: 3,
  criticCycles: 1,
  gatewayOperations: 7,
  promptTokens: 800,
  completionTokens: 200,
  totalTokens: 1_000,
  durationMs: 12_000,
  timeToFirstFindingMs: null,
  capacityWaitMs: null,
  protocolBytes: 2_000,
  retainedBytes: null,
  securityViolationCount: null,
}) satisfies InvestigationTerminalOperationalTelemetrySample;

describe("signed investigation evaluation import", () => {
  it("verifies an external attestation and atomically derives one evaluated sample", async () => {
    const fixture = createFixture();
    const first = await fixture.useCase.execute(fixture.envelope);
    fixture.clock.mockReturnValue(new Date("2026-08-03T12:01:00.000Z"));
    const replay = await fixture.useCase.execute(fixture.envelope);
    const samples = await fixture.operations.readPromotionSampleSet(
      promotionReadInput(fixture.envelope, fixture.clock().toISOString()),
    );

    expect(first).toEqual({
      status: InvestigationEvaluationImportStatus.Imported,
      attestationHash: sha(canonicalEvaluationJson(fixture.envelope.payload)),
      derivedSampleId: `evaluated-${sha(
        canonicalEvaluationJson(fixture.envelope.payload),
      )}`,
    });
    expect(replay.status).toBe(
      InvestigationEvaluationImportStatus.AlreadyImported,
    );
    expect(samples.status).toBe("complete");
    if (samples.status !== "complete") throw new Error("sample_set_missing");
    expect(samples.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceCompleteness: "terminal_operational",
        }),
        expect.objectContaining({
          evidenceCompleteness: "fully_evaluated",
          expectedDefectCount: 2,
          detectedDefectCount: 0,
          falseClean: true,
          securityViolationCount: 0,
          legacyComparison: "unexplained_disagreement",
        }),
      ]),
    );
    expect(fixture.operations.evaluationRecords.size).toBe(1);
  });

  it("rejects invalid and unsigned payloads before reading the terminal subject", async () => {
    const fixture = createFixture();
    const subjectSpy = vi.spyOn(fixture.operations, "findSubject");
    const invalidSignature = {
      ...fixture.envelope,
      signature: {
        ...fixture.envelope.signature,
        value: `${fixture.envelope.signature.value.slice(0, -1)}${
          fixture.envelope.signature.value.endsWith("A") ? "B" : "A"
        }`,
      },
    };
    await expect(
      fixture.useCase.execute(invalidSignature),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidSignature,
    });
    await expect(
      fixture.useCase.execute({
        ...fixture.envelope,
        signature: { ...fixture.envelope.signature, value: "" },
      }),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidAttestation,
    });
    expect(subjectSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a signed subject mismatch", async () => {
    const fixture = createFixture((payload) => ({
      ...payload,
      subject: { ...payload.subject, producerReleaseId: "release-other" },
    }));
    await expect(
      fixture.useCase.execute(fixture.envelope),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.SubjectMismatch,
    });
    expect(fixture.operations.evaluationRecords.size).toBe(0);
  });

  it("rejects a second signed evaluation for the same terminal sample", async () => {
    const fixture = createFixture();
    await fixture.useCase.execute(fixture.envelope);
    const conflictingPayload: InvestigationEvaluationAttestationPayload = {
      ...fixture.envelope.payload,
      attestationId: "evaluation-2",
      facts: {
        ...fixture.envelope.payload.facts,
        groundTruth: {
          ...fixture.envelope.payload.facts.groundTruth,
          expectedDefectCount: 3,
        },
      },
    };
    const conflicting = signedEnvelope(conflictingPayload, fixture.privateKey);
    await expect(fixture.useCase.execute(conflicting)).rejects.toEqual(
      new InvestigationEvaluationImportError(
        InvestigationEvaluationImportErrorCode.Conflict,
      ),
    );
    expect(fixture.operations.evaluationRecords.size).toBe(1);
  });

  it("rejects expired attestations and unknown or retired keys", async () => {
    const expired = createFixture((payload) => ({
      ...payload,
      issuedAt: "2026-08-02T10:00:00.000Z",
      expiresAt: "2026-08-02T11:00:00.000Z",
    }));
    await expect(
      expired.useCase.execute(expired.envelope),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.AttestationExpired,
    });

    const expiryBoundary = createFixture();
    expiryBoundary.clock.mockReturnValue(
      new Date(expiryBoundary.envelope.payload.expiresAt),
    );
    await expect(
      expiryBoundary.useCase.execute(expiryBoundary.envelope),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.AttestationExpired,
    });

    const fixture = createFixture(undefined, {
      keyId: "unknown-key",
    });
    await expect(
      fixture.useCase.execute(fixture.envelope),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidSignature,
    });

    const notActive = createFixture(
      (payload) => ({
        ...payload,
        issuedAt: "2026-08-03T12:02:00.000Z",
      }),
      { notBefore: "2026-08-03T12:01:00.000Z" },
    );
    await expect(
      notActive.useCase.execute(notActive.envelope),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidSignature,
    });

    const retired = createFixture(
      (payload) => ({
        ...payload,
        issuedAt: "2026-08-09T23:00:00.000Z",
        expiresAt: "2026-08-10T00:30:00.000Z",
      }),
      { verifyUntil: "2026-08-10T00:00:00.000Z" },
    );
    retired.clock.mockReturnValue(new Date("2026-08-10T00:00:00.000Z"));
    await expect(
      retired.useCase.execute(retired.envelope),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidSignature,
    });
  });

  it("rejects additional fields instead of signing ambiguous payloads", async () => {
    const fixture = createFixture();
    const payload = {
      ...fixture.envelope.payload,
      operatorNote: "must not be accepted",
    } as unknown as InvestigationEvaluationAttestationPayload;
    const envelope = signedEnvelope(payload, fixture.privateKey);
    await expect(fixture.useCase.execute(envelope)).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidAttestation,
    });
  });

  it("uses an immutable envelope snapshot across asynchronous verification", async () => {
    const fixture = createFixture();
    const mutableEnvelope = JSON.parse(
      canonicalEvaluationJson(fixture.envelope),
    ) as SignedInvestigationEvaluationAttestation;
    const importer = new ImportSignedInvestigationEvaluation(
      {
        async verify() {
          (
            mutableEnvelope.payload.facts.groundTruth as {
              expectedDefectCount: number;
            }
          ).expectedDefectCount = 99;
          return true;
        },
      },
      fixture.operations,
      {
        async digestUtf8(value) {
          return sha(value);
        },
      },
      { now: fixture.clock },
    );

    await importer.execute(mutableEnvelope);
    const samples = await fixture.operations.readPromotionSampleSet(
      promotionReadInput(fixture.envelope, fixture.clock().toISOString()),
    );
    if (samples.status !== "complete") throw new Error("sample_set_missing");
    expect(
      samples.samples.find(
        (sample) =>
          sample.evidenceCompleteness ===
          InvestigationTelemetryEvidenceCompleteness.FullyEvaluated,
      ),
    ).toMatchObject({ expectedDefectCount: 2 });
  });

  it("rejects a forged direct persistence call before opening a transaction", async () => {
    const fixture = createFixture();
    let captured:
      | Readonly<{
          record: InvestigationEvaluationRecord;
          derivedSample: InvestigationTelemetrySample;
        }>
      | undefined;
    const captureRepository = {
      findSubject: fixture.operations.findSubject.bind(fixture.operations),
      async commit(input: NonNullable<typeof captured>) {
        captured = input;
        return InvestigationEvaluationImportStatus.Imported;
      },
    };
    await new ImportSignedInvestigationEvaluation(
      fixture.verifier,
      captureRepository,
      {
        async digestUtf8(value) {
          return sha(value);
        },
      },
      { now: fixture.clock },
    ).execute(fixture.envelope);
    if (!captured) throw new Error("evaluation_commit_not_captured");

    const forgedSignature = "A".repeat(86);
    const forgedRecord = {
      ...captured.record,
      signatureValue: forgedSignature,
      envelopeHash: sha(
        canonicalEvaluationJson({
          payload: fixture.envelope.payload,
          signature: {
            algorithm: captured.record.signatureAlgorithm,
            keyId: captured.record.signingKeyId,
            value: forgedSignature,
          },
        }),
      ),
    };
    const transaction = vi.fn();
    const repository = new PrismaInvestigationEvaluationRepository(
      { $transaction: transaction } as never,
      { signatures: fixture.verifier, clock: { now: fixture.clock } },
    );

    await expect(
      repository.commit({
        record: forgedRecord,
        derivedSample: captured.derivedSample,
      }),
    ).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.InvalidSignature,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});

function createFixture(
  mutate?: (
    payload: InvestigationEvaluationAttestationPayload,
  ) => InvestigationEvaluationAttestationPayload,
  signing?: Readonly<{
    keyId?: string;
    notBefore?: string;
    verifyUntil?: string | null;
  }>,
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "evaluator-key-1";
  const operations = new InMemoryInvestigationOperations();
  operations.seedEvaluationSubject({
    terminalSample,
    terminalSamplePayloadHash: sha(canonicalEvaluationJson(terminalSample)),
    investigationId: "investigation-1",
    certificateId: "certificate-1",
    certificateHash,
    certificateProducerReleaseId: "release-1",
    certificateRepositoryScopeHash: terminalSample.repositoryScopeHash,
    certificateReviewRevisionHash: terminalSample.reviewRevisionHash,
    certificateStableReviewUnitKey: "unit-key",
    certificateConclusion: terminalSample.conclusion,
  });
  const payload = mutate?.(basePayload()) ?? basePayload();
  const envelope = signedEnvelope(payload, privateKey, signing?.keyId ?? keyId);
  const clock = vi.fn(() => now);
  const verifier = new ConfiguredEd25519InvestigationEvaluationVerifier([
    {
      keyId,
      publicKeySpkiBase64: publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      notBefore: signing?.notBefore ?? "2026-08-01T00:00:00.000Z",
      verifyUntil:
        signing?.verifyUntil === undefined
          ? "2026-08-10T00:00:00.000Z"
          : signing.verifyUntil,
    },
  ]);
  return {
    operations,
    envelope,
    privateKey,
    clock,
    verifier,
    useCase: new ImportSignedInvestigationEvaluation(
      verifier,
      operations,
      {
        async digestUtf8(value) {
          return sha(value);
        },
      },
      { now: clock },
    ),
  };
}

function promotionReadInput(
  envelope: SignedInvestigationEvaluationAttestation,
  validAt: string,
) {
  return {
    producerReleaseId: envelope.payload.subject.producerReleaseId,
    validAt,
    trustProfile: {
      profileVersion: InvestigationPromotionTrustProfileVersion.V1,
      corpusVersion: envelope.payload.corpus.version,
      groundTruthSetHash: envelope.payload.corpus.groundTruthSetHash,
      evaluationPolicyVersion: envelope.payload.evaluationPolicyVersion,
      freshness: {
        policy:
          InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
        issuedAtOrAfter: envelope.payload.issuedAt,
      },
      signingKeys: {
        policy: InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
        lineageId: "evaluation-test-lineage",
        policyVersion: "evaluation-test-lineage.v1",
        signatureAlgorithm: envelope.signature.algorithm,
        acceptedKeyIds: [envelope.signature.keyId],
      },
    },
  } as const;
}

function basePayload(): InvestigationEvaluationAttestationPayload {
  return {
    attestationVersion: InvestigationEvaluationAttestationVersion.V1,
    attestationId: "evaluation-1",
    issuedAt: "2026-08-03T11:55:00.000Z",
    expiresAt: "2026-08-03T13:00:00.000Z",
    subject: {
      terminalSampleId: terminalSample.sampleId,
      terminalSamplePayloadHash: sha(canonicalEvaluationJson(terminalSample)),
      investigationId: "investigation-1",
      certificateId: "certificate-1",
      certificateHash,
      producerReleaseId: "release-1",
      repositoryScopeHash: terminalSample.repositoryScopeHash,
      reviewRevisionHash: terminalSample.reviewRevisionHash,
      stableReviewUnitHash: terminalSample.stableReviewUnitHash,
    },
    corpus: {
      version: "corpus-2026-08-03.v1",
      groundTruthSetHash: sha("ground-truth"),
    },
    evaluationPolicyVersion: "evaluation-policy.v1",
    facts: {
      groundTruth: {
        expectedDefectCount: 2,
        detectedDefectCount: 0,
        detectedDefectSetHash: sha("detected-defects"),
      },
      security: {
        evaluationHash: sha("security-evaluation"),
        violationCount: 0,
      },
      legacy: {
        resultHash: sha("legacy-result"),
        comparison: InvestigationLegacyComparison.UnexplainedDisagreement,
      },
    },
  };
}

function signedEnvelope(
  payload: InvestigationEvaluationAttestationPayload,
  privateKey: KeyObject,
  keyId = "evaluator-key-1",
): SignedInvestigationEvaluationAttestation {
  return {
    payload,
    signature: {
      algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
      keyId,
      value: sign(
        null,
        Buffer.from(canonicalEvaluationJson(payload), "utf8"),
        privateKey,
      ).toString("base64url"),
    },
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
