import { canonicalJson, type CanonicalValue } from "./canonicalization";
import type {
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
} from "./review-investigation-types";

export type ReplayEvidenceCheckpoint = Readonly<{
  checkpointId: string;
  checkpointHash: string;
  sourceInvestigationId: string;
  sourceInvestigationVersion: number;
  sourceDossierDigest: string;
  scopeHash: string;
  reviewRevisionHash: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  contractHash: string;
  policyHash: string;
  producerReleaseId: string;
  producerReleaseHash: string;
  runtimeProfileHash: string;
  receiptSetHash: string;
  contextAttestationSetHash: string;
  sourceState: ReviewInvestigationState;
  sourceConclusion: ReviewInvestigationConclusion | null;
  issuedAt: string;
  expiresAt: string;
}>;

export type ReplayEvidenceCheckpointCandidate = Omit<
  ReplayEvidenceCheckpoint,
  "checkpointHash"
>;

export function replayEvidenceCheckpointCanonicalValue(
  checkpoint: ReplayEvidenceCheckpointCandidate,
): CanonicalValue {
  return { ...checkpoint };
}

export function canonicalReplayEvidenceCheckpointCandidate(
  checkpoint: ReplayEvidenceCheckpointCandidate,
): string {
  return canonicalJson(replayEvidenceCheckpointCanonicalValue(checkpoint));
}
