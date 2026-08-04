import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  InvestigationEvaluationClockPort,
  InvestigationEvaluationRepositoryPort,
  InvestigationEvaluationSignatureVerifierPort,
} from "../../application/ports/operations-ports";
import {
  InvestigationEvaluationImportError,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  assertInvestigationEvaluationSubjectBindings,
  assertEvaluationAttestationTimeWindow,
  canonicalEvaluationJson,
  deriveFullyEvaluatedTelemetrySample,
  type InvestigationEvaluationRecord,
  type InvestigationEvaluationSubject,
  type InvestigationEvaluationAttestationPayload,
  validateSignedInvestigationEvaluationAttestation,
} from "../../domain/investigation-evaluation";
import {
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  type InvestigationTelemetrySample,
  validateTelemetrySample,
} from "../../domain/investigation-telemetry";
import { withInvestigationPromotionReleaseLock } from "./prisma-investigation-promotion-lock";

type EvaluationPersistence = Pick<
  Prisma.TransactionClient,
  | "reviewInvestigationEvaluationAttestation"
  | "reviewInvestigationCertificate"
  | "reviewInvestigationTelemetrySample"
>;

type EvaluationSubjectPersistence = Pick<
  Prisma.TransactionClient,
  "reviewInvestigationCertificate" | "reviewInvestigationTelemetrySample"
>;

export class PrismaInvestigationEvaluationRepository implements InvestigationEvaluationRepositoryPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly verification: Readonly<{
      signatures: InvestigationEvaluationSignatureVerifierPort;
      clock: InvestigationEvaluationClockPort;
    }>,
  ) {}

  async findSubject(input: {
    readonly terminalSampleId: string;
    readonly certificateId: string;
  }): Promise<InvestigationEvaluationSubject | null> {
    return loadEvaluationSubject(this.prisma, input);
  }

  async commit(input: {
    readonly record: InvestigationEvaluationRecord;
    readonly derivedSample: InvestigationTelemetrySample;
  }): Promise<InvestigationEvaluationImportStatus> {
    const snapshot = JSON.parse(canonicalEvaluationJson(input)) as typeof input;
    const prepared = prepareCommit(snapshot);
    const now = this.verification.clock.now();
    assertEvaluationAttestationTimeWindow({
      issuedAt: prepared.attestationPayload.issuedAt,
      expiresAt: prepared.attestationPayload.expiresAt,
      now,
    });
    const signatureVerified = await this.verification.signatures.verify({
      algorithm: snapshot.record.signatureAlgorithm,
      keyId: snapshot.record.signingKeyId,
      payloadCanonicalJson: snapshot.record.payloadCanonicalJson,
      signature: snapshot.record.signatureValue,
      issuedAt: prepared.attestationPayload.issuedAt,
      now,
    });
    if (!signatureVerified) {
      throw new InvestigationEvaluationImportError(
        InvestigationEvaluationImportErrorCode.InvalidSignature,
      );
    }
    try {
      return await withInvestigationPromotionReleaseLock(
        this.prisma,
        snapshot.record.producerReleaseId,
        async (transaction) => {
          const subject = await loadAndAssertPersistedSubjectBindings(
            transaction,
            prepared.attestationPayload.subject,
          );
          const expectedDerivedSample = deriveFullyEvaluatedTelemetrySample({
            terminal: subject.terminalSample,
            attestationHash: snapshot.record.attestationHash,
            evaluatedAt: prepared.attestationPayload.issuedAt,
            expectedDefectCount:
              prepared.attestationPayload.facts.groundTruth.expectedDefectCount,
            detectedDefectCount:
              prepared.attestationPayload.facts.groundTruth.detectedDefectCount,
            securityViolationCount:
              prepared.attestationPayload.facts.security.violationCount,
            legacyComparison:
              prepared.attestationPayload.facts.legacy.comparison,
          });
          if (
            canonicalEvaluationJson(expectedDerivedSample) !==
            canonicalEvaluationJson(snapshot.derivedSample)
          ) {
            throw new Error("evaluation_derived_sample_binding_invalid");
          }
          const existing = await readExistingStatus(
            transaction,
            snapshot.record,
            prepared.derivedPayloadHash,
          );
          if (existing !== null) return existing;
          await transaction.reviewInvestigationTelemetrySample.create({
            data: {
              sampleId: snapshot.derivedSample.sampleId,
              producerReleaseId: snapshot.derivedSample.producerReleaseId,
              source: snapshot.derivedSample.source,
              repositoryScopeHash: snapshot.derivedSample.repositoryScopeHash,
              reviewRevisionHash: snapshot.derivedSample.reviewRevisionHash,
              stableReviewUnitHash: snapshot.derivedSample.stableReviewUnitHash,
              payload: prepared.derivedPayload,
              payloadHash: prepared.derivedPayloadHash,
              collectedAt: new Date(snapshot.derivedSample.collectedAt),
            },
          });
          await transaction.reviewInvestigationEvaluationAttestation.create({
            data: {
              attestationId: snapshot.record.attestationId,
              attestationVersion: snapshot.record.attestationVersion,
              attestationHash: snapshot.record.attestationHash,
              envelopeHash: snapshot.record.envelopeHash,
              signingKeyId: snapshot.record.signingKeyId,
              signatureAlgorithm: snapshot.record.signatureAlgorithm,
              signatureValue: snapshot.record.signatureValue,
              terminalSampleId: snapshot.record.terminalSampleId,
              terminalSamplePayloadHash:
                snapshot.record.terminalSamplePayloadHash,
              derivedSampleId: snapshot.record.derivedSampleId,
              investigationId: snapshot.record.investigationId,
              certificateId: snapshot.record.certificateId,
              certificateHash: snapshot.record.certificateHash,
              producerReleaseId: snapshot.record.producerReleaseId,
              corpusVersion: snapshot.record.corpusVersion,
              evaluationPolicyVersion: snapshot.record.evaluationPolicyVersion,
              payloadCanonicalJson: snapshot.record.payloadCanonicalJson,
              payload: prepared.attestationPayloadJson,
              importedAt: new Date(snapshot.record.importedAt),
            },
          });
          return InvestigationEvaluationImportStatus.Imported;
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await readExistingStatus(
          this.prisma,
          snapshot.record,
          prepared.derivedPayloadHash,
        );
        if (raced !== null) return raced;
        throw conflict();
      }
      throw error;
    }
  }
}

async function loadEvaluationSubject(
  persistence: EvaluationSubjectPersistence,
  input: {
    readonly terminalSampleId: string;
    readonly certificateId: string;
  },
): Promise<InvestigationEvaluationSubject | null> {
  // The same loader runs both outside and inside an interactive transaction.
  // pg must not receive concurrent queries on the transaction's single client.
  const sampleRow =
    await persistence.reviewInvestigationTelemetrySample.findUnique({
      where: { sampleId: input.terminalSampleId },
      select: { sampleId: true, payload: true, payloadHash: true },
    });
  const certificate =
    await persistence.reviewInvestigationCertificate.findUnique({
      where: { certificateId: input.certificateId },
      select: {
        certificateId: true,
        certificateHash: true,
        investigationId: true,
        producerReleaseId: true,
        scopeHash: true,
        reviewRevisionHash: true,
        stableReviewUnitKey: true,
        conclusion: true,
      },
    });
  if (sampleRow === null || certificate === null) return null;
  const payloadCanonicalJson = canonicalEvaluationJson(sampleRow.payload);
  if (sha256(payloadCanonicalJson) !== sampleRow.payloadHash) {
    throw new Error("evaluation_terminal_sample_payload_hash_mismatch");
  }
  const terminalSample =
    sampleRow.payload as unknown as InvestigationTelemetrySample;
  validateTelemetrySample(terminalSample);
  if (
    terminalSample.sampleId !== sampleRow.sampleId ||
    terminalSample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational ||
    certificate.scopeHash === null ||
    terminalSample.sampleId !== `terminal-${certificate.certificateHash}`
  ) {
    throw new Error("evaluation_subject_integrity_invalid");
  }
  return Object.freeze({
    terminalSample,
    terminalSamplePayloadHash: sampleRow.payloadHash,
    investigationId: certificate.investigationId,
    certificateId: certificate.certificateId,
    certificateHash: certificate.certificateHash,
    certificateProducerReleaseId: certificate.producerReleaseId,
    certificateRepositoryScopeHash: certificate.scopeHash,
    certificateReviewRevisionHash: certificate.reviewRevisionHash,
    certificateStableReviewUnitKey: certificate.stableReviewUnitKey,
    certificateConclusion: telemetryConclusion(certificate.conclusion),
  });
}

async function loadAndAssertPersistedSubjectBindings(
  persistence: EvaluationSubjectPersistence,
  attested: InvestigationEvaluationAttestationPayload["subject"],
): Promise<InvestigationEvaluationSubject> {
  const subject = await loadEvaluationSubject(persistence, {
    terminalSampleId: attested.terminalSampleId,
    certificateId: attested.certificateId,
  });
  if (subject === null) {
    throw new InvestigationEvaluationImportError(
      InvestigationEvaluationImportErrorCode.SubjectNotFound,
    );
  }
  assertInvestigationEvaluationSubjectBindings({
    attested,
    subject,
    certificateStableReviewUnitHash: sha256(
      subject.certificateStableReviewUnitKey,
    ),
  });
  return subject;
}

function prepareCommit(input: {
  readonly record: InvestigationEvaluationRecord;
  readonly derivedSample: InvestigationTelemetrySample;
}): Readonly<{
  attestationPayload: InvestigationEvaluationAttestationPayload;
  attestationPayloadJson: Prisma.InputJsonValue;
  derivedPayload: Prisma.InputJsonValue;
  derivedPayloadHash: string;
}> {
  validateTelemetrySample(input.derivedSample);
  if (
    input.derivedSample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated ||
    input.derivedSample.sampleId !== input.record.derivedSampleId
  ) {
    throw new Error("evaluation_derived_sample_invalid");
  }
  let payload: InvestigationEvaluationAttestationPayload;
  try {
    payload = JSON.parse(
      input.record.payloadCanonicalJson,
    ) as InvestigationEvaluationAttestationPayload;
  } catch {
    throw new Error("evaluation_payload_canonical_json_invalid");
  }
  if (canonicalEvaluationJson(payload) !== input.record.payloadCanonicalJson) {
    throw new Error("evaluation_payload_canonical_json_invalid");
  }
  validateSignedInvestigationEvaluationAttestation({
    payload,
    signature: {
      algorithm: input.record.signatureAlgorithm,
      keyId: input.record.signingKeyId,
      value: input.record.signatureValue,
    },
  });
  if (
    sha256(input.record.payloadCanonicalJson) !==
      input.record.attestationHash ||
    sha256(
      canonicalEvaluationJson({
        payload,
        signature: {
          algorithm: input.record.signatureAlgorithm,
          keyId: input.record.signingKeyId,
          value: input.record.signatureValue,
        },
      }),
    ) !== input.record.envelopeHash ||
    payload.attestationId !== input.record.attestationId ||
    payload.subject.terminalSampleId !== input.record.terminalSampleId ||
    payload.subject.terminalSamplePayloadHash !==
      input.record.terminalSamplePayloadHash ||
    payload.subject.investigationId !== input.record.investigationId ||
    payload.subject.certificateId !== input.record.certificateId ||
    payload.subject.certificateHash !== input.record.certificateHash ||
    payload.subject.producerReleaseId !== input.record.producerReleaseId ||
    payload.corpus.version !== input.record.corpusVersion ||
    payload.evaluationPolicyVersion !== input.record.evaluationPolicyVersion
  ) {
    throw new Error("evaluation_record_binding_invalid");
  }
  const derivedCanonicalJson = canonicalEvaluationJson(input.derivedSample);
  return Object.freeze({
    attestationPayload: payload,
    attestationPayloadJson: JSON.parse(
      input.record.payloadCanonicalJson,
    ) as Prisma.InputJsonValue,
    derivedPayload: JSON.parse(derivedCanonicalJson) as Prisma.InputJsonValue,
    derivedPayloadHash: sha256(derivedCanonicalJson),
  });
}

async function readExistingStatus(
  persistence: EvaluationPersistence,
  record: InvestigationEvaluationRecord,
  expectedDerivedPayloadHash: string,
): Promise<InvestigationEvaluationImportStatus | null> {
  const existing =
    await persistence.reviewInvestigationEvaluationAttestation.findFirst({
      where: {
        OR: [
          { attestationId: record.attestationId },
          { attestationHash: record.attestationHash },
          { envelopeHash: record.envelopeHash },
          { terminalSampleId: record.terminalSampleId },
          { derivedSampleId: record.derivedSampleId },
        ],
      },
      select: {
        attestationId: true,
        attestationHash: true,
        envelopeHash: true,
        terminalSampleId: true,
        terminalSamplePayloadHash: true,
        derivedSampleId: true,
      },
    });
  if (existing !== null) {
    if (
      existing.attestationId !== record.attestationId ||
      existing.attestationHash !== record.attestationHash ||
      existing.envelopeHash !== record.envelopeHash ||
      existing.terminalSampleId !== record.terminalSampleId ||
      existing.terminalSamplePayloadHash !== record.terminalSamplePayloadHash ||
      existing.derivedSampleId !== record.derivedSampleId
    ) {
      throw conflict();
    }
    const derived =
      await persistence.reviewInvestigationTelemetrySample.findUnique({
        where: { sampleId: record.derivedSampleId },
        select: { payloadHash: true },
      });
    if (derived?.payloadHash !== expectedDerivedPayloadHash) {
      throw conflict();
    }
    return InvestigationEvaluationImportStatus.AlreadyImported;
  }
  const orphanDerived =
    await persistence.reviewInvestigationTelemetrySample.findUnique({
      where: { sampleId: record.derivedSampleId },
      select: { payloadHash: true },
    });
  if (orphanDerived !== null) throw conflict();
  return null;
}

function telemetryConclusion(value: string): InvestigationTelemetryConclusion {
  if (
    !Object.values(InvestigationTelemetryConclusion).includes(
      value as InvestigationTelemetryConclusion,
    )
  ) {
    throw new Error("evaluation_certificate_conclusion_invalid");
  }
  return value as InvestigationTelemetryConclusion;
}

function conflict(): InvestigationEvaluationImportError {
  return new InvestigationEvaluationImportError(
    InvestigationEvaluationImportErrorCode.Conflict,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
