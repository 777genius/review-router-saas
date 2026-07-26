import {
  currentReviewProjectionPolicyVersion,
  resolveReviewPublicationRenderPolicyVersion,
} from "@reviewrouter/features-review-publishing/v2";

export const reviewActionV2ProjectionPolicyVersion =
  currentReviewProjectionPolicyVersion;

export function resolveReviewActionV2ProjectionPolicyVersion(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  try {
    resolveReviewPublicationRenderPolicyVersion(value);
    return value;
  } catch {
    return null;
  }
}
