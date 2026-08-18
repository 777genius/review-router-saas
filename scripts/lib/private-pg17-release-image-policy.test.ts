import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../../packages/features/release-rollout/src/index";
import {
  PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION,
  privatePg17AttestationPolicy,
  privatePg17ReleaseImagePolicy,
} from "./private-pg17-release-image-policy";

describe("private PG17 trusted release image policy", () => {
  it("derives the expected policy digest only from trusted release configuration", () => {
    const input = {
      sourceRepository: "777genius/review-router-saas",
      sourceRevision: "a".repeat(40),
    };
    const policy = privatePg17ReleaseImagePolicy(input);

    expect(policy).toEqual({
      ...input,
      imageRepository: PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.imageRepository,
      verificationPolicySha256: `sha256:${sha256Canonical(
        privatePg17AttestationPolicy(input),
      )}`,
    });
  });

  it("changes the trusted digest when repository ownership or revision changes", () => {
    const canonical = privatePg17ReleaseImagePolicy({
      sourceRepository: "777genius/review-router-saas",
      sourceRevision: "a".repeat(40),
    });
    const alternateRepository = privatePg17ReleaseImagePolicy({
      sourceRepository: "attacker/repository",
      sourceRevision: "a".repeat(40),
    });
    const staleRevision = privatePg17ReleaseImagePolicy({
      sourceRepository: "777genius/review-router-saas",
      sourceRevision: "b".repeat(40),
    });

    expect(alternateRepository.verificationPolicySha256).not.toBe(
      canonical.verificationPolicySha256,
    );
    expect(staleRevision.verificationPolicySha256).not.toBe(
      canonical.verificationPolicySha256,
    );
  });
});
