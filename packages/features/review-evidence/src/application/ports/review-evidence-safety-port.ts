import type {
  ReviewProviderKind,
  ReviewTaskKind,
  ReviewEvidenceScope,
  ReviewRevision,
  ReviewTrustDomain,
} from "../../domain/review-evidence-primitives";
import type {
  ReviewReuseCompatibilityPolicy,
  ReviewReuseSafetyDecision,
} from "../../domain/review-reuse-eligibility";

export type EvidenceWriteSafetyDecision = Readonly<{
  effectAllowed: boolean;
  safetyDecisionHash: string;
}>;

export interface CurrentEvidenceWriteSafetyDecisionPort {
  resolveEvidenceWriteDecision(input: {
    readonly scope: ReviewEvidenceScope;
    readonly providerKind: ReviewProviderKind;
    readonly taskKindSet: readonly ReviewTaskKind[];
  }): Promise<EvidenceWriteSafetyDecision>;
}

export interface CurrentReviewReusePolicyPort {
  resolveReviewReusePolicy(input: {
    readonly scope: ReviewEvidenceScope;
    readonly revision: ReviewRevision;
    readonly providerKind: ReviewProviderKind;
    readonly taskKindSet: readonly ReviewTaskKind[];
    readonly trustDomain: ReviewTrustDomain;
    readonly producerReleaseId: string;
  }): Promise<Readonly<{
    safetyDecision: ReviewReuseSafetyDecision;
    compatibility: ReviewReuseCompatibilityPolicy;
  }> | null>;
}
