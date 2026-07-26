import {
  currentReviewProjectionPolicyVersion,
  legacyReviewProjectionPolicyVersion,
} from "@reviewrouter/features-review-publishing/v2";
import { describe, expect, it } from "vitest";
import {
  resolveReviewActionV2ProjectionPolicyVersion,
  reviewActionV2ProjectionPolicyVersion,
} from "./review-action-v2-projection-policy.js";

describe("Review Action v2 projection policy compatibility", () => {
  it("uses the current publishing policy for new configuration", () => {
    expect(reviewActionV2ProjectionPolicyVersion).toBe(
      currentReviewProjectionPolicyVersion,
    );
  });

  it("accepts every policy the publishing domain can render", () => {
    expect(
      resolveReviewActionV2ProjectionPolicyVersion(
        legacyReviewProjectionPolicyVersion,
      ),
    ).toBe(legacyReviewProjectionPolicyVersion);
    expect(
      resolveReviewActionV2ProjectionPolicyVersion(
        currentReviewProjectionPolicyVersion,
      ),
    ).toBe(currentReviewProjectionPolicyVersion);
  });

  it.each(["review-projection-policy.v1-t0", "", null, 3])(
    "rejects unsupported policy %j",
    (value) => {
      expect(resolveReviewActionV2ProjectionPolicyVersion(value)).toBeNull();
    },
  );
});
