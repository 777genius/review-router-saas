import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  CapabilityAudience,
  CapabilityKind,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  CanonicalReviewRevisionResolutionStatus,
  ReviewScmMergeBaseStatus,
  type GitHubReviewRevisionSourcePort,
  type ReviewScmMergeBaseResult,
  type ReviewScmPullRequestPointer,
} from "../application/ports/review-scm-revision-ports";
import { ProducerReleaseAttestationStatus } from "../application/ports/producer-release-attestation-ports";
import { CanonicalGitHubReviewRevisionResolver } from "../infrastructure/github/canonical-github-review-revision-resolver";
import { ConfiguredProducerReleaseAttestationRegistry } from "../infrastructure/configured-producer-release-attestation";
import {
  createReviewRunAuthorizationKeyRingFromEnv,
  reviewRunAuthorizationActiveKeyIdEnv,
  reviewRunAuthorizationKeysEnv,
} from "../infrastructure/signed-capabilities/env-review-run-authorization-key-ring";
import {
  ProducerDistributionKind,
  ReviewCapabilityProfile,
} from "../domain/review-run-control-types";
import { createReviewRunControlTestKit } from "../testing/review-run-control-test-kit";
import {
  hashA,
  hashB,
  hashC,
  provisionV2AuthorizationContext,
  releaseCandidate,
  shaA,
  shaB,
  shaC,
} from "./fixtures";

class FakeGitHubRevisionSource implements GitHubReviewRevisionSourcePort {
  runPullRequestNumbers: readonly number[] = [42];
  pointers: ReviewScmPullRequestPointer[] = [pointer(shaA, shaC)];
  mergeBaseResult: ReviewScmMergeBaseResult = {
    status: ReviewScmMergeBaseStatus.Resolved,
    mergeBaseSha: shaB,
  } as const;

  async findPullRequestNumbersForRun(): Promise<readonly number[]> {
    return this.runPullRequestNumbers;
  }

  async loadPullRequestPointer(): Promise<ReviewScmPullRequestPointer | null> {
    return this.pointers.shift() ?? null;
  }

  async resolveOfficialMergeBase() {
    return this.mergeBaseResult;
  }
}

describe("production run-authorization prerequisites", () => {
  it.each([
    {
      name: "base movement with unchanged head",
      before: pointer(shaA, shaC),
      after: pointer("d".repeat(40), shaC),
    },
    {
      name: "force-push head movement",
      before: pointer(shaA, shaC),
      after: pointer(shaA, "e".repeat(40)),
    },
  ])("rejects $name during canonical resolution", async ({ before, after }) => {
    const source = new FakeGitHubRevisionSource();
    source.pointers = [before, after];
    const resolver = new CanonicalGitHubReviewRevisionResolver(
      source,
      createReviewRunControlTestKit().digest,
    );

    await expect(resolver.resolve(resolverInput())).resolves.toEqual({
      status: CanonicalReviewRevisionResolutionStatus.RevisionMoved,
    });
  });

  it.each([
    [
      ReviewScmMergeBaseStatus.Unavailable,
      CanonicalReviewRevisionResolutionStatus.MergeBaseUnavailable,
    ],
    [
      ReviewScmMergeBaseStatus.Conflict,
      CanonicalReviewRevisionResolutionStatus.MergeBaseConflict,
    ],
  ] as const)(
    "maps %s official merge-base result fail-closed",
    async (status, expected) => {
      const source = new FakeGitHubRevisionSource();
      source.mergeBaseResult = { status };
      const resolver = new CanonicalGitHubReviewRevisionResolver(
        source,
        createReviewRunControlTestKit().digest,
      );

      await expect(resolver.resolve(resolverInput())).resolves.toEqual({
        status: expected,
      });
    },
  );

  it("attests only an exact registered immutable release tuple", async () => {
    const kit = createReviewRunControlTestKit();
    await provisionV2AuthorizationContext(kit);
    const registry = new ConfiguredProducerReleaseAttestationRegistry(
      [attestation()],
      kit.store,
    );

    await expect(
      registry.attest({
        actionCommitSha: shaA,
        expectedSchemaDigest: hashB,
        expectedCanonicalizerDigest: hashC,
      }),
    ).resolves.toMatchObject({
      status: ProducerReleaseAttestationStatus.Attested,
      release: { producerReleaseId: releaseCandidate.producerReleaseId },
    });
    await expect(
      registry.attest({
        actionCommitSha: shaA,
        expectedSchemaDigest: hashA,
        expectedCanonicalizerDigest: hashC,
      }),
    ).resolves.toEqual({ status: ProducerReleaseAttestationStatus.Mismatch });
    await expect(
      registry.attest({
        actionCommitSha: "f".repeat(40),
        expectedSchemaDigest: hashB,
        expectedCanonicalizerDigest: hashC,
      }),
    ).resolves.toEqual({
      status: ProducerReleaseAttestationStatus.Unregistered,
    });
  });

  it("rejects a configured release after server-side revocation", async () => {
    const kit = createReviewRunControlTestKit();
    await provisionV2AuthorizationContext(kit);
    const registry = new ConfiguredProducerReleaseAttestationRegistry(
      [attestation()],
      kit.store,
    );
    await kit.control.producerReleases.revokeProducerRelease(
      releaseCandidate.producerReleaseId,
    );

    await expect(
      registry.attest({
        actionCommitSha: shaA,
        expectedSchemaDigest: hashB,
        expectedCanonicalizerDigest: hashC,
      }),
    ).resolves.toEqual({ status: ProducerReleaseAttestationStatus.Revoked });
  });

  it("keeps a bounded old verification key through active-key rotation", async () => {
    const oldEnv = signingEnv("key-v1", [signingKey("key-v1", "a", null)]);
    const oldRing = createReviewRunAuthorizationKeyRingFromEnv(oldEnv);
    const oldCodec = new JoseRotatingCapabilityCodec(oldRing, 0);
    const token = await oldCodec.sign(capabilityClaims());
    const rotatedRing = createReviewRunAuthorizationKeyRingFromEnv(
      signingEnv("key-v2", [
        signingKey("key-v1", "a", "2026-07-22T13:00:00.000Z"),
        signingKey("key-v2", "b", null),
      ]),
    );
    const rotatedCodec = new JoseRotatingCapabilityCodec(rotatedRing, 0);

    await expect(
      rotatedCodec.verify({
        token: token.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewRun,
        expectedKind: CapabilityKind.RunAuthorization,
        now: new Date("2026-07-22T12:30:00.000Z"),
      }),
    ).resolves.toMatchObject({ capabilityId: "capability-1" });
  });
});

function pointer(
  baseSha: string,
  headSha: string,
): ReviewScmPullRequestPointer {
  return { pullRequestNumber: 42, baseSha, headSha };
}

function resolverInput() {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-1",
    githubInstallationId: "123",
    owner: "777genius",
    repo: "example",
    sourceRunId: "1001",
    pullRequestNumberHint: 42,
  } as const;
}

function attestation() {
  return {
    producerReleaseId: releaseCandidate.producerReleaseId,
    distributionKind: ProducerDistributionKind.PublicReusable,
    actionCommitSha: shaA,
    runtimeCommitSha: shaB,
    wrapperEntrypointDigest: null,
    runtimeEntrypointDigest: hashA,
    schemaDigest: hashB,
    canonicalizerDigest: hashC,
    capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
    protocolLimitsProfileId: "limits-1",
    operationalSloProfileId: "slo-1",
  } as const;
}

function signingKey(keyId: string, byte: string, verifyUntil: string | null) {
  return {
    keyId,
    secretBase64: Buffer.from(byte.repeat(32)).toString("base64"),
    verifyUntil,
  };
}

function signingEnv(activeKeyId: string, keys: readonly unknown[]) {
  return {
    [reviewRunAuthorizationActiveKeyIdEnv]: activeKeyId,
    [reviewRunAuthorizationKeysEnv]: JSON.stringify(keys),
  };
}

function capabilityClaims() {
  const now = new Date("2026-07-22T12:00:00.000Z");
  return {
    capabilityId: "capability-1",
    kind: CapabilityKind.RunAuthorization,
    audience: CapabilityAudience.ReviewRun,
    issuer: "reviewrouter",
    subject: "authorization-1",
    issuedAt: now,
    notBefore: now,
    ownershipExpiresAt: null,
    expiresAt: new Date("2026-07-22T12:45:00.000Z"),
    payload: {},
  } as const;
}
