import type {
  InvestigationEvaluationClockPort,
  InvestigationEvaluationRepositoryPort,
  InvestigationEvaluationSignatureVerifierPort,
  InvestigationOperationsDigestPort,
} from "../ports/operations-ports";
import {
  InvestigationEvaluationImportError,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  assertInvestigationEvaluationSubjectBindings,
  assertEvaluationAttestationTimeWindow,
  canonicalEvaluationJson,
  deriveFullyEvaluatedTelemetrySample,
  type InvestigationEvaluationRecord,
  type SignedInvestigationEvaluationAttestation,
  validateSignedInvestigationEvaluationAttestation,
} from "../../domain/investigation-evaluation";
import { validateTelemetrySample } from "../../domain/investigation-telemetry";

export type ImportSignedInvestigationEvaluationResult = Readonly<{
  status: InvestigationEvaluationImportStatus;
  attestationHash: string;
  derivedSampleId: string;
}>;

export class ImportSignedInvestigationEvaluation {
  constructor(
    private readonly signatures: InvestigationEvaluationSignatureVerifierPort,
    private readonly evaluations: InvestigationEvaluationRepositoryPort,
    private readonly digests: InvestigationOperationsDigestPort,
    private readonly clock: InvestigationEvaluationClockPort,
  ) {}

  async execute(
    input: SignedInvestigationEvaluationAttestation,
  ): Promise<ImportSignedInvestigationEvaluationResult> {
    let envelope: SignedInvestigationEvaluationAttestation;
    try {
      envelope = JSON.parse(
        canonicalEvaluationJson(input),
      ) as SignedInvestigationEvaluationAttestation;
      validateSignedInvestigationEvaluationAttestation(envelope);
    } catch (error) {
      if (error instanceof InvestigationEvaluationImportError) throw error;
      throw new InvestigationEvaluationImportError(
        InvestigationEvaluationImportErrorCode.InvalidAttestation,
      );
    }

    const now = this.clock.now();
    assertEvaluationAttestationTimeWindow({
      issuedAt: envelope.payload.issuedAt,
      expiresAt: envelope.payload.expiresAt,
      now,
    });
    const payloadCanonicalJson = canonicalEvaluationJson(envelope.payload);
    const verified = await this.signatures.verify({
      algorithm: envelope.signature.algorithm,
      keyId: envelope.signature.keyId,
      payloadCanonicalJson,
      signature: envelope.signature.value,
      issuedAt: envelope.payload.issuedAt,
      now,
    });
    if (!verified) {
      throw new InvestigationEvaluationImportError(
        InvestigationEvaluationImportErrorCode.InvalidSignature,
      );
    }

    const subject = await this.evaluations.findSubject({
      terminalSampleId: envelope.payload.subject.terminalSampleId,
      certificateId: envelope.payload.subject.certificateId,
    });
    if (subject === null) {
      throw new InvestigationEvaluationImportError(
        InvestigationEvaluationImportErrorCode.SubjectNotFound,
      );
    }
    const stableReviewUnitHash = await this.digests.digestUtf8(
      subject.certificateStableReviewUnitKey,
    );
    assertInvestigationEvaluationSubjectBindings({
      attested: envelope.payload.subject,
      subject,
      certificateStableReviewUnitHash: stableReviewUnitHash,
    });

    const attestationHash = await this.digests.digestUtf8(payloadCanonicalJson);
    const envelopeHash = await this.digests.digestUtf8(
      canonicalEvaluationJson(envelope),
    );
    const derivedSample = deriveFullyEvaluatedTelemetrySample({
      terminal: subject.terminalSample,
      attestationHash,
      evaluatedAt: envelope.payload.issuedAt,
      expectedDefectCount:
        envelope.payload.facts.groundTruth.expectedDefectCount,
      detectedDefectCount:
        envelope.payload.facts.groundTruth.detectedDefectCount,
      securityViolationCount: envelope.payload.facts.security.violationCount,
      legacyComparison: envelope.payload.facts.legacy.comparison,
    });
    validateTelemetrySample(derivedSample);
    const record: InvestigationEvaluationRecord = Object.freeze({
      attestationId: envelope.payload.attestationId,
      attestationVersion: envelope.payload.attestationVersion,
      attestationHash,
      envelopeHash,
      signingKeyId: envelope.signature.keyId,
      signatureAlgorithm: envelope.signature.algorithm,
      signatureValue: envelope.signature.value,
      terminalSampleId: envelope.payload.subject.terminalSampleId,
      terminalSamplePayloadHash:
        envelope.payload.subject.terminalSamplePayloadHash,
      derivedSampleId: derivedSample.sampleId,
      investigationId: envelope.payload.subject.investigationId,
      certificateId: envelope.payload.subject.certificateId,
      certificateHash: envelope.payload.subject.certificateHash,
      producerReleaseId: envelope.payload.subject.producerReleaseId,
      corpusVersion: envelope.payload.corpus.version,
      evaluationPolicyVersion: envelope.payload.evaluationPolicyVersion,
      payloadCanonicalJson,
      importedAt: now.toISOString(),
    });
    const status = await this.evaluations.commit({
      record,
      derivedSample,
    });
    return Object.freeze({
      status,
      attestationHash,
      derivedSampleId: derivedSample.sampleId,
    });
  }
}
