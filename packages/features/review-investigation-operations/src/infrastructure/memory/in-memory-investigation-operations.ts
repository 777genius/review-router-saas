import { createHash } from "node:crypto";
import {
  InvestigationPromotionTelemetryReadStatus,
  maximumInvestigationPromotionTelemetrySamples,
  type InvestigationEvaluationRepositoryPort,
  type InvestigationOperatorStatusRepositoryPort,
  type InvestigationPromotionReportCommit,
  type InvestigationPromotionReportUnitOfWorkPort,
  type InvestigationPromotionTelemetryReadResult,
  type InvestigationTelemetryRepositoryPort,
} from "../../application/ports/operations-ports";
import {
  InvestigationTelemetryEvidenceCompleteness,
  type InvestigationFullyEvaluatedTelemetrySample,
  type InvestigationTelemetrySample,
  type InvestigationTerminalOperationalTelemetrySample,
  validateTelemetrySample,
} from "../../domain/investigation-telemetry";
import {
  InvestigationEvaluationImportError,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  canonicalEvaluationJson,
  type InvestigationEvaluationRecord,
  type InvestigationEvaluationSubject,
} from "../../domain/investigation-evaluation";
import type { InvestigationOperatorStatus } from "../../domain/operator-status";
import {
  InvestigationPromotionTrustError,
  InvestigationPromotionTrustErrorCode,
  assertInvestigationPromotionEvaluationEvidenceIntegrity,
  assertInvestigationPromotionEvaluationEvidenceTrusted,
  assertInvestigationPromotionTrustProfileValidAt,
  normalizeInvestigationPromotionTrustProfile,
  parseStoredInvestigationPromotionEvaluationAttestation,
  type InvestigationPromotionEvaluationEvidence,
} from "../../domain/promotion-trust-profile";

export class InMemoryInvestigationOperations
  implements
    InvestigationTelemetryRepositoryPort,
    InvestigationOperatorStatusRepositoryPort,
    InvestigationPromotionReportUnitOfWorkPort,
    InvestigationEvaluationRepositoryPort
{
  private readonly samples = new Map<string, InvestigationTelemetrySample>();
  private readonly statuses = new Map<string, InvestigationOperatorStatus>();
  private readonly evaluationSubjects = new Map<
    string,
    InvestigationEvaluationSubject
  >();
  readonly evaluationRecords = new Map<string, InvestigationEvaluationRecord>();
  private readonly promotionEvidence = new Map<
    string,
    InvestigationPromotionEvaluationEvidence
  >();
  readonly reports = new Map<string, string>();

  async append(
    sample: InvestigationTerminalOperationalTelemetrySample,
  ): Promise<void> {
    validateTelemetrySample(sample);
    if (
      sample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational
    ) {
      throw new Error("telemetry_trusted_evaluation_required");
    }
    const existing = this.samples.get(sample.sampleId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(sample)) {
      throw new Error("telemetry_sample_id_conflict");
    }
    this.samples.set(sample.sampleId, Object.freeze({ ...sample }));
  }

  seedFullyEvaluatedTelemetrySample(
    sample: InvestigationFullyEvaluatedTelemetrySample,
    evidence: InvestigationPromotionEvaluationEvidence,
  ): void {
    validateTelemetrySample(sample);
    if (
      sample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated
    ) {
      throw new Error("telemetry_evaluation_fixture_invalid");
    }
    assertInvestigationPromotionEvaluationEvidenceIntegrity(sample, evidence);
    const existing = this.samples.get(sample.sampleId);
    if (
      existing &&
      canonicalEvaluationJson(existing) !== canonicalEvaluationJson(sample)
    ) {
      throw new Error("telemetry_sample_id_conflict");
    }
    this.samples.set(sample.sampleId, Object.freeze({ ...sample }));
    this.promotionEvidence.set(sample.sampleId, Object.freeze({ ...evidence }));
  }

  async readPromotionSampleSet(
    input: Parameters<
      InvestigationTelemetryRepositoryPort["readPromotionSampleSet"]
    >[0],
  ): Promise<InvestigationPromotionTelemetryReadResult> {
    const trustProfile = normalizeInvestigationPromotionTrustProfile(
      input.trustProfile,
    );
    assertInvestigationPromotionTrustProfileValidAt({
      profile: trustProfile,
      validAt: input.validAt,
    });
    const samples = [...this.samples.values()]
      .filter((item) => item.producerReleaseId === input.producerReleaseId)
      .sort((a, b) => a.sampleId.localeCompare(b.sampleId, "en"));
    if (samples.length > maximumInvestigationPromotionTelemetrySamples) {
      return { status: InvestigationPromotionTelemetryReadStatus.TooLarge };
    }
    for (const sample of samples) {
      if (
        sample.evidenceCompleteness !==
        InvestigationTelemetryEvidenceCompleteness.FullyEvaluated
      ) {
        continue;
      }
      const evidence = this.promotionEvidence.get(sample.sampleId);
      if (evidence === undefined) {
        throw new InvestigationPromotionTrustError(
          InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
        );
      }
      assertInvestigationPromotionEvaluationEvidenceTrusted({
        sample,
        evidence,
        trustProfile,
        validAt: input.validAt,
      });
    }
    return {
      status: InvestigationPromotionTelemetryReadStatus.Complete,
      samples: Object.freeze(samples),
    };
  }

  async find(
    investigationId: string,
  ): Promise<InvestigationOperatorStatus | null> {
    return this.statuses.get(investigationId) ?? null;
  }

  setStatus(status: InvestigationOperatorStatus): void {
    this.statuses.set(status.investigationId, Object.freeze({ ...status }));
  }

  async withPromotionSnapshot<Result>(
    input: Parameters<
      InvestigationTelemetryRepositoryPort["readPromotionSampleSet"]
    >[0],
    build: (
      telemetry: InvestigationPromotionTelemetryReadResult,
    ) => Promise<InvestigationPromotionReportCommit<Result>>,
  ): Promise<Result> {
    const telemetry = await this.readPromotionSampleSet(input);
    const commit = await build(telemetry);
    const existing = this.reports.get(commit.reportHash);
    if (existing && existing !== commit.reportCanonicalJson) {
      throw new Error("promotion_report_hash_conflict");
    }
    this.reports.set(commit.reportHash, commit.reportCanonicalJson);
    return commit.result;
  }

  seedEvaluationSubject(subject: InvestigationEvaluationSubject): void {
    this.evaluationSubjects.set(
      evaluationSubjectKey(
        subject.terminalSample.sampleId,
        subject.certificateId,
      ),
      Object.freeze({ ...subject }),
    );
    this.samples.set(
      subject.terminalSample.sampleId,
      Object.freeze({ ...subject.terminalSample }),
    );
  }

  async findSubject(input: {
    readonly terminalSampleId: string;
    readonly certificateId: string;
  }): Promise<InvestigationEvaluationSubject | null> {
    return (
      this.evaluationSubjects.get(
        evaluationSubjectKey(input.terminalSampleId, input.certificateId),
      ) ?? null
    );
  }

  async commit(input: {
    readonly record: InvestigationEvaluationRecord;
    readonly derivedSample: InvestigationTelemetrySample;
  }): Promise<InvestigationEvaluationImportStatus> {
    const collision = [...this.evaluationRecords.values()].find(
      (existing) =>
        existing.attestationId === input.record.attestationId ||
        existing.attestationHash === input.record.attestationHash ||
        existing.envelopeHash === input.record.envelopeHash ||
        existing.terminalSampleId === input.record.terminalSampleId ||
        existing.derivedSampleId === input.record.derivedSampleId,
    );
    if (collision) {
      const derived = this.samples.get(input.record.derivedSampleId);
      const existingStable = evaluationRecordIdentity(collision);
      const incomingStable = evaluationRecordIdentity(input.record);
      if (
        canonicalEvaluationJson(existingStable) !==
          canonicalEvaluationJson(incomingStable) ||
        derived === undefined ||
        canonicalEvaluationJson(derived) !==
          canonicalEvaluationJson(input.derivedSample)
      ) {
        throw new InvestigationEvaluationImportError(
          InvestigationEvaluationImportErrorCode.Conflict,
        );
      }
      return InvestigationEvaluationImportStatus.AlreadyImported;
    }
    if (this.samples.has(input.record.derivedSampleId)) {
      throw new InvestigationEvaluationImportError(
        InvestigationEvaluationImportErrorCode.Conflict,
      );
    }
    const parsed = parseStoredInvestigationPromotionEvaluationAttestation(
      input.record,
    );
    if (
      sha256(parsed.payloadCanonicalJson) !== input.record.attestationHash ||
      sha256(parsed.envelopeCanonicalJson) !== input.record.envelopeHash
    ) {
      throw new InvestigationPromotionTrustError(
        InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
      );
    }
    if (
      input.derivedSample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated
    ) {
      throw new InvestigationPromotionTrustError(
        InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
      );
    }
    assertInvestigationPromotionEvaluationEvidenceIntegrity(
      input.derivedSample,
      parsed.evidence,
    );
    this.samples.set(
      input.derivedSample.sampleId,
      Object.freeze({ ...input.derivedSample }),
    );
    this.evaluationRecords.set(
      input.record.attestationId,
      Object.freeze({ ...input.record }),
    );
    this.promotionEvidence.set(input.record.derivedSampleId, parsed.evidence);
    return InvestigationEvaluationImportStatus.Imported;
  }
}

function evaluationSubjectKey(
  terminalSampleId: string,
  certificateId: string,
): string {
  return `${terminalSampleId}\u0000${certificateId}`;
}

function evaluationRecordIdentity(
  record: InvestigationEvaluationRecord,
): Omit<InvestigationEvaluationRecord, "importedAt"> {
  const { importedAt, ...identity } = record;
  void importedAt;
  return identity;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
