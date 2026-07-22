import type { NormalizedReviewFinding } from "./review-observation";
import {
  assertBoundedString,
  assertIdentifier,
  assertPositiveInteger,
  assertSha256,
} from "./review-evidence-primitives";
import { stableJson } from "./provider-invocation-manifest";

export const findingLineageCandidateDomain =
  "rr.finding-lineage-candidate.v1\0";

/**
 * Candidate facts only. The projection/lifecycle context owns lineage IDs,
 * matching decisions and occurrence state.
 */
export type FindingLineageCandidateFacts = Readonly<{
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  category: string;
  normalizedFailureModeHash: string;
  symbolAnchor: string | null;
  trustedMarker: string | null;
}>;

export type FindingOccurrenceEvidenceCandidate = Readonly<{
  observationId: string;
  providerVoteIdentityHash: string;
  reviewRevisionHash: string;
  finding: NormalizedReviewFinding;
}>;

export function findingLineageCandidatePreimage(
  candidate: FindingLineageCandidateFacts,
): Uint8Array {
  assertIdentifier(
    candidate.scmRepositoryIdentityId,
    "scm_repository_identity_id",
  );
  assertPositiveInteger(candidate.pullRequestNumber, "pull_request_number");
  assertBoundedString(candidate.category, "finding_category", 128);
  assertSha256(
    candidate.normalizedFailureModeHash,
    "normalized_failure_mode_hash",
  );
  if (candidate.symbolAnchor !== null) {
    assertBoundedString(candidate.symbolAnchor, "symbol_anchor", 512);
  }
  if (candidate.trustedMarker !== null) {
    assertIdentifier(candidate.trustedMarker, "trusted_marker");
  }
  return new TextEncoder().encode(
    `${findingLineageCandidateDomain}${stableJson([
      candidate.scmRepositoryIdentityId,
      candidate.pullRequestNumber,
      candidate.category,
      candidate.normalizedFailureModeHash,
      candidate.symbolAnchor,
      candidate.trustedMarker,
    ])}`,
  );
}

export function createFindingOccurrenceEvidenceCandidate(
  candidate: FindingOccurrenceEvidenceCandidate,
): FindingOccurrenceEvidenceCandidate {
  assertIdentifier(candidate.observationId, "observation_id");
  assertSha256(
    candidate.providerVoteIdentityHash,
    "provider_vote_identity_hash",
  );
  assertSha256(candidate.reviewRevisionHash, "review_revision_hash");
  return Object.freeze({
    ...candidate,
    finding: Object.freeze({
      ...candidate.finding,
      evidence: Object.freeze([...candidate.finding.evidence]),
    }),
  });
}
