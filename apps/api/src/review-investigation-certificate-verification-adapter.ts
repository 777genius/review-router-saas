import type { InvestigationStorePort } from "@reviewrouter/features-review-investigations";
import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
  InvestigationTurnProviderKind,
  canonicalContextAttestationSet,
  canonicalInvestigationCertificateCandidate,
  canonicalTurnProvenanceSet,
  latestCriticTurnProvenance,
  summarizeTerminalDiscoveryProvenance,
  type InvestigationDigestPort,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationDenialReason,
  InvestigationCertificateVerificationStatus,
  ReviewProviderKind as EvidenceProviderKind,
  type AcceptedInvestigationCertificateVerificationPort,
  type VerifyInvestigationCertificateQuery,
} from "@reviewrouter/features-review-evidence";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutProvider,
} from "@reviewrouter/features-review-investigation-operations";
import type { ReviewInvestigationRolloutGuardPort } from "./review-investigation-rollout-guard.js";

export class ReviewInvestigationCertificateVerificationAdapter implements AcceptedInvestigationCertificateVerificationPort {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly digest: InvestigationDigestPort,
    private readonly rollout: ReviewInvestigationRolloutGuardPort,
  ) {}

  async verifyAcceptedCertificate(query: VerifyInvestigationCertificateQuery) {
    const investigation = await this.store.findByCertificateId(
      query.certificateId,
    );
    if (!investigation)
      return denied(InvestigationCertificateVerificationDenialReason.NotFound);
    const certificate = investigation.certificate;
    if (
      !certificate ||
      ![
        ReviewInvestigationState.Concluded,
        ReviewInvestigationState.Inconclusive,
      ].includes(investigation.state)
    ) {
      return denied(
        InvestigationCertificateVerificationDenialReason.NotAccepted,
      );
    }
    if (certificate.certificateHash !== query.certificateHash) {
      return denied(
        InvestigationCertificateVerificationDenialReason.HashMismatch,
      );
    }
    const { certificateHash, ...candidate } = certificate;
    void certificateHash;
    const terminalProvenance = summarizeTerminalDiscoveryProvenance(
      investigation.turnProvenance,
    );
    const criticProvenance = latestCriticTurnProvenance(
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
      certificate.terminalActualModel !== terminalProvenance.actualModel ||
      (await this.digest.digestUtf8(
        canonicalTurnProvenanceSet(investigation.turnProvenance),
      )) !== certificate.turnProvenanceHash ||
      (await this.digest.digestUtf8(
        canonicalContextAttestationSet(investigation.turnProvenance),
      )) !== certificate.contextAttestationSetHash ||
      certificate.criticAttestationId !==
        (criticProvenance?.acceptedAttestationId ?? null) ||
      certificate.criticAttestationHash !==
        (criticProvenance?.acceptedAttestationHash ?? null)
    ) {
      return denied(
        InvestigationCertificateVerificationDenialReason.NotAccepted,
      );
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
      return denied(
        InvestigationCertificateVerificationDenialReason.ScopeMismatch,
      );
    }
    if (
      investigation.revision.baseSha !== query.revision.baseSha ||
      investigation.revision.mergeBaseSha !== query.revision.mergeBaseSha ||
      investigation.revision.headSha !== query.revision.headSha ||
      certificate.reviewRevisionHash !== query.revision.reviewRevisionHash
    ) {
      return denied(
        InvestigationCertificateVerificationDenialReason.RevisionMismatch,
      );
    }
    if (certificate.providerVoteLaneId !== query.providerVoteIdentityHash) {
      return denied(
        InvestigationCertificateVerificationDenialReason.VoteLaneMismatch,
      );
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
    const provider = evidenceProvider(query.providerKind);
    const expectedTurnProvider = investigationTurnProvider(query.providerKind);
    if (
      provider === InvestigationRolloutProvider.Unknown ||
      expectedTurnProvider === null ||
      (terminalProvenance.providerKind !== null &&
        terminalProvenance.providerKind !== expectedTurnProvider)
    ) {
      return denied(
        InvestigationCertificateVerificationDenialReason.NotAccepted,
      );
    }
    const rolloutTarget = {
      workspaceId: investigation.scope.workspaceId,
      repositoryConnectionId: investigation.scope.repositoryConnectionId,
      scmRepositoryIdentityId: investigation.scope.scmRepositoryIdentityId,
      provider,
      trustDomain: investigation.scope.trustDomain,
      producerReleaseId: certificate.producerReleaseId,
    } as const;
    try {
      await this.rollout.assertAllowed({
        capability: InvestigationRolloutCapability.Shadow,
        target: rolloutTarget,
      });
    } catch (error) {
      if (
        error instanceof ReviewActionV2RouteFailure &&
        error.statusCode === 503
      ) {
        throw error;
      }
      return denied(
        InvestigationCertificateVerificationDenialReason.NotAccepted,
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

function evidenceProvider(
  provider: EvidenceProviderKind,
): InvestigationRolloutProvider {
  switch (provider) {
    case EvidenceProviderKind.Codex:
      return InvestigationRolloutProvider.Codex;
    case EvidenceProviderKind.ClaudeCode:
      return InvestigationRolloutProvider.Claude;
    case EvidenceProviderKind.OpenRouter:
    case EvidenceProviderKind.Unknown:
      return InvestigationRolloutProvider.Unknown;
  }
}

function investigationTurnProvider(
  provider: EvidenceProviderKind,
): InvestigationTurnProviderKind | null {
  switch (provider) {
    case EvidenceProviderKind.Codex:
      return InvestigationTurnProviderKind.Codex;
    case EvidenceProviderKind.ClaudeCode:
      return InvestigationTurnProviderKind.ClaudeCode;
    case EvidenceProviderKind.OpenRouter:
    case EvidenceProviderKind.Unknown:
      return null;
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
