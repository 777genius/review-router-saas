import { describe, expect, it } from "vitest";
import {
  ImmutableRegistryWriteStatus,
  ProducerReleaseRevocationStatus,
} from "../application/ports/producer-release-ports";
import {
  ScmRepositoryIdentityBindingStatus,
  ScmRepositoryIdentityResolveStatus,
} from "../application/ports/scm-repository-identity-ports";
import {
  ProducerReleaseState,
  ReviewRunControlErrorCode,
  ScmProvider,
} from "../domain/review-run-control-types";
import { createReviewRunControlTestKit } from "../testing/review-run-control-test-kit";
import { ReviewMutationAuthorityCommandKind } from "../application/use-cases/manage-review-mutation-authority";
import { reviewMutationAuthorityProofReference } from "../domain/review-mutation-authority-proof";
import {
  hashA,
  hashB,
  limits,
  limitsDigest,
  releaseCandidate,
  sloDigest,
  sloThresholds,
} from "./fixtures";
import { canonicalReviewProtocolLimits } from "../domain/producer-release";

describe("immutable release registries", () => {
  it("rejects caller-supplied profile digests that do not match canonical bytes", async () => {
    const kit = createReviewRunControlTestKit();
    await expect(
      kit.control.producerReleases.registerProtocolLimitsProfile({
        protocolLimitsProfileId: "limits-forged",
        limitsDigest: hashA,
        limits,
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ImmutableConflict,
      message: "protocol_limits_digest_mismatch",
    });
    await expect(
      kit.control.producerReleases.registerOperationalSloProfile({
        operationalSloProfileId: "slo-forged",
        sloDigest: hashB,
        thresholds: sloThresholds,
        ownerRefs: ["team-reviewrouter"],
        runbookRefs: ["runbook/review-v2"],
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ImmutableConflict,
      message: "operational_slo_digest_mismatch",
    });
  });

  it("registers immutable profiles/release, restores exact retries, and rejects rebinding", async () => {
    const kit = createReviewRunControlTestKit();
    const firstLimits =
      await kit.control.producerReleases.registerProtocolLimitsProfile({
        protocolLimitsProfileId: "limits-1",
        limitsDigest,
        limits,
      });
    kit.clock.advance(1_000);
    const retriedLimits =
      await kit.control.producerReleases.registerProtocolLimitsProfile({
        protocolLimitsProfileId: "limits-1",
        limitsDigest,
        limits,
      });
    expect(firstLimits.status).toBe(ImmutableRegistryWriteStatus.Created);
    expect(retriedLimits.status).toBe(ImmutableRegistryWriteStatus.Restored);

    const changedLimits = { ...limits, maxWorkSlots: limits.maxWorkSlots - 1 };
    const changed =
      await kit.control.producerReleases.registerProtocolLimitsProfile({
        protocolLimitsProfileId: "limits-1",
        limitsDigest: await kit.digest.digestUtf8(
          canonicalReviewProtocolLimits(changedLimits),
        ),
        limits: changedLimits,
      });
    expect(changed.status).toBe(ImmutableRegistryWriteStatus.Conflict);

    await kit.control.producerReleases.registerOperationalSloProfile({
      operationalSloProfileId: "slo-1",
      sloDigest,
      thresholds: sloThresholds,
      ownerRefs: ["team-reviewrouter"],
      runbookRefs: ["runbook/review-v2"],
    });
    const release = await kit.control.producerReleases.registerProducerRelease({
      candidate: releaseCandidate,
      expectedProtocolLimitsDigest: limitsDigest,
      expectedOperationalSloDigest: sloDigest,
    });
    expect(release.status).toBe(ImmutableRegistryWriteStatus.Created);
    const restored = await kit.control.producerReleases.registerProducerRelease(
      {
        candidate: releaseCandidate,
        expectedProtocolLimitsDigest: limitsDigest,
        expectedOperationalSloDigest: sloDigest,
      },
    );
    expect(restored.status).toBe(ImmutableRegistryWriteStatus.Restored);
  });

  it("requires registered matching profiles and never reactivates a revoked release", async () => {
    const kit = createReviewRunControlTestKit();
    await expect(
      kit.control.producerReleases.registerProducerRelease({
        candidate: releaseCandidate,
        expectedProtocolLimitsDigest: limitsDigest,
        expectedOperationalSloDigest: sloDigest,
      }),
    ).rejects.toMatchObject({ code: ReviewRunControlErrorCode.Missing });

    await kit.control.producerReleases.registerProtocolLimitsProfile({
      protocolLimitsProfileId: "limits-1",
      limitsDigest,
      limits,
    });
    await kit.control.producerReleases.registerOperationalSloProfile({
      operationalSloProfileId: "slo-1",
      sloDigest,
      thresholds: sloThresholds,
      ownerRefs: ["team-reviewrouter"],
      runbookRefs: ["runbook/review-v2"],
    });
    await kit.control.producerReleases.registerProducerRelease({
      candidate: releaseCandidate,
      expectedProtocolLimitsDigest: limitsDigest,
      expectedOperationalSloDigest: sloDigest,
    });
    const revoked = await kit.control.producerReleases.revokeProducerRelease(
      releaseCandidate.producerReleaseId,
    );
    expect(revoked.status).toBe(ProducerReleaseRevocationStatus.Revoked);
    const registrationRetry =
      await kit.control.producerReleases.registerProducerRelease({
        candidate: releaseCandidate,
        expectedProtocolLimitsDigest: limitsDigest,
        expectedOperationalSloDigest: sloDigest,
      });
    expect(registrationRetry.status).toBe(
      ImmutableRegistryWriteStatus.Restored,
    );
    if ("value" in registrationRetry) {
      expect(registrationRetry.value.state).toBe(ProducerReleaseState.Revoked);
    }
  });

  it("rejects protocol values above the server-owned absolute ceiling", async () => {
    const kit = createReviewRunControlTestKit();
    await expect(
      kit.control.producerReleases.registerProtocolLimitsProfile({
        protocolLimitsProfileId: "limits-too-large",
        limitsDigest: await kit.digest.digestUtf8(
          canonicalReviewProtocolLimits({ ...limits, maxWorkSlots: 1_001 }),
        ),
        limits: { ...limits, maxWorkSlots: 1_001 },
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.InvalidArgument,
    });
  });
});

describe("ScmRepositoryIdentity", () => {
  it("normalizes and permanently restores the external identity tuple", async () => {
    const kit = createReviewRunControlTestKit();
    const first =
      await kit.control.repositoryIdentities.resolveOrRegisterScmRepositoryIdentity(
        {
          provider: ScmProvider.GitHub,
          sourceBaseUrl: "https://GITHUB.com///",
          externalRepositoryId: "123",
        },
      );
    const retry =
      await kit.control.repositoryIdentities.resolveOrRegisterScmRepositoryIdentity(
        {
          provider: ScmProvider.GitHub,
          sourceBaseUrl: "https://github.com",
          externalRepositoryId: "123",
        },
      );
    expect(first.status).toBe(ScmRepositoryIdentityResolveStatus.Created);
    expect(retry.status).toBe(ScmRepositoryIdentityResolveStatus.Restored);
    expect(retry.identity.scmRepositoryIdentityId).toBe(
      first.identity.scmRepositoryIdentityId,
    );
  });

  it("quarantines conflicting bindings and unbinds only while authority is paused", async () => {
    const kit = createReviewRunControlTestKit();
    const resolved =
      await kit.control.repositoryIdentities.resolveOrRegisterScmRepositoryIdentity(
        {
          provider: ScmProvider.GitHub,
          sourceBaseUrl: "https://github.com",
          externalRepositoryId: "123",
        },
      );
    const bound =
      await kit.control.repositoryIdentities.bindScmRepositoryIdentity({
        scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
        expectedVersion: resolved.identity.version,
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
      });
    expect(bound.status).toBe(ScmRepositoryIdentityBindingStatus.Bound);
    const conflict =
      await kit.control.repositoryIdentities.bindScmRepositoryIdentity({
        scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
        expectedVersion: "identity" in bound ? bound.identity.version : 0,
        workspaceId: "workspace-2",
        repositoryConnectionId: "repository-2",
      });
    expect(conflict.status).toBe(ScmRepositoryIdentityBindingStatus.Conflict);
    const directV2Preflight = await kit.control.mutationAuthority.preflight({
      scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
      operation: ReviewMutationAuthorityCommandKind.DirectV2Initialize,
    });
    if (!("proof" in directV2Preflight) || !directV2Preflight.proof) {
      throw new Error("direct_v2_proof_missing");
    }
    await kit.control.mutationAuthority.initializeDirectV2({
      scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
      proof: reviewMutationAuthorityProofReference(directV2Preflight.proof),
    });
    const beforePause =
      await kit.control.repositoryIdentities.unbindScmRepositoryIdentity({
        scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
        expectedVersion: "identity" in bound ? bound.identity.version : 0,
      });
    expect(beforePause.status).toBe(
      ScmRepositoryIdentityBindingStatus.AuthorityNotPaused,
    );
    const paused = await kit.control.mutationAuthority.pause({
      scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
      expectedVersion: 1,
    });
    expect(paused.status).toBe("updated");
    const unbound =
      await kit.control.repositoryIdentities.unbindScmRepositoryIdentity({
        scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
        expectedVersion: "identity" in bound ? bound.identity.version : 0,
      });
    expect(unbound.status).toBe(ScmRepositoryIdentityBindingStatus.Unbound);
  });
});
