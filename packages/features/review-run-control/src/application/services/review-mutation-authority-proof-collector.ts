import type { ReviewMutationAuthority } from "../../domain/review-mutation-authority";
import {
  ReviewMutationAuthorityProofKind,
  ReviewMutationAuthorityProofVersion,
  reviewMutationAuthorityProofCanonicalJson,
  sealReviewMutationAuthorityProof,
  validateReviewMutationAuthorityProofReference,
  type ReviewMutationAuthorityProof,
  type ReviewMutationAuthorityProofReference,
  type UnsealedReviewMutationAuthorityProof,
} from "../../domain/review-mutation-authority-proof";
import {
  ReviewMutationLaneKind,
  ReviewRunControlDomainError,
  ReviewRunControlErrorCode,
} from "../../domain/review-run-control-types";
import type { Sha256DigestPort } from "../ports/platform-ports";
import type { ReviewMutationAuthorityProofFactsQueryPorts } from "../ports/review-mutation-authority-proof-ports";

export const DEFAULT_REVIEW_MUTATION_AUTHORITY_PROOF_TTL_MS = 60_000;

type ReviewMutationAuthorityProofTarget = {
  readonly scmRepositoryIdentityId: string;
  readonly laneKind: ReviewMutationAuthority["laneKind"];
  readonly authorityVersion: number;
};

export class ReviewMutationAuthorityProofCollector {
  private readonly proofTtlMs: number;

  constructor(
    private readonly dependencies: {
      readonly digest: Sha256DigestPort;
      readonly facts: ReviewMutationAuthorityProofFactsQueryPorts;
      readonly proofTtlMs?: number;
    },
  ) {
    this.proofTtlMs =
      dependencies.proofTtlMs ?? DEFAULT_REVIEW_MUTATION_AUTHORITY_PROOF_TTL_MS;
    if (!Number.isSafeInteger(this.proofTtlMs) || this.proofTtlMs <= 0) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.InvalidArgument,
        "mutation_authority_proof_ttl_invalid",
      );
    }
  }

  async collect(
    kind: ReviewMutationAuthorityProofKind,
    authority: ReviewMutationAuthority,
    observedAt: Date,
  ): Promise<ReviewMutationAuthorityProof> {
    return this.collectAt(
      kind,
      targetFromAuthority(authority),
      observedAt.toISOString(),
      new Date(observedAt.getTime() + this.proofTtlMs).toISOString(),
    );
  }

  async collectDirectV2Initialization(
    scmRepositoryIdentityId: string,
    observedAt: Date,
  ): Promise<ReviewMutationAuthorityProof> {
    return this.collectAt(
      ReviewMutationAuthorityProofKind.DirectV2Initialize,
      directV2InitializationTarget(scmRepositoryIdentityId),
      observedAt.toISOString(),
      new Date(observedAt.getTime() + this.proofTtlMs).toISOString(),
    );
  }

  async revalidate(
    kind: ReviewMutationAuthorityProofKind,
    authority: ReviewMutationAuthority,
    reference: ReviewMutationAuthorityProofReference,
    now: Date,
  ): Promise<ReviewMutationAuthorityProof> {
    return this.revalidateTarget(
      kind,
      {
        scmRepositoryIdentityId: authority.scmRepositoryIdentityId,
        laneKind: authority.laneKind,
        authorityVersion: reference.authorityVersion,
      },
      reference,
      now,
    );
  }

  async revalidateDirectV2Initialization(
    scmRepositoryIdentityId: string,
    reference: ReviewMutationAuthorityProofReference,
    now: Date,
  ): Promise<ReviewMutationAuthorityProof> {
    return this.revalidateTarget(
      ReviewMutationAuthorityProofKind.DirectV2Initialize,
      directV2InitializationTarget(scmRepositoryIdentityId),
      reference,
      now,
    );
  }

  private async revalidateTarget(
    kind: ReviewMutationAuthorityProofKind,
    target: ReviewMutationAuthorityProofTarget,
    reference: ReviewMutationAuthorityProofReference,
    now: Date,
  ): Promise<ReviewMutationAuthorityProof> {
    validateReviewMutationAuthorityProofReference(reference);
    if (
      reference.kind !== kind ||
      reference.scmRepositoryIdentityId !== target.scmRepositoryIdentityId ||
      reference.laneKind !== target.laneKind ||
      reference.authorityVersion !== target.authorityVersion
    ) {
      throw proofRequired("mutation_authority_proof_scope_mismatch");
    }
    const observedAtMs = Date.parse(reference.observedAt);
    const expiresAtMs = Date.parse(reference.expiresAt);
    const canonicalExpiryMs = observedAtMs + this.proofTtlMs;
    if (canonicalExpiryMs !== expiresAtMs) {
      throw proofRequired("mutation_authority_proof_expiry_mismatch");
    }
    if (observedAtMs > now.getTime() || now.getTime() > expiresAtMs) {
      throw proofRequired("mutation_authority_proof_stale");
    }
    const current = await this.collectAt(
      kind,
      target,
      reference.observedAt,
      reference.expiresAt,
    );
    if (current.proofDigest !== reference.proofDigest) {
      throw proofRequired("mutation_authority_proof_facts_changed");
    }
    return current;
  }

  private async collectAt(
    kind: ReviewMutationAuthorityProofKind,
    target: ReviewMutationAuthorityProofTarget,
    observedAt: string,
    expiresAt: string,
  ): Promise<ReviewMutationAuthorityProof> {
    const query = {
      scmRepositoryIdentityId: target.scmRepositoryIdentityId,
      laneKind: target.laneKind,
    } as const;
    let unsealed: UnsealedReviewMutationAuthorityProof;
    switch (kind) {
      case ReviewMutationAuthorityProofKind.DirectV2Initialize: {
        const snapshot =
          await this.dependencies.facts.inspectDirectV2InitializationFacts(
            query,
          );
        unsealed = {
          proofVersion: ReviewMutationAuthorityProofVersion.V1,
          kind,
          scmRepositoryIdentityId: target.scmRepositoryIdentityId,
          laneKind: target.laneKind,
          authorityVersion: target.authorityVersion,
          factsVersion: snapshot.factsVersion,
          observedAt,
          expiresAt,
          facts: snapshot.facts,
        };
        break;
      }
      case ReviewMutationAuthorityProofKind.AbortDrain: {
        const snapshot =
          await this.dependencies.facts.inspectAbortDrainFacts(query);
        unsealed = {
          proofVersion: ReviewMutationAuthorityProofVersion.V1,
          kind,
          scmRepositoryIdentityId: target.scmRepositoryIdentityId,
          laneKind: target.laneKind,
          authorityVersion: target.authorityVersion,
          factsVersion: snapshot.factsVersion,
          observedAt,
          expiresAt,
          facts: snapshot.facts,
        };
        break;
      }
      case ReviewMutationAuthorityProofKind.Activate: {
        const snapshot =
          await this.dependencies.facts.inspectActivationFacts(query);
        unsealed = {
          proofVersion: ReviewMutationAuthorityProofVersion.V1,
          kind,
          scmRepositoryIdentityId: target.scmRepositoryIdentityId,
          laneKind: target.laneKind,
          authorityVersion: target.authorityVersion,
          factsVersion: snapshot.factsVersion,
          observedAt,
          expiresAt,
          facts: snapshot.facts,
        };
        break;
      }
      case ReviewMutationAuthorityProofKind.Resume: {
        const snapshot =
          await this.dependencies.facts.inspectResumeFacts(query);
        unsealed = {
          proofVersion: ReviewMutationAuthorityProofVersion.V1,
          kind,
          scmRepositoryIdentityId: target.scmRepositoryIdentityId,
          laneKind: target.laneKind,
          authorityVersion: target.authorityVersion,
          factsVersion: snapshot.factsVersion,
          observedAt,
          expiresAt,
          facts: snapshot.facts,
        };
        break;
      }
    }
    const proofDigest = await this.dependencies.digest.digestUtf8(
      reviewMutationAuthorityProofCanonicalJson(unsealed),
    );
    return sealReviewMutationAuthorityProof(unsealed, proofDigest);
  }
}

function targetFromAuthority(
  authority: ReviewMutationAuthority,
): ReviewMutationAuthorityProofTarget {
  return {
    scmRepositoryIdentityId: authority.scmRepositoryIdentityId,
    laneKind: authority.laneKind,
    authorityVersion: authority.version,
  };
}

function directV2InitializationTarget(
  scmRepositoryIdentityId: string,
): ReviewMutationAuthorityProofTarget {
  return {
    scmRepositoryIdentityId,
    laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    authorityVersion: 0,
  };
}

function proofRequired(message: string): ReviewRunControlDomainError {
  return new ReviewRunControlDomainError(
    ReviewRunControlErrorCode.ProofRequired,
    message,
  );
}
