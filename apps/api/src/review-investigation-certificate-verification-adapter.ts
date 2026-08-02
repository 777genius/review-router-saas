import type { InvestigationStorePort } from "@reviewrouter/features-review-investigations";
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
  canonicalInvestigationCertificateCandidate,
  summarizeTerminalDiscoveryProvenance,
  type InvestigationDigestPort,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationDenialReason,
  InvestigationCertificateVerificationStatus,
  type AcceptedInvestigationCertificateVerificationPort,
  type VerifyInvestigationCertificateQuery,
} from "@reviewrouter/features-review-evidence";

export class ReviewInvestigationCertificateVerificationAdapter implements AcceptedInvestigationCertificateVerificationPort {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly digest: InvestigationDigestPort,
  ) {}

  async verifyAcceptedCertificate(query: VerifyInvestigationCertificateQuery) {
    const investigation = await this.store.findByCertificateId(
      query.certificateId,
    );
    if (!investigation) return denied(
      InvestigationCertificateVerificationDenialReason.NotFound,
    );
    const certificate = investigation.certificate;
    if (
      !certificate ||
      ![
        ReviewInvestigationState.Concluded,
        ReviewInvestigationState.Inconclusive,
      ].includes(investigation.state)
    ) {
      return denied(InvestigationCertificateVerificationDenialReason.NotAccepted);
    }
    if (certificate.certificateHash !== query.certificateHash) {
      return denied(InvestigationCertificateVerificationDenialReason.HashMismatch);
    }
    const { certificateHash: _, ...candidate } = certificate;
    const terminalProvenance = summarizeTerminalDiscoveryProvenance(
      investigation.turnProvenance,
    );
    if (
      (await this.digest.digestUtf8(
        canonicalInvestigationCertificateCandidate(candidate),
      )) !== certificate.certificateHash ||
      (await this.digest.digestUtf8(
        certificate.terminalObservationCanonicalJson,
      )) !== certificate.terminalOutcomeHash ||
      certificate.investigationId !== investigation.investigationId ||
      certificate.investigationVersion + 1 !== investigation.version ||
      certificate.conclusion !== investigation.conclusion ||
      certificate.criticDecision !== investigation.criticDecision ||
      certificate.terminalProviderKind !== terminalProvenance.providerKind ||
      certificate.terminalActualModel !== terminalProvenance.actualModel
    ) {
      return denied(InvestigationCertificateVerificationDenialReason.NotAccepted);
    }
    if (new Date(certificate.expiresAt).getTime() <= query.nowMs) {
      return denied(InvestigationCertificateVerificationDenialReason.Expired);
    }
    if (
      investigation.scope.workspaceId !== query.scope.workspaceId ||
      investigation.scope.repositoryConnectionId !==
        query.scope.repositoryConnectionId ||
      investigation.scope.scmRepositoryIdentityId !==
        query.scope.scmRepositoryIdentityId ||
      investigation.scope.pullRequestNumber !== query.scope.pullRequestNumber ||
      investigation.scope.authorizationScopeHash !==
        query.scope.authorizationScopeHash
    ) {
      return denied(InvestigationCertificateVerificationDenialReason.ScopeMismatch);
    }
    if (
      investigation.revision.baseSha !== query.revision.baseSha ||
      investigation.revision.mergeBaseSha !== query.revision.mergeBaseSha ||
      investigation.revision.headSha !== query.revision.headSha ||
      certificate.reviewRevisionHash !== query.revision.reviewRevisionHash
    ) {
      return denied(InvestigationCertificateVerificationDenialReason.RevisionMismatch);
    }
    if (certificate.providerVoteLaneId !== query.providerVoteIdentityHash) {
      return denied(InvestigationCertificateVerificationDenialReason.VoteLaneMismatch);
    }
    if (certificate.terminalOutcomeHash !== query.terminalOutcomeHash) {
      return denied(
        InvestigationCertificateVerificationDenialReason.TerminalOutcomeMismatch,
      );
    }
    const conclusion = toEvidenceConclusion(certificate.conclusion);
    if (conclusion !== query.expectedConclusion) {
      return denied(
        InvestigationCertificateVerificationDenialReason.ConclusionMismatch,
      );
    }
    if (certificate.producerReleaseId !== query.producerReleaseId) {
      return denied(
        InvestigationCertificateVerificationDenialReason.ProducerReleaseMismatch,
      );
    }
    return Object.freeze({
      status: InvestigationCertificateVerificationStatus.Accepted,
      reason: InvestigationCertificateVerificationDenialReason.None,
      acceptedCertificateHash: certificate.certificateHash,
      conclusion,
    });
  }
}

function denied(reason: InvestigationCertificateVerificationDenialReason) {
  return Object.freeze({
    status: InvestigationCertificateVerificationStatus.Denied,
    reason,
    acceptedCertificateHash: null,
    conclusion: null,
  });
}

function toEvidenceConclusion(
  conclusion: ReviewInvestigationConclusion,
): InvestigationCertificateConclusion {
  switch (conclusion) {
    case ReviewInvestigationConclusion.VerifiedClean:
      return InvestigationCertificateConclusion.VerifiedClean;
    case ReviewInvestigationConclusion.Findings:
      return InvestigationCertificateConclusion.Findings;
    case ReviewInvestigationConclusion.Inconclusive:
      return InvestigationCertificateConclusion.Inconclusive;
  }
}
