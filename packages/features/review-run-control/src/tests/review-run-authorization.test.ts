import { describe, expect, it } from "vitest";
import {
  CapabilityAudience,
  CapabilityKind,
  CapabilityVerificationErrorCode,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ReviewRunAuthorizationDenialReason,
  ReviewRunAuthorizationTokenResolutionStatus,
  ReviewRunAuthorizationUseCaseStatus,
} from "../application/use-cases/manage-review-run-authorizations";
import {
  ReviewRunAuthorizationState,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTrustDomain,
} from "../domain/review-run-control-types";
import { ReviewRunAuthorizationSignedCapabilityAdapter } from "../infrastructure/signed-capabilities/review-run-authorization-token-adapter";
import { reviewRunControlContractDescriptor } from "../contract-source";
import {
  createReviewRunControlTestKit,
  testSigningSecret,
} from "../testing/review-run-control-test-kit";
import {
  hashA,
  hashC,
  provisionV2AuthorizationContext,
  shaA,
} from "./fixtures";

describe("ReviewRunAuthorization", () => {
  it("declares the exact signed-capability profile and decimal wire epoch", () => {
    expect(reviewRunControlContractDescriptor.authorizationCapability).toEqual({
      issuer: "reviewrouter-review-run-control",
      audience: "review_run",
      kind: "run_authorization",
      mutationEpoch: "unsigned_decimal_string",
    });
    expect(reviewRunControlContractDescriptor.wireRepresentations).toEqual({
      mutationEpoch: "unsigned_decimal_string",
    });
    expect(reviewRunControlContractDescriptor.trustDomains).toEqual([
      "trusted_managed",
      "trusted_local",
      "untrusted_contribution",
    ]);
  });

  it("authorizes once and restores the same row/token claims after a lost response", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun(
      fixture.authorizeInput,
    );
    expect(first.status).toBe(ReviewRunAuthorizationUseCaseStatus.Authorized);
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    kit.clock.advance(5_000);
    const retry = await kit.control.authorizations.authorizeReviewRun(
      fixture.authorizeInput,
    );
    expect(retry.status).toBe(ReviewRunAuthorizationUseCaseStatus.Restored);
    if (!("authorization" in retry)) {
      throw new Error("authorization_retry_failed");
    }
    expect(retry.authorization.authorizationId).toBe(
      first.authorization.authorizationId,
    );
    await expect(
      kit.tokens.verify({ token: retry.token.token, now: kit.clock.now() }),
    ).resolves.toMatchObject({
      authorizationId: first.authorization.authorizationId,
      mutationEpoch: 1n,
      audience: "review_run",
    });
  });

  it("rejects replay-key drift and a second authorization for the same run attempt", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    await kit.control.authorizations.authorizeReviewRun(fixture.authorizeInput);
    const replayDrift = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      verifiedIdentity: {
        ...fixture.verifiedIdentity,
        headSha: shaA,
        reviewRevisionHash: hashC,
      },
    });
    expect(replayDrift.status).toBe(
      ReviewRunAuthorizationUseCaseStatus.Conflict,
    );
    const secondReplay = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      oidcReplayKeyHash: hashC,
    });
    expect(secondReplay.status).toBe(
      ReviewRunAuthorizationUseCaseStatus.Conflict,
    );
  });

  it("admits only the closed persisted trust-domain set", async () => {
    for (const trustDomain of [
      ReviewTrustDomain.TrustedManaged,
      ReviewTrustDomain.TrustedLocal,
      ReviewTrustDomain.UntrustedContribution,
    ]) {
      const kit = createReviewRunControlTestKit();
      const fixture = await provisionV2AuthorizationContext(kit);
      const result = await kit.control.authorizations.authorizeReviewRun({
        ...fixture.authorizeInput,
        verifiedIdentity: { ...fixture.verifiedIdentity, trustDomain },
      });
      expect(result.status).toBe(
        ReviewRunAuthorizationUseCaseStatus.Authorized,
      );
      if ("authorization" in result) {
        expect(result.authorization.trustDomain).toBe(trustDomain);
      }
    }

    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    await expect(
      kit.control.authorizations.authorizeReviewRun({
        ...fixture.authorizeInput,
        verifiedIdentity: {
          ...fixture.verifiedIdentity,
          trustDomain: "unknown_trust_domain" as ReviewTrustDomain,
        },
      }),
    ).rejects.toThrow("trust_domain_invalid");
  });

  it("rejects trust-domain drift during renewal", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun(
      fixture.authorizeInput,
    );
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    const result = await kit.control.authorizations.renewReviewRunAuthorization(
      {
        authorizationId: first.authorization.authorizationId,
        verifiedIdentity: {
          ...fixture.verifiedIdentity,
          trustDomain: ReviewTrustDomain.UntrustedContribution,
        },
        renewalReplayKeyHash: hashC,
        requestedTtlMs: 20_000,
      },
    );
    expect(result).toEqual({
      status: ReviewRunAuthorizationUseCaseStatus.Denied,
      reason: ReviewRunAuthorizationDenialReason.VerifiedIdentityDrift,
    });
  });

  it("restores across signing-key rotation and retains the old token through its report window", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      authorizationTtlMs: 10_000,
    });
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    kit.tokenKeyRing.rotate({
      keyId: "test-key-v2",
      secret: testSigningSecret("review-run-control-test-secret-v2"),
    });
    const restored = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      authorizationTtlMs: 10_000,
    });
    expect(restored.status).toBe(ReviewRunAuthorizationUseCaseStatus.Restored);
    if (!("authorization" in restored)) {
      throw new Error("authorization_restore_failed");
    }
    expect(restored.authorization.authorizationId).toBe(
      first.authorization.authorizationId,
    );
    expect(restored.authorization.tokenSigningKeyId).toBe("test-key-v1");
    expect(restored.token.keyId).toBe("test-key-v2");

    kit.clock.advance(9_000);
    await expect(
      kit.tokens.verify({ token: first.token.token, now: kit.clock.now() }),
    ).resolves.toMatchObject({
      authorizationId: first.authorization.authorizationId,
    });
    kit.clock.advance(1_000);
    await expect(
      kit.tokens.verify({ token: first.token.token, now: kit.clock.now() }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.Expired,
    });
  });

  it("rejects wrong audience and issuer before context claims are accepted", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun(
      fixture.authorizeInput,
    );
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    const claims = await kit.tokenCodec.verify({
      token: first.token.token,
      expectedIssuer: first.authorization.tokenIssuer,
      expectedAudience: CapabilityAudience.ReviewRun,
      expectedKind: CapabilityKind.RunAuthorization,
      now: kit.clock.now(),
    });
    const wrongAudience = await kit.tokenCodec.sign({
      ...claims,
      audience: CapabilityAudience.ReviewInvocationLease,
    });
    await expect(
      kit.tokens.verify({ token: wrongAudience.token, now: kit.clock.now() }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongAudience,
    });

    const wrongKind = await kit.tokenCodec.sign({
      ...claims,
      kind: CapabilityKind.InvocationLease,
    });
    await expect(
      kit.tokens.verify({ token: wrongKind.token, now: kit.clock.now() }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongKind,
    });

    const wrongIssuerAdapter =
      new ReviewRunAuthorizationSignedCapabilityAdapter(
        kit.tokenCodec,
        kit.tokenKeyRing,
        "untrusted-review-run-control",
      );
    const wrongIssuer = await wrongIssuerAdapter.issue({
      ...first.authorization,
      tokenIssuer: "untrusted-review-run-control",
    });
    await expect(
      kit.tokens.verify({ token: wrongIssuer.token, now: kit.clock.now() }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongIssuer,
    });
  });

  it("reloads the aggregate and rejects signed claim drift without bigint coercion", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun(
      fixture.authorizeInput,
    );
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    const largeEpoch = BigInt(Number.MAX_SAFE_INTEGER) + 17n;
    const drifted = await kit.tokens.issue({
      ...first.authorization,
      schemaDigest: hashA,
      mutationEpoch: largeEpoch,
    });
    await expect(
      kit.tokens.verify({ token: drifted.token, now: kit.clock.now() }),
    ).resolves.toMatchObject({ mutationEpoch: largeEpoch });
    await expect(
      kit.control.authorizations.resolveReviewRunAuthorizationToken({
        token: drifted.token,
      }),
    ).resolves.toEqual({
      status: ReviewRunAuthorizationTokenResolutionStatus.ClaimDrift,
    });
    await expect(
      kit.control.authorizations.resolveReviewRunAuthorizationToken({
        token: first.token.token,
      }),
    ).resolves.toMatchObject({
      status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
      authorization: {
        authorizationId: first.authorization.authorizationId,
      },
    });
  });

  it("expires terminally and cannot recreate the same run", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      authorizationTtlMs: 1_000,
    });
    expect(first.status).toBe(ReviewRunAuthorizationUseCaseStatus.Authorized);
    kit.clock.advance(1_001);
    const expired = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      authorizationTtlMs: 1_000,
    });
    expect(expired.status).toBe(ReviewRunAuthorizationUseCaseStatus.Expired);
  });

  it("renews with fresh identical SCM facts, preserves immutable claims, and clamps max expiry", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun({
      ...fixture.authorizeInput,
      authorizationTtlMs: 10_000,
      maxAuthorizationLifetimeMs: 30_000,
    });
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    kit.clock.advance(5_000);
    const renewed =
      await kit.control.authorizations.renewReviewRunAuthorization({
        authorizationId: first.authorization.authorizationId,
        verifiedIdentity: fixture.verifiedIdentity,
        renewalReplayKeyHash: hashC,
        requestedTtlMs: 60_000,
      });
    expect(renewed.status).toBe(ReviewRunAuthorizationUseCaseStatus.Renewed);
    if (!("authorization" in renewed)) {
      throw new Error("authorization_renewal_failed");
    }
    expect(renewed.authorization.expiresAt).toEqual(
      first.authorization.maxExpiresAt,
    );
    expect(renewed.authorization).toMatchObject({
      authorizationId: first.authorization.authorizationId,
      sourceRunId: first.authorization.sourceRunId,
      reviewRevisionHash: first.authorization.reviewRevisionHash,
      mutationEpoch: first.authorization.mutationEpoch,
      authorizationSafetyDecisionHash:
        first.authorization.authorizationSafetyDecisionHash,
    });
    const renewalRetry =
      await kit.control.authorizations.renewReviewRunAuthorization({
        authorizationId: first.authorization.authorizationId,
        verifiedIdentity: fixture.verifiedIdentity,
        renewalReplayKeyHash: hashC,
        requestedTtlMs: 60_000,
      });
    expect(renewalRetry.status).toBe(
      ReviewRunAuthorizationUseCaseStatus.Restored,
    );
  });

  it("rejects renewal after identity drift, safety fence change, pause, or release revocation", async () => {
    const scenarios = ["identity", "safety", "pause", "release"] as const;
    for (const scenario of scenarios) {
      const kit = createReviewRunControlTestKit();
      const fixture = await provisionV2AuthorizationContext(kit);
      const first = await kit.control.authorizations.authorizeReviewRun(
        fixture.authorizeInput,
      );
      if (!("authorization" in first)) {
        throw new Error("authorization_fixture_failed");
      }
      let verifiedIdentity = fixture.verifiedIdentity;
      if (scenario === "identity") {
        verifiedIdentity = { ...verifiedIdentity, headSha: shaA };
      } else if (scenario === "safety") {
        await kit.control.safetyControls.updateReviewSafetyPolicy({
          expectedVersion: 1,
          scope: { scope: ReviewSafetyPolicyScope.Global },
          capability: ReviewSafetyCapability.RunAuthorizationV2,
          rolloutMode: ReviewSafetyRolloutMode.Enabled,
          updatedBy: "operator-2",
        });
      } else if (scenario === "pause") {
        await kit.control.mutationAuthority.pause({
          scmRepositoryIdentityId:
            fixture.verifiedIdentity.scmRepositoryIdentityId,
          expectedVersion: 1,
        });
      } else {
        await kit.control.producerReleases.revokeProducerRelease("release-1");
      }
      const result =
        await kit.control.authorizations.renewReviewRunAuthorization({
          authorizationId: first.authorization.authorizationId,
          verifiedIdentity,
          renewalReplayKeyHash: hashC,
          requestedTtlMs: 20 * 60_000,
        });
      expect(result.status).toBe(ReviewRunAuthorizationUseCaseStatus.Denied);
      if (result.status === ReviewRunAuthorizationUseCaseStatus.Denied) {
        expect(result.reason).toBe(
          scenario === "identity"
            ? ReviewRunAuthorizationDenialReason.VerifiedIdentityDrift
            : scenario === "safety"
              ? ReviewRunAuthorizationDenialReason.SafetyDecisionChanged
              : scenario === "pause"
                ? ReviewRunAuthorizationDenialReason.MutationAuthorityUnavailable
                : ReviewRunAuthorizationDenialReason.ProducerReleaseUnavailable,
        );
      }
    }
  });

  it("revocation is terminal and idempotent", async () => {
    const kit = createReviewRunControlTestKit();
    const fixture = await provisionV2AuthorizationContext(kit);
    const first = await kit.control.authorizations.authorizeReviewRun(
      fixture.authorizeInput,
    );
    if (!("authorization" in first)) {
      throw new Error("authorization_fixture_failed");
    }
    const revoked =
      await kit.control.authorizations.expireOrRevokeReviewRunAuthorization({
        authorizationId: first.authorization.authorizationId,
        state: ReviewRunAuthorizationState.Revoked,
      });
    expect(revoked.status).toBe("terminated");
    const retry =
      await kit.control.authorizations.expireOrRevokeReviewRunAuthorization({
        authorizationId: first.authorization.authorizationId,
        state: ReviewRunAuthorizationState.Revoked,
      });
    expect(retry.status).toBe("restored");
  });
});
