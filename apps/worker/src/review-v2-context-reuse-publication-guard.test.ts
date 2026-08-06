import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ActualModelCompatibilityMode,
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewReuseEffectMode,
  ReviewTaskKind,
  canonicalizeReviewContextReusePolicyVector,
  reviewReuseEligibilityPolicyVersion,
} from "@reviewrouter/features-review-evidence";
import {
  ReviewSafetyDecisionKind,
  canonicalJson,
  type ReviewSafetyDecisionResolverPort,
} from "@reviewrouter/features-review-run-control";
import type { ReviewPublicationPermitIdentity } from "@reviewrouter/features-review-publishing/v2";
import {
  ReviewV2ContextReusePublicationStatus,
  VerifyCurrentContextReusePublicationPolicy,
  type ContextReusePublicationBinding,
} from "./review-v2-context-reuse-publication-guard";

const now = new Date("2026-07-24T12:00:00.000Z");
const gatewayPolicyVersion = "context-gateway-v1";
const gatewayBinaryHash = hash("g");
const release = {
  producerReleaseId: "release-1",
  registered: true,
  capabilityProfile: "context-gateway-v1",
  runtimeCommitSha: hash("r"),
  contextGatewayPolicyVersion: gatewayPolicyVersion,
  contextGatewayEntrypointDigest: gatewayBinaryHash,
} as const;

describe("context reuse publication policy", () => {
  it("revalidates the accepted attestation policy immediately before publication", async () => {
    const safety = allowingSafety();
    const binding = createBinding(reusePolicyVectorHash(safety.hashes));
    const guard = createGuard(binding, safety.resolver);

    await expect(guard.resolve(permit())).resolves.toEqual({
      status: ReviewV2ContextReusePublicationStatus.Current,
    });
  });

  it("fails closed when the gateway release or current safety policy changes", async () => {
    const safety = allowingSafety();
    const binding = createBinding(reusePolicyVectorHash(safety.hashes));

    await expect(
      createGuard(binding, safety.resolver, {
        gatewayBinaryHash: hash("changed"),
      }).resolve(permit()),
    ).resolves.toEqual({
      status: ReviewV2ContextReusePublicationStatus.Stale,
    });

    safety.contextAllowed = false;
    await expect(
      createGuard(binding, safety.resolver).resolve(permit()),
    ).resolves.toEqual({
      status: ReviewV2ContextReusePublicationStatus.Stale,
    });
  });

  it("fails closed for a legacy release without a bound gateway artifact", async () => {
    const safety = allowingSafety();
    const binding = createBinding(reusePolicyVectorHash(safety.hashes));

    await expect(
      createGuard(binding, safety.resolver, {
        contextGatewayPolicyVersion: null,
        contextGatewayEntrypointDigest: null,
      }).resolve(permit()),
    ).resolves.toEqual({
      status: ReviewV2ContextReusePublicationStatus.Stale,
    });
  });

  it("reports dependency failures as unavailable rather than stale", async () => {
    const safety = allowingSafety();
    const binding = createBinding(reusePolicyVectorHash(safety.hashes));

    await expect(
      createGuard(binding, safety.resolver, {
        bindingsUnavailable: true,
      }).resolve(permit()),
    ).resolves.toEqual({
      status: ReviewV2ContextReusePublicationStatus.Unavailable,
    });
  });
});

function createGuard(
  binding: ContextReusePublicationBinding,
  safety: ReviewSafetyDecisionResolverPort,
  override: {
    readonly gatewayBinaryHash?: string;
    readonly contextGatewayPolicyVersion?: string | null;
    readonly contextGatewayEntrypointDigest?: string | null;
    readonly bindingsUnavailable?: boolean;
  } = {},
) {
  return new VerifyCurrentContextReusePublicationPolicy({
    bindings: {
      async findContextReuseBindings() {
        if (override.bindingsUnavailable) {
          throw new Error("bindings_unavailable");
        }
        return [binding];
      },
    },
    releases: {
      async findContextReuseProducerRelease() {
        return {
          ...release,
          contextGatewayPolicyVersion:
            override.contextGatewayPolicyVersion === undefined
              ? release.contextGatewayPolicyVersion
              : override.contextGatewayPolicyVersion,
          contextGatewayEntrypointDigest:
            override.contextGatewayEntrypointDigest === undefined
              ? (override.gatewayBinaryHash ??
                release.contextGatewayEntrypointDigest)
              : override.contextGatewayEntrypointDigest,
        };
      },
    },
    safety,
    clock: { now: () => new Date(now) },
  });
}

function createBinding(
  policyVectorHash: string,
): ContextReusePublicationBinding {
  const source = {
    sourceExecutionId: "source-execution-1",
    sourceWorkSlotId: "source-slot-1",
    sourceReviewRevisionHash: hash("s"),
    attemptId: "attempt-1",
    sourceLeaseId: "lease-1",
    sourceFencingToken: "7",
  } as const;
  return {
    targetExecutionId: "execution-1",
    targetWorkSlotId: "target-slot-1",
    reusePolicyVectorHash: policyVectorHash,
    observation: {
      observationId: "observation-1",
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-connection-1",
      scmRepositoryIdentityId: "scm-repository-1",
      pullRequestNumber: 42,
      providerKind: ReviewProviderKind.Codex,
      taskKindSet: [ReviewTaskKind.FindingDiscovery],
      requestedModel: "gpt-5.6",
      actualModel: "gpt-5.6",
      providerRuntimeVersion: release.runtimeCommitSha,
      producerReleaseId: release.producerReleaseId,
      selectedProtocolVersion: "review-action-v2",
      trustedCapabilityProfile: release.capabilityProfile,
      executionProfile: ProviderExecutionProfile.ContextGatewayV1,
      ...source,
      contextAttestationId: "attestation-1",
      contextAttestationHash: hash("a"),
      reuseExpiresAtMs: now.getTime() + 60_000,
    },
    attestation: {
      attestationId: "attestation-1",
      attestationHash: hash("a"),
      sessionId: "session-1",
      ...source,
      actualModel: "gpt-5.6",
      reuseExpiresAtMs: now.getTime() + 60_000,
    },
    session: {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-connection-1",
      scmRepositoryIdentityId: "scm-repository-1",
      pullRequestNumber: 42,
      ...source,
      requestedModel: "gpt-5.6",
      trustedCapabilityProfile: release.capabilityProfile,
      gatewayPolicyVersion,
      gatewayBinaryHash,
      producerReleaseId: release.producerReleaseId,
      selectedProtocolVersion: "review-action-v2",
      state: "accepted",
      expiresAtMs: now.getTime() - 1,
    },
  };
}

function allowingSafety(): {
  resolver: ReviewSafetyDecisionResolverPort;
  hashes: Readonly<Record<ReviewSafetyDecisionKind, string>>;
  contextAllowed: boolean;
} {
  const state = {
    contextAllowed: true,
    hashes: {
      [ReviewSafetyDecisionKind.ExactRevisionCrossExecutionReuse]: hash("e"),
      [ReviewSafetyDecisionKind.PromptOnlyCrossRevisionReuse]: hash("p"),
      [ReviewSafetyDecisionKind.ContextGatewayCrossRevisionReuse]: hash("c"),
    } as Readonly<Record<ReviewSafetyDecisionKind, string>>,
  };
  return {
    ...state,
    resolver: {
      async resolveReviewSafetyPolicy(input) {
        const context =
          input.decisionKind ===
          ReviewSafetyDecisionKind.ContextGatewayCrossRevisionReuse;
        return {
          decisionKind: input.decisionKind,
          effectAllowed: context ? state.contextAllowed : true,
          shadow: false,
          emergencyStopped: false,
          capabilityDecisions: [],
          emergencyVersionVector: [],
          safetyDecisionHash: state.hashes[input.decisionKind],
          resolvedAt: new Date(now),
        };
      },
    },
    get contextAllowed() {
      return state.contextAllowed;
    },
    set contextAllowed(value: boolean) {
      state.contextAllowed = value;
    },
  };
}

function reusePolicyVectorHash(
  hashes: Readonly<Record<ReviewSafetyDecisionKind, string>>,
): string {
  return sha256(
    canonicalizeReviewContextReusePolicyVector({
      safetyDecision: {
        evidenceReuseMode: ReviewReuseEffectMode.Enabled,
        promptOnlyReuseMode: ReviewReuseEffectMode.Enabled,
        contextGatewayReuseMode: ReviewReuseEffectMode.Enabled,
        safetyDecisionHash: sha256(
          canonicalJson({
            exact:
              hashes[ReviewSafetyDecisionKind.ExactRevisionCrossExecutionReuse],
            prompt:
              hashes[ReviewSafetyDecisionKind.PromptOnlyCrossRevisionReuse],
            context:
              hashes[ReviewSafetyDecisionKind.ContextGatewayCrossRevisionReuse],
          }),
        ),
      },
      compatibility: {
        registeredProducerReleaseIds: [release.producerReleaseId],
        trustedCapabilityProfiles: [release.capabilityProfile],
        compatibleProviderRuntimeVersions: [release.runtimeCommitSha],
        actualModelMode: ActualModelCompatibilityMode.Exact,
        compatibleActualModels: [],
      },
      eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      gatewayPolicyVersion,
      gatewayBinaryHash,
      trustedCapabilityProfile: release.capabilityProfile,
      producerReleaseId: release.producerReleaseId,
      providerKind: ReviewProviderKind.Codex,
      requestedModel: "gpt-5.6",
      actualModel: "gpt-5.6",
    }),
  );
}

function permit(): ReviewPublicationPermitIdentity {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-connection-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
    executionId: "execution-1",
    generation: 1n,
    authorizationId: "authorization-1",
    producerReleaseId: release.producerReleaseId,
    reviewedHeadSha: hash("h"),
    reviewRevisionHash: hash("v"),
    projectionHash: hash("j"),
    lifecycleStateHash: hash("l"),
    commandLedgerWatermark: 1n,
    permitEpoch: 1n,
    publicationSafetyDecisionHash: hash("u"),
    publicationNotAfter: new Date(now.getTime() + 60_000),
  };
}

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
