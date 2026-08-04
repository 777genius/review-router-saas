import type { Sha256DigestPort } from "../ports/sha256-digest-port";
import {
  InvestigationShadowEvidencePersistenceStatus,
  type InvestigationShadowEvidenceCommandPort,
} from "../ports/investigation-shadow-evidence-ports";
import {
  InvestigationShadowEvidenceAuthority,
  InvestigationShadowEvidenceSourceKind,
  assertInvestigationShadowEvidenceCertificate,
  canonicalInvestigationShadowCertificate,
  createInvestigationShadowEvidence,
  investigationShadowEvidenceRecordCanonicalValue,
  investigationShadowEvidenceRetentionMs,
  investigationShadowEvidenceRetentionPolicyVersion,
  investigationShadowEvidenceVersion,
  investigationShadowScopeCanonicalValue,
  prepareInvestigationShadowTerminalPayload,
  type InvestigationShadowEvidence,
  type InvestigationShadowEvidenceProjectionSource,
} from "../../domain/investigation-shadow-evidence";
import { stableJson } from "../../domain/provider-invocation-manifest";

export enum ProjectInvestigationShadowEvidenceStatus {
  Projected = "projected",
  Idempotent = "idempotent",
}

export type ProjectInvestigationShadowEvidenceResult = Readonly<{
  status: ProjectInvestigationShadowEvidenceStatus;
  evidence: InvestigationShadowEvidence;
}>;

export class ProjectInvestigationShadowEvidence {
  constructor(
    private readonly dependencies: Readonly<{
      records: InvestigationShadowEvidenceCommandPort;
      digest: Sha256DigestPort;
    }>,
  ) {}

  async execute(
    source: InvestigationShadowEvidenceProjectionSource,
  ): Promise<ProjectInvestigationShadowEvidenceResult> {
    assertInvestigationShadowEvidenceCertificate(source.certificate);
    assertSourceCertificateBinding(source);
    const terminalPayload = prepareInvestigationShadowTerminalPayload(
      source.certificate.terminalObservationCanonicalJson,
    );
    const terminalPayloadHash = await this.dependencies.digest.digest(
      terminalPayload.canonicalBytes,
    );
    if (terminalPayloadHash !== source.certificate.terminalOutcomeHash) {
      throw new Error("investigation_shadow_terminal_outcome_hash_mismatch");
    }

    const scopeHash = await digestUtf8(
      this.dependencies.digest,
      stableJson(investigationShadowScopeCanonicalValue(source.scope)),
    );
    if (scopeHash !== source.certificate.scopeHash) {
      throw new Error("investigation_shadow_scope_hash_mismatch");
    }

    const certificateCanonicalJson = canonicalInvestigationShadowCertificate(
      source.certificate,
    );
    const certificateHash = await digestUtf8(
      this.dependencies.digest,
      certificateCanonicalJson,
    );
    if (certificateHash !== source.certificate.certificateHash) {
      throw new Error("investigation_shadow_certificate_hash_mismatch");
    }

    const issuedAtMs = strictTimestamp(
      source.certificate.issuedAt,
      "certificate_issued_at",
    );
    const expiresAtMs = strictTimestamp(
      source.certificate.expiresAt,
      "certificate_expires_at",
    );
    if (expiresAtMs <= issuedAtMs) {
      throw new Error("investigation_shadow_certificate_lifetime_invalid");
    }
    const retainUntilMs = issuedAtMs + investigationShadowEvidenceRetentionMs;
    if (!Number.isSafeInteger(retainUntilMs)) {
      throw new Error("investigation_shadow_retention_invalid");
    }

    const withoutRecordHash: Omit<InvestigationShadowEvidence, "recordHash"> = {
      shadowEvidenceId: `investigation-shadow-${certificateHash.slice(0, 48)}`,
      evidenceVersion: investigationShadowEvidenceVersion,
      authority: InvestigationShadowEvidenceAuthority.NonAuthoritative,
      sourceKind: InvestigationShadowEvidenceSourceKind.TerminalCertificate,
      retentionPolicyVersion: investigationShadowEvidenceRetentionPolicyVersion,
      investigationId: source.investigationId,
      investigationVersion: source.investigationVersion,
      scope: source.scope,
      revision: source.revision,
      executionId: source.executionId,
      workSlotId: source.workSlotId,
      stableReviewUnitKey: source.stableReviewUnitKey,
      providerVoteLaneId: source.providerVoteLaneId,
      producerReleaseId: source.producerReleaseId,
      conclusion: source.conclusion,
      certificateId: source.certificate.certificateId,
      certificateHash,
      certificateCanonicalJson,
      terminalProviderKind: source.certificate.terminalProviderKind,
      terminalActualModel: source.certificate.terminalActualModel,
      terminalOutcomeHash: source.certificate.terminalOutcomeHash,
      terminalObservationCanonicalJson: terminalPayload.canonicalJson,
      terminalPayloadHash,
      terminalPayloadByteCount: terminalPayload.byteCount,
      findingCount: terminalPayload.findingCount,
      issuedAtMs,
      retainUntilMs,
    };
    const recordHash = await digestUtf8(
      this.dependencies.digest,
      stableJson(
        investigationShadowEvidenceRecordCanonicalValue(withoutRecordHash),
      ),
    );
    const candidate = createInvestigationShadowEvidence({
      ...withoutRecordHash,
      recordHash,
    });
    const persisted = await this.dependencies.records.persist(candidate);
    if (
      persisted.status === InvestigationShadowEvidencePersistenceStatus.Conflict
    ) {
      throw new Error("investigation_shadow_evidence_conflict");
    }
    return Object.freeze({
      status:
        persisted.status ===
        InvestigationShadowEvidencePersistenceStatus.Persisted
          ? ProjectInvestigationShadowEvidenceStatus.Projected
          : ProjectInvestigationShadowEvidenceStatus.Idempotent,
      evidence: persisted.evidence,
    });
  }
}

function assertSourceCertificateBinding(
  source: InvestigationShadowEvidenceProjectionSource,
): void {
  const certificate = source.certificate;
  if (
    certificate.investigationId !== source.investigationId ||
    certificate.investigationVersion + 1 !== source.investigationVersion ||
    certificate.dossierDigest !== source.certifiedDossierDigest ||
    certificate.reviewRevisionHash !== source.revision.reviewRevisionHash ||
    certificate.stableReviewUnitKey !== source.stableReviewUnitKey ||
    certificate.providerVoteLaneId !== source.providerVoteLaneId ||
    certificate.coverageContractVersion !== source.coverageContractVersion ||
    certificate.expansionRulesVersion !== source.expansionRulesVersion ||
    certificate.gatewayPolicyVersion !== source.gatewayPolicyVersion ||
    certificate.criticPolicyVersion !== source.criticPolicyVersion ||
    certificate.runtimeProfileVersion !== source.runtimeProfileVersion ||
    certificate.producerReleaseId !== source.producerReleaseId ||
    certificate.conclusion !== source.conclusion
  ) {
    throw new Error("investigation_shadow_certificate_binding_mismatch");
  }
}

async function digestUtf8(
  digest: Sha256DigestPort,
  value: string,
): Promise<string> {
  return digest.digest(new TextEncoder().encode(value));
}

function strictTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (
    !Number.isSafeInteger(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${field}_invalid`);
  }
  return timestamp;
}
