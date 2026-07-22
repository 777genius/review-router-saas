import {
  normalizeProviderInvocationManifest,
  type ProviderInvocationManifest,
} from "../../domain/provider-invocation-manifest";
import {
  ReuseEligibility,
  ReviewReuseDenialReason,
  decideReviewReuseEligibility,
  selectDeterministicReviewObservations,
  type ReviewReuseDecision,
} from "../../domain/review-reuse-eligibility";
import {
  assertEpochMilliseconds,
  assertIdentifier,
  assertSha256,
  normalizeReviewEvidenceScope,
  normalizeReviewRevision,
  type ReviewEvidenceScope,
  type ReviewRevision,
  type ReviewTrustDomain,
  ReviewTrustDomain as ReviewTrustDomainValue,
} from "../../domain/review-evidence-primitives";
import type { CurrentReviewReusePolicyPort } from "../ports/review-evidence-safety-port";
import type { ReviewObservationQueryPort } from "../ports/review-observation-ports";
import type { Sha256DigestPort } from "../ports/sha256-digest-port";
import { buildProviderInvocationIdentity } from "./build-provider-invocation-identity";

export const reviewEvidenceMaxLookupCandidates = 100;

export enum LookupReviewEvidenceStatus {
  Hit = "hit",
  Shadow = "shadow",
  Miss = "miss",
}

export type LookupReviewEvidenceQuery = Readonly<{
  scope: ReviewEvidenceScope;
  revision: ReviewRevision;
  planHash: string;
  executionId: string;
  manifest: ProviderInvocationManifest;
  manifestKey: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  trustDomain: ReviewTrustDomain;
}>;

export type LookupReviewEvidenceResult = Readonly<{
  status: LookupReviewEvidenceStatus;
  selected: ReviewReuseDecision | null;
  considered: number;
  denialReasons: readonly ReviewReuseDenialReason[];
}>;

export class LookupReviewEvidence {
  constructor(
    private readonly dependencies: Readonly<{
      observations: ReviewObservationQueryPort;
      policy: CurrentReviewReusePolicyPort;
      digest: Sha256DigestPort;
      nowMs: () => number;
    }>,
  ) {}

  async execute(
    query: LookupReviewEvidenceQuery,
  ): Promise<LookupReviewEvidenceResult> {
    const scope = normalizeReviewEvidenceScope(query.scope);
    const revision = normalizeReviewRevision(query.revision);
    const manifest = normalizeProviderInvocationManifest(query.manifest);
    assertSha256(query.planHash, "plan_hash");
    assertIdentifier(query.executionId, "execution_id");
    assertSha256(query.manifestKey, "manifest_key");
    assertSha256(query.providerInvocationKey, "provider_invocation_key");
    assertSha256(query.providerVoteIdentityHash, "provider_vote_identity_hash");
    if (query.trustDomain === ReviewTrustDomainValue.Unknown) {
      throw new Error("review_trust_domain_unknown");
    }
    const canonicalIdentity = await buildProviderInvocationIdentity(
      this.dependencies.digest,
      {
        manifest,
        providerVoteIdentityHash: query.providerVoteIdentityHash,
      },
    );
    if (
      canonicalIdentity.manifestKey !== query.manifestKey ||
      canonicalIdentity.providerInvocationKey !== query.providerInvocationKey
    ) {
      return miss([ReviewReuseDenialReason.ManifestMismatch]);
    }
    const nowMs = this.dependencies.nowMs();
    assertEpochMilliseconds(nowMs, "now_ms");
    const policy = await this.dependencies.policy.resolveReviewReusePolicy({
      scope,
      revision,
      providerKind: manifest.providerKind,
      taskKindSet: manifest.taskKindSet,
      trustDomain: query.trustDomain,
      producerReleaseId: manifest.producerReleaseId,
    });
    if (!policy) {
      return miss([ReviewReuseDenialReason.UnknownCompatibility]);
    }
    assertSha256(
      policy.safetyDecision.safetyDecisionHash,
      "reuse_safety_decision_hash",
    );
    const candidates = await this.dependencies.observations.findCandidates({
      scope,
      trustDomain: query.trustDomain,
      providerInvocationKey: canonicalIdentity.providerInvocationKey,
      reusableAfterMs: nowMs,
      limit: reviewEvidenceMaxLookupCandidates,
    });
    const decisions = candidates.map((observation) =>
      decideReviewReuseEligibility(observation, {
        scope,
        revision,
        planHash: query.planHash,
        executionId: query.executionId,
        manifest,
        manifestKey: canonicalIdentity.manifestKey,
        providerInvocationKey: canonicalIdentity.providerInvocationKey,
        providerVoteIdentityHash: query.providerVoteIdentityHash,
        trustDomain: query.trustDomain,
        nowMs,
        safetyDecision: policy.safetyDecision,
        compatibility: policy.compatibility,
      }),
    );
    const selected =
      selectDeterministicReviewObservations(decisions)[0] ?? null;
    const denialReasons = uniqueSortedDenials(decisions);
    if (selected) {
      return Object.freeze({
        status: LookupReviewEvidenceStatus.Hit,
        selected,
        considered: decisions.length,
        denialReasons,
      });
    }
    const shadow = decisions.find(
      (decision) => decision.eligibility === ReuseEligibility.CandidateOnly,
    );
    return Object.freeze({
      status: shadow
        ? LookupReviewEvidenceStatus.Shadow
        : LookupReviewEvidenceStatus.Miss,
      selected: shadow ?? null,
      considered: decisions.length,
      denialReasons,
    });
  }
}

function uniqueSortedDenials(
  decisions: readonly ReviewReuseDecision[],
): readonly ReviewReuseDenialReason[] {
  return Object.freeze(
    [...new Set(decisions.map((decision) => decision.reason))]
      .filter((reason) => reason !== ReviewReuseDenialReason.None)
      .sort(),
  );
}

function miss(
  denialReasons: readonly ReviewReuseDenialReason[],
): LookupReviewEvidenceResult {
  return Object.freeze({
    status: LookupReviewEvidenceStatus.Miss,
    selected: null,
    considered: 0,
    denialReasons: Object.freeze([...denialReasons]),
  });
}
