import { createHash } from "node:crypto";
import {
  canonicalReviewPublicationNoEffectProof,
  type ReviewPublicationOperationCapabilityFacts,
} from "../domain/review-publication-attempt";

export function reviewPublicationNoEffectProofHash(input: {
  readonly capability: ReviewPublicationOperationCapabilityFacts;
  readonly noEffectProofId: string;
  readonly noEffectReason: string;
}): string {
  return createHash("sha256")
    .update(canonicalReviewPublicationNoEffectProof(input))
    .digest("hex");
}
