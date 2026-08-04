import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ProducerReleaseCommandPort,
  ProducerReleaseQueryPort,
  ReviewOperationalSloProfileCommandPort,
  ReviewOperationalSloProfileQueryPort,
  ReviewProtocolLimitsProfileCommandPort,
  ReviewProtocolLimitsProfileQueryPort,
} from "../../application/ports/producer-release-ports";
import {
  ImmutableRegistryWriteStatus,
  ProducerReleaseRevocationStatus,
} from "../../application/ports/producer-release-ports";
import type {
  ReviewMutationAuthorityCommandPort,
  ReviewMutationAuthorityQueryPort,
} from "../../application/ports/review-mutation-authority-ports";
import { ReviewMutationAuthorityWriteStatus } from "../../application/ports/review-mutation-authority-ports";
import type {
  ReviewRunAuthorizationCommandPort,
  ReviewRunAuthorizationQueryPort,
} from "../../application/ports/review-run-authorization-ports";
import {
  ReviewRunAuthorizationCreateStatus,
  ReviewRunAuthorizationRenewStatus,
  ReviewRunAuthorizationTerminateStatus,
} from "../../application/ports/review-run-authorization-ports";
import type {
  ReviewSafetyControlInspectionPort,
  ReviewSafetyEmergencyControlCommandPort,
  ReviewSafetyEmergencyControlQueryPort,
  ReviewSafetyPolicyCommandPort,
  ReviewSafetyPolicyQueryPort,
} from "../../application/ports/review-safety-policy-ports";
import { ReviewSafetyControlWriteStatus } from "../../application/ports/review-safety-policy-ports";
import type {
  ScmRepositoryIdentityCommandPort,
  ScmRepositoryIdentityQueryPort,
} from "../../application/ports/scm-repository-identity-ports";
import {
  ScmRepositoryIdentityBindingStatus,
  ScmRepositoryIdentityResolveStatus,
} from "../../application/ports/scm-repository-identity-ports";
import type {
  ProducerRelease,
  ReviewOperationalSloProfileV2,
  ReviewProtocolLimitsV2,
} from "../../domain/producer-release";
import { reviewInvestigationCapabilityV1 } from "../../domain/producer-release";
import type { ReviewMutationAuthority } from "../../domain/review-mutation-authority";
import type { ReviewRunAuthorizationCandidate } from "../../domain/review-run-authorization";
import type {
  ReviewSafetyEmergencyControl,
  ReviewSafetyPolicy,
} from "../../domain/review-safety-policy";
import { createScmRepositoryIdentity } from "../../domain/scm-repository-identity";
import {
  ProducerDistributionKind,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewProtocolVersion,
  ReviewProviderKind,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenAudience,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTaskKind,
  ReviewTrustDomain,
  ScmProvider,
} from "../../domain/review-run-control-types";

type ProducerReleaseRepository = ReviewProtocolLimitsProfileQueryPort &
  ReviewProtocolLimitsProfileCommandPort &
  ReviewOperationalSloProfileQueryPort &
  ReviewOperationalSloProfileCommandPort &
  ProducerReleaseQueryPort &
  ProducerReleaseCommandPort;

type IdentityRepository = ScmRepositoryIdentityQueryPort &
  ScmRepositoryIdentityCommandPort;
type MutationAuthorityRepository = ReviewMutationAuthorityQueryPort &
  ReviewMutationAuthorityCommandPort;
type SafetyRepository = ReviewSafetyPolicyQueryPort &
  ReviewSafetyPolicyCommandPort &
  ReviewSafetyEmergencyControlQueryPort &
  ReviewSafetyEmergencyControlCommandPort &
  ReviewSafetyControlInspectionPort;
type AuthorizationRepository = ReviewRunAuthorizationQueryPort &
  ReviewRunAuthorizationCommandPort;

export type ReviewRunControlRepositoryContractHarness = {
  readonly releases: ProducerReleaseRepository;
  readonly identities: IdentityRepository;
  readonly authorities: MutationAuthorityRepository;
  readonly safety: SafetyRepository;
  readonly authorizations: AuthorizationRepository;
  prepareRepository(input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly provider: ScmProvider;
    readonly sourceBaseUrl: string;
    readonly externalRepositoryId: string;
  }): Promise<void>;
  readRepositoryBinding(
    repositoryConnectionId: string,
  ): Promise<string | null | undefined>;
};

export function reviewRunControlRepositoryContract(
  name: string,
  prefix: string,
  createHarness: () =>
    | ReviewRunControlRepositoryContractHarness
    | Promise<ReviewRunControlRepositoryContractHarness>,
  enabled = true,
): void {
  const suite = enabled ? describe : describe.skip;
  let sequence = 0;
  const next = (suffix: string) => `${prefix}-${suffix}-${(sequence += 1)}`;

  suite(`${name} review-run-control repository contract`, () => {
    it("persists immutable limits, SLOs, and nullable-wrapper release tuples exactly", async () => {
      const harness = await createHarness();
      const limits = limitsProfile(next("limits"));
      const [limitsLeft, limitsRight] = await Promise.all([
        harness.releases.registerProtocolLimitsProfile(limits),
        harness.releases.registerProtocolLimitsProfile(limits),
      ]);
      expect([limitsLeft.status, limitsRight.status].sort()).toEqual(
        [
          ImmutableRegistryWriteStatus.Created,
          ImmutableRegistryWriteStatus.Restored,
        ].sort(),
      );
      await expect(
        harness.releases.registerProtocolLimitsProfile({
          ...limits,
          protocolLimitsProfileId: next("limits-conflict"),
        }),
      ).resolves.toMatchObject({
        status: ImmutableRegistryWriteStatus.Conflict,
        existingId: limits.protocolLimitsProfileId,
      });

      const slo = sloProfile(next("slo"));
      expect(
        (await harness.releases.registerOperationalSloProfile(slo)).status,
      ).toBe(ImmutableRegistryWriteStatus.Created);
      expect(
        (await harness.releases.registerOperationalSloProfile(slo)).status,
      ).toBe(ImmutableRegistryWriteStatus.Restored);

      const release = producerRelease(next("release"), limits, slo);
      const duplicate = {
        ...release,
        producerReleaseId: next("release-duplicate"),
      };
      const [releaseLeft, releaseRight] = await Promise.all([
        harness.releases.registerProducerRelease(release),
        harness.releases.registerProducerRelease(duplicate),
      ]);
      expect([releaseLeft.status, releaseRight.status].sort()).toEqual(
        [
          ImmutableRegistryWriteStatus.Conflict,
          ImmutableRegistryWriteStatus.Created,
        ].sort(),
      );
      const owner =
        "value" in releaseLeft
          ? releaseLeft.value
          : "value" in releaseRight
            ? releaseRight.value
            : null;
      if (!owner) throw new Error("contract_release_owner_missing");
      await expect(
        harness.releases.registerProducerRelease({
          ...release,
          producerReleaseId: next("release-gateway"),
          contextGatewayPolicyVersion: "review-context-gateway.v1",
          contextGatewayEntrypointDigest: digest("gateway", "entrypoint"),
        }),
      ).resolves.toMatchObject({
        status: ImmutableRegistryWriteStatus.Created,
      });
      const investigationReleaseId = next("release-investigation");
      const investigationProfile = {
        capability: reviewInvestigationCapabilityV1,
        coverageProfileHash: digest("investigation", "coverage"),
        policyHash: digest("investigation", "policy"),
      } as const;
      await expect(
        harness.releases.registerProducerRelease({
          ...release,
          producerReleaseId: investigationReleaseId,
          contextGatewayPolicyVersion: "context-gateway-v4",
          contextGatewayEntrypointDigest: digest("gateway", "v4-entrypoint"),
          reviewInvestigationProfile: investigationProfile,
        }),
      ).resolves.toMatchObject({
        status: ImmutableRegistryWriteStatus.Created,
        value: { reviewInvestigationProfile: investigationProfile },
      });
      await expect(
        harness.releases.findProducerReleaseById(investigationReleaseId),
      ).resolves.toMatchObject({
        reviewInvestigationProfile: investigationProfile,
      });
      const revoked = await harness.releases.revokeProducerRelease({
        producerReleaseId: owner.producerReleaseId,
        revokedAt: new Date(owner.registeredAt.getTime() + 1_000),
      });
      expect(revoked.status).toBe(ProducerReleaseRevocationStatus.Revoked);
      expect(
        (
          await harness.releases.revokeProducerRelease({
            producerReleaseId: owner.producerReleaseId,
            revokedAt: new Date(owner.registeredAt.getTime() + 2_000),
          })
        ).status,
      ).toBe(ProducerReleaseRevocationStatus.Restored);
      expect(
        (
          await harness.releases.registerProducerRelease(
            owner.producerReleaseId === release.producerReleaseId
              ? release
              : duplicate,
          )
        ).status,
      ).toBe(ImmutableRegistryWriteStatus.Restored);
    });

    it("binds both sides of permanent SCM identity and unbinds only under paused authority CAS", async () => {
      const harness = await createHarness();
      const workspaceId = next("workspace");
      const repositoryConnectionId = next("repository");
      const externalRepositoryId = next("external");
      await harness.prepareRepository({
        workspaceId,
        repositoryConnectionId,
        provider: ScmProvider.GitHub,
        sourceBaseUrl: "https://github.com",
        externalRepositoryId,
      });
      const identity = createScmRepositoryIdentity({
        scmRepositoryIdentityId: next("scm"),
        provider: ScmProvider.GitHub,
        sourceBaseUrl: "https://GITHUB.com///",
        externalRepositoryId,
        createdAt: contractNow(),
      });
      const [left, right] = await Promise.all([
        harness.identities.resolveOrRegisterScmRepositoryIdentity({ identity }),
        harness.identities.resolveOrRegisterScmRepositoryIdentity({ identity }),
      ]);
      expect([left.status, right.status].sort()).toEqual(
        [
          ScmRepositoryIdentityResolveStatus.Created,
          ScmRepositoryIdentityResolveStatus.Restored,
        ].sort(),
      );
      const bound = await harness.identities.bindScmRepositoryIdentity({
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        expectedVersion: 1,
        workspaceId,
        repositoryConnectionId,
        boundAt: contractNow(),
      });
      expect(bound.status).toBe(ScmRepositoryIdentityBindingStatus.Bound);
      const boundRepositoryIdentity = await harness.readRepositoryBinding(
        repositoryConnectionId,
      );
      if (boundRepositoryIdentity !== undefined) {
        expect(boundRepositoryIdentity).toBe(identity.scmRepositoryIdentityId);
      }
      expect(
        (
          await harness.identities.unbindScmRepositoryIdentity({
            scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
            expectedVersion: 2,
            unboundAt: contractNow(),
            authority: {
              laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
              expectedVersion: 1,
            },
          })
        ).status,
      ).toBe(ScmRepositoryIdentityBindingStatus.AuthorityNotPaused);
      await harness.authorities.initializeReviewMutationAuthority(
        mutationAuthority(identity.scmRepositoryIdentityId),
      );
      const unbound = await harness.identities.unbindScmRepositoryIdentity({
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        expectedVersion: 2,
        unboundAt: contractNow(),
        authority: {
          laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
          expectedVersion: 1,
        },
      });
      expect(unbound.status).toBe(ScmRepositoryIdentityBindingStatus.Unbound);
      const unboundRepositoryIdentity = await harness.readRepositoryBinding(
        repositoryConnectionId,
      );
      if (unboundRepositoryIdentity !== undefined) {
        expect(unboundRepositoryIdentity).toBe(null);
      }
    });

    it("uses version CAS and preserves bigint mutation epochs", async () => {
      const harness = await createHarness();
      const scmRepositoryIdentityId = next("authority-scm");
      await harness.identities.resolveOrRegisterScmRepositoryIdentity({
        identity: createScmRepositoryIdentity({
          scmRepositoryIdentityId,
          provider: ScmProvider.GitHub,
          sourceBaseUrl: "https://github.com",
          externalRepositoryId: next("authority-external"),
          createdAt: contractNow(),
        }),
      });
      const initial = mutationAuthority(scmRepositoryIdentityId);
      expect(
        (await harness.authorities.initializeReviewMutationAuthority(initial))
          .status,
      ).toBe(ReviewMutationAuthorityWriteStatus.Created);
      const largeEpoch = BigInt(Number.MAX_SAFE_INTEGER) + 99n;
      const updated: ReviewMutationAuthority = {
        ...initial,
        version: 2,
        epoch: largeEpoch,
        activationSafetyDecisionHash: digest(
          scmRepositoryIdentityId,
          "activation-updated",
        ),
      };
      expect(
        (
          await harness.authorities.compareAndSetReviewMutationAuthority({
            expectedVersion: 1,
            authority: updated,
          })
        ).status,
      ).toBe(ReviewMutationAuthorityWriteStatus.Updated);
      expect(
        (
          await harness.authorities.compareAndSetReviewMutationAuthority({
            expectedVersion: 1,
            authority: updated,
          })
        ).status,
      ).toBe(ReviewMutationAuthorityWriteStatus.Restored);
      await expect(
        harness.authorities.findReviewMutationAuthority({
          scmRepositoryIdentityId,
          laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
        }),
      ).resolves.toMatchObject({ epoch: largeEpoch, version: 2 });
    });

    it("serializes competing legacy V1 and Direct V2 initialization", async () => {
      const harness = await createHarness();
      const scmRepositoryIdentityId = next("authority-race-scm");
      await harness.identities.resolveOrRegisterScmRepositoryIdentity({
        identity: createScmRepositoryIdentity({
          scmRepositoryIdentityId,
          provider: ScmProvider.GitHub,
          sourceBaseUrl: "https://github.com",
          externalRepositoryId: next("authority-race-external"),
          createdAt: contractNow(),
        }),
      });
      const legacy: ReviewMutationAuthority = {
        ...mutationAuthority(scmRepositoryIdentityId),
        epoch: 0n,
        mode: ReviewMutationMode.V1Open,
        managedWorkflowInventoryHash: null,
        activationSafetyDecisionHash: null,
        activatedAt: null,
        pausedAt: null,
      };
      const direct: ReviewMutationAuthority = {
        ...mutationAuthority(scmRepositoryIdentityId),
        mode: ReviewMutationMode.V2Active,
        pausedAt: null,
      };

      const outcomes = await Promise.all([
        harness.authorities.initializeReviewMutationAuthority(legacy),
        harness.authorities.initializeReviewMutationAuthority(direct),
      ]);

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(
        [
          ReviewMutationAuthorityWriteStatus.Conflict,
          ReviewMutationAuthorityWriteStatus.Created,
        ].sort(),
      );
      const current = await harness.authorities.findReviewMutationAuthority({
        scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      });
      expect(current?.mode).toBe(
        outcomes.find(
          (outcome) =>
            outcome.status === ReviewMutationAuthorityWriteStatus.Created,
        )?.authority.mode,
      );
    });

    it("returns every applicable scoped safety fence so disable wins", async () => {
      const harness = await createHarness();
      const workspaceId = next("safety-workspace");
      const repositoryConnectionId = next("safety-repository");
      const externalRepositoryId = next("safety-external");
      const scmRepositoryIdentityId = next("safety-scm");
      await prepareBoundRepository(harness, {
        workspaceId,
        repositoryConnectionId,
        externalRepositoryId,
        scmRepositoryIdentityId,
      });
      const global = safetyPolicy(
        next("policy-global"),
        {
          scope: ReviewSafetyPolicyScope.Global,
        },
        ReviewSafetyRolloutMode.Enabled,
      );
      const workspace = safetyPolicy(
        next("policy-workspace"),
        { scope: ReviewSafetyPolicyScope.Workspace, workspaceId },
        ReviewSafetyRolloutMode.Disabled,
      );
      const repository = safetyPolicy(
        next("policy-repository"),
        {
          scope: ReviewSafetyPolicyScope.Repository,
          workspaceId,
          repositoryConnectionId,
          scmRepositoryIdentityId,
        },
        ReviewSafetyRolloutMode.Enabled,
      );
      for (const policy of [global, workspace, repository]) {
        expect(
          (
            await harness.safety.putReviewSafetyPolicy({
              expectedVersion: 0,
              policy,
            })
          ).status,
        ).toBe(ReviewSafetyControlWriteStatus.Created);
      }
      const applicable =
        await harness.safety.findApplicableReviewSafetyPolicies({
          target: {
            workspaceId,
            repositoryConnectionId,
            scmRepositoryIdentityId,
          },
          capabilities: [ReviewSafetyCapability.RunAuthorizationV2],
        });
      expect(applicable).toHaveLength(3);
      expect(
        applicable.some(
          (policy) => policy.rolloutMode === ReviewSafetyRolloutMode.Disabled,
        ),
      ).toBe(true);
      expect(repository.providerTaskSelectors).toEqual([
        {
          providerKind: ReviewProviderKind.Codex,
          taskKind: ReviewTaskKind.CodeReview,
        },
        {
          providerKind: ReviewProviderKind.ClaudeCode,
          taskKind: ReviewTaskKind.FindingRevalidation,
        },
        {
          providerKind: ReviewProviderKind.OpenRouter,
          taskKind: ReviewTaskKind.ConflictReview,
        },
      ]);
      const stopped = emergencyControl(next("emergency"), {
        scope: ReviewSafetyPolicyScope.Repository,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
      });
      expect(
        (
          await harness.safety.putReviewSafetyEmergencyControl({
            expectedVersion: 0,
            control: stopped,
          })
        ).status,
      ).toBe(ReviewSafetyControlWriteStatus.Created);
      const applicableEmergencyControls =
        await harness.safety.findApplicableReviewSafetyEmergencyControls({
          workspaceId,
          repositoryConnectionId,
          scmRepositoryIdentityId,
        });
      expect(applicableEmergencyControls).toContainEqual(stopped);
      expect(
        applicableEmergencyControls.every((control) => control.stopped),
      ).toBe(true);
    });

    it("creates, restores, renews, and terminates authorization with exact replay semantics", async () => {
      const harness = await createHarness();
      const context = await prepareAuthorizationContext(harness, next);
      const candidate = context.candidate;
      const first =
        await harness.authorizations.createOrRestoreReviewRunAuthorization(
          candidate,
        );
      expect(first.status).toBe(ReviewRunAuthorizationCreateStatus.Created);
      expect(
        (
          await harness.authorizations.createOrRestoreReviewRunAuthorization(
            candidate,
          )
        ).status,
      ).toBe(ReviewRunAuthorizationCreateStatus.Restored);
      expect(
        (
          await harness.authorizations.createOrRestoreReviewRunAuthorization({
            ...candidate,
            headSha: "f".repeat(40),
          })
        ).status,
      ).toBe(ReviewRunAuthorizationCreateStatus.ReplayConflict);
      expect(
        (
          await harness.authorizations.createOrRestoreReviewRunAuthorization({
            ...candidate,
            authorizationId: next("authorization-run-conflict"),
            oidcReplayKeyHash: digest(
              candidate.authorizationId,
              "run-conflict-replay",
            ),
          })
        ).status,
      ).toBe(ReviewRunAuthorizationCreateStatus.RunAttemptConflict);

      const renewal = {
        authorizationId: candidate.authorizationId,
        expectedVersion: 1,
        renewalReplayKeyHash: digest(
          candidate.authorizationId,
          "renewal-replay",
        ),
        renewalProofHash: digest(candidate.authorizationId, "renewal-proof"),
        renewedAt: new Date(candidate.createdAt.getTime() + 1_000),
        expiresAt: new Date(candidate.expiresAt.getTime() + 60_000),
      };
      const renewed =
        await harness.authorizations.renewReviewRunAuthorization(renewal);
      expect(renewed.status).toBe(ReviewRunAuthorizationRenewStatus.Renewed);
      expect(
        (
          await harness.authorizations.renewReviewRunAuthorization({
            ...renewal,
            expectedVersion: 2,
          })
        ).status,
      ).toBe(ReviewRunAuthorizationRenewStatus.Restored);
      expect(
        (
          await harness.authorizations.renewReviewRunAuthorization({
            ...renewal,
            expectedVersion: 2,
            renewalProofHash: digest(
              candidate.authorizationId,
              "renewal-proof-conflict",
            ),
          })
        ).status,
      ).toBe(ReviewRunAuthorizationRenewStatus.Conflict);

      const terminated =
        await harness.authorizations.terminateReviewRunAuthorization({
          authorizationId: candidate.authorizationId,
          expectedVersion: 2,
          state: ReviewRunAuthorizationState.Revoked,
          at: new Date(candidate.createdAt.getTime() + 2_000),
        });
      expect(terminated.status).toBe(
        ReviewRunAuthorizationTerminateStatus.Terminated,
      );
      expect(
        (
          await harness.authorizations.terminateReviewRunAuthorization({
            authorizationId: candidate.authorizationId,
            expectedVersion: 1,
            state: ReviewRunAuthorizationState.Revoked,
            at: new Date(candidate.createdAt.getTime() + 3_000),
          })
        ).status,
      ).toBe(ReviewRunAuthorizationTerminateStatus.Restored);
    });
  });
}

async function prepareAuthorizationContext(
  harness: ReviewRunControlRepositoryContractHarness,
  next: (suffix: string) => string,
) {
  const workspaceId = next("auth-workspace");
  const repositoryConnectionId = next("auth-repository");
  const externalRepositoryId = next("auth-external");
  const scmRepositoryIdentityId = next("auth-scm");
  await prepareBoundRepository(harness, {
    workspaceId,
    repositoryConnectionId,
    externalRepositoryId,
    scmRepositoryIdentityId,
  });
  const limits = limitsProfile(next("auth-limits"));
  const slo = sloProfile(next("auth-slo"));
  await harness.releases.registerProtocolLimitsProfile(limits);
  await harness.releases.registerOperationalSloProfile(slo);
  const release = producerRelease(next("auth-release"), limits, slo);
  await harness.releases.registerProducerRelease(release);
  const now = contractNow();
  const candidate: ReviewRunAuthorizationCandidate = {
    authorizationId: next("authorization"),
    workspaceId,
    repositoryConnectionId,
    scmRepositoryIdentityId,
    pullRequestNumber: 7,
    sourceRunId: next("run"),
    sourceRunAttempt: "1",
    workflowIdentityHash: digest(release.producerReleaseId, "workflow"),
    baseSha: "a".repeat(40),
    mergeBaseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    reviewRevisionHash: digest(release.producerReleaseId, "revision"),
    trustDomain: ReviewTrustDomain.TrustedManaged,
    producerReleaseId: release.producerReleaseId,
    selectedProtocolVersion: ReviewProtocolVersion.V2,
    schemaDigest: release.schemaDigest,
    protocolLimitsProfileId: limits.protocolLimitsProfileId,
    operationalSloProfileId: slo.operationalSloProfileId,
    mutationEpoch: 1n,
    providerVoteLanes: [
      {
        providerKind: ReviewProviderKind.Codex,
        providerVoteIdentityHash: digest(
          release.producerReleaseId,
          "provider-vote",
        ),
      },
    ],
    authorizationSafetyDecisionHash: digest(
      release.producerReleaseId,
      "authorization-safety",
    ),
    protocolOfferHash: digest(release.producerReleaseId, "protocol-offer"),
    oidcReplayKeyHash: digest(release.producerReleaseId, "oidc-replay"),
    tokenSigningKeyId: "test-key",
    tokenIssuer: "reviewrouter-review-run-control",
    tokenAudience: ReviewRunAuthorizationTokenAudience.ReviewRun,
    expiresAt: new Date(now.getTime() + 3_600_000),
    maxExpiresAt: new Date(now.getTime() + 7_200_000),
    createdAt: now,
  };
  return { candidate };
}

async function prepareBoundRepository(
  harness: ReviewRunControlRepositoryContractHarness,
  input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly externalRepositoryId: string;
    readonly scmRepositoryIdentityId: string;
  },
): Promise<void> {
  await harness.prepareRepository({
    ...input,
    provider: ScmProvider.GitHub,
    sourceBaseUrl: "https://github.com",
  });
  const identity = createScmRepositoryIdentity({
    scmRepositoryIdentityId: input.scmRepositoryIdentityId,
    provider: ScmProvider.GitHub,
    sourceBaseUrl: "https://github.com",
    externalRepositoryId: input.externalRepositoryId,
    createdAt: contractNow(),
  });
  await harness.identities.resolveOrRegisterScmRepositoryIdentity({ identity });
  const bound = await harness.identities.bindScmRepositoryIdentity({
    scmRepositoryIdentityId: input.scmRepositoryIdentityId,
    expectedVersion: 1,
    workspaceId: input.workspaceId,
    repositoryConnectionId: input.repositoryConnectionId,
    boundAt: contractNow(),
  });
  if (bound.status !== ScmRepositoryIdentityBindingStatus.Bound) {
    throw new Error("contract_repository_binding_failed");
  }
}

function limitsProfile(id: string): ReviewProtocolLimitsV2 {
  return {
    protocolLimitsProfileId: id,
    limitsDigest: digest(id, "limits-profile"),
    maxWorkSlots: 20,
    maxAttemptsPerSlot: 3,
    maxObservationBytes: 100_000,
    maxObservationFindings: 100,
    maxProjectionBytes: 100_000,
    maxProjectionFindings: 100,
    maxPublicationOperations: 50,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 100_000,
    maxRequestBatchSize: 20,
    maxLeaseDurationMs: 60_000,
    maxResultReportDurationMs: 120_000,
    maxReconciliationDurationMs: 180_000,
    registeredAt: contractNow(),
  };
}

function sloProfile(id: string): ReviewOperationalSloProfileV2 {
  return {
    operationalSloProfileId: id,
    sloDigest: digest(id, "slo-profile"),
    integrationEventDeliveryMs: 1_000,
    outboxClaimAgeMs: 2_000,
    missingCompletionProcessMs: 3_000,
    dueCompletionProcessMs: 4_000,
    publicationReconciliationMs: 5_000,
    v1DrainMs: 6_000,
    admissionMs: 7_000,
    pruningBacklogAgeMs: 8_000,
    ownerRefs: ["team-reviewrouter"],
    runbookRefs: ["runbook-review-v2"],
    registeredAt: contractNow(),
  };
}

function producerRelease(
  id: string,
  limits: ReviewProtocolLimitsV2,
  slo: ReviewOperationalSloProfileV2,
): ProducerRelease {
  return {
    producerReleaseId: id,
    distributionKind: ProducerDistributionKind.PublicReusable,
    actionCommitSha: "1".repeat(40),
    runtimeCommitSha: "2".repeat(40),
    wrapperEntrypointDigest: null,
    runtimeEntrypointDigest: digest(id, "runtime-entrypoint"),
    contextGatewayPolicyVersion: null,
    contextGatewayEntrypointDigest: null,
    reviewInvestigationProfile: null,
    schemaDigest: digest(id, "schema"),
    capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
    protocolLimitsProfileId: limits.protocolLimitsProfileId,
    operationalSloProfileId: slo.operationalSloProfileId,
    state: ProducerReleaseState.Registered,
    registeredAt: contractNow(),
    revokedAt: null,
  };
}

function mutationAuthority(
  scmRepositoryIdentityId: string,
): ReviewMutationAuthority {
  return {
    scmRepositoryIdentityId,
    laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    version: 1,
    epoch: 1n,
    mode: ReviewMutationMode.Paused,
    drainPolicyVersion: null,
    drainStartedAt: null,
    v1AdmissionClosedAt: null,
    drainNotBefore: null,
    managedWorkflowInventoryHash: digest(
      scmRepositoryIdentityId,
      "managed-workflow-inventory",
    ),
    activationSafetyDecisionHash: digest(
      scmRepositoryIdentityId,
      "activation-safety",
    ),
    initializedAt: contractNow(),
    activatedAt: contractNow(),
    pausedAt: contractNow(),
  };
}

function safetyPolicy(
  policyId: string,
  scope: ReviewSafetyPolicy["scope"],
  rolloutMode: ReviewSafetyRolloutMode,
): ReviewSafetyPolicy {
  return {
    policyId,
    scope,
    capability: ReviewSafetyCapability.RunAuthorizationV2,
    version: 1,
    rolloutMode,
    providerTaskSelectors: [
      {
        providerKind: ReviewProviderKind.Codex,
        taskKind: ReviewTaskKind.CodeReview,
      },
      {
        providerKind: ReviewProviderKind.ClaudeCode,
        taskKind: ReviewTaskKind.FindingRevalidation,
      },
      {
        providerKind: ReviewProviderKind.OpenRouter,
        taskKind: ReviewTaskKind.ConflictReview,
      },
    ],
    updatedBy: "contract-operator",
    updatedAt: contractNow(),
  };
}

function emergencyControl(
  emergencyControlId: string,
  scope: ReviewSafetyEmergencyControl["scope"],
): ReviewSafetyEmergencyControl {
  return {
    emergencyControlId,
    scope,
    version: 1,
    stopped: true,
    reason: "contract-stop",
    updatedBy: "contract-operator",
    updatedAt: contractNow(),
  };
}

function contractNow(): Date {
  return new Date(Date.now() - 1_000);
}

function digest(scope: string, field: string): string {
  return createHash("sha256")
    .update("review-run-control-test-fixture\0")
    .update(scope)
    .update("\0")
    .update(field)
    .digest("hex");
}
