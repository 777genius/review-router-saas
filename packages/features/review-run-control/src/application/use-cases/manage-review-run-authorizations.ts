import type {
  ReviewRunAuthorization,
  ReviewRunRevision,
} from "../../domain/review-run-authorization";
import {
  assertPositiveInteger,
  canonicalJson,
} from "../../domain/review-run-control-types";
import {
  ProducerReleaseState,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewProtocolVersion,
  ReviewRunAuthorizationState,
  ReviewSafetyDecisionKind,
  ReviewTaskKind,
  ReviewTrustDomain,
  type ProviderVoteLane,
  type ReviewRunScope,
} from "../../domain/review-run-control-types";
import type {
  ClockPort,
  IdentifierFactoryPort,
  IssuedReviewRunAuthorizationToken,
  ReviewRunAuthorizationTokenPort,
  Sha256DigestPort,
  VerifiedReviewRunAuthorizationToken,
} from "../ports/platform-ports";
import type {
  ProducerReleaseQueryPort,
  ReviewOperationalSloProfileQueryPort,
  ReviewProtocolLimitsProfileQueryPort,
} from "../ports/producer-release-ports";
import type { ReviewMutationAuthorityQueryPort } from "../ports/review-mutation-authority-ports";
import {
  ReviewRunAuthorizationCreateStatus,
  ReviewRunAuthorizationRenewStatus,
  ReviewRunAuthorizationTerminateStatus,
  type ReviewRunAuthorizationCommandPort,
  type ReviewRunAuthorizationAdmissionCommandPort,
  type ReviewRunAuthorizationQueryPort,
} from "../ports/review-run-authorization-ports";
import type { ReviewSafetyDecisionResolverPort } from "../ports/review-safety-policy-ports";
import type { ScmRepositoryIdentityQueryPort } from "../ports/scm-repository-identity-ports";

export type VerifiedScmRunIdentity = ReviewRunScope &
  ReviewRunRevision & {
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
    readonly workflowIdentityHash: string;
    readonly trustDomain: ReviewTrustDomain;
  };

export enum ReviewRunAuthorizationUseCaseStatus {
  Authorized = "authorized",
  Restored = "restored",
  Renewed = "renewed",
  Denied = "denied",
  Conflict = "conflict",
  Expired = "expired",
  Revoked = "revoked",
  Missing = "missing",
}

export enum ReviewRunAuthorizationDenialReason {
  RepositoryBindingMismatch = "repository_binding_mismatch",
  MutationAuthorityUnavailable = "mutation_authority_unavailable",
  ProducerReleaseUnavailable = "producer_release_unavailable",
  ReleaseProfileUnavailable = "release_profile_unavailable",
  SafetyDecisionDisabled = "safety_decision_disabled",
  VerifiedIdentityDrift = "verified_identity_drift",
  SafetyDecisionChanged = "safety_decision_changed",
  AdmissionFactsChanged = "admission_facts_changed",
}

export type ReviewRunAuthorizationSuccess = {
  readonly status:
    | ReviewRunAuthorizationUseCaseStatus.Authorized
    | ReviewRunAuthorizationUseCaseStatus.Restored
    | ReviewRunAuthorizationUseCaseStatus.Renewed;
  readonly authorization: ReviewRunAuthorization;
  readonly token: IssuedReviewRunAuthorizationToken;
  readonly protocolLimits: Awaited<
    ReturnType<
      ReviewProtocolLimitsProfileQueryPort["findProtocolLimitsProfileById"]
    >
  >;
};

export type ReviewRunAuthorizationUseCaseResult =
  | ReviewRunAuthorizationSuccess
  | {
      readonly status: ReviewRunAuthorizationUseCaseStatus.Denied;
      readonly reason: ReviewRunAuthorizationDenialReason;
    }
  | {
      readonly status:
        | ReviewRunAuthorizationUseCaseStatus.Conflict
        | ReviewRunAuthorizationUseCaseStatus.Expired
        | ReviewRunAuthorizationUseCaseStatus.Revoked
        | ReviewRunAuthorizationUseCaseStatus.Missing;
    };

export enum ReviewRunAuthorizationTokenResolutionStatus {
  Valid = "valid",
  Invalid = "invalid",
  ClaimDrift = "claim_drift",
  Missing = "missing",
  Expired = "expired",
  Revoked = "revoked",
}

export type ReviewRunAuthorizationTokenResolution =
  | {
      readonly status: ReviewRunAuthorizationTokenResolutionStatus.Valid;
      readonly authorization: ReviewRunAuthorization;
    }
  | {
      readonly status:
        | ReviewRunAuthorizationTokenResolutionStatus.Invalid
        | ReviewRunAuthorizationTokenResolutionStatus.ClaimDrift
        | ReviewRunAuthorizationTokenResolutionStatus.Missing
        | ReviewRunAuthorizationTokenResolutionStatus.Expired
        | ReviewRunAuthorizationTokenResolutionStatus.Revoked;
    };

export class ManageReviewRunAuthorizations {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly identifiers: IdentifierFactoryPort;
      readonly digest: Sha256DigestPort;
      readonly identities: ScmRepositoryIdentityQueryPort;
      readonly authorities: ReviewMutationAuthorityQueryPort;
      readonly releases: ProducerReleaseQueryPort;
      readonly limits: ReviewProtocolLimitsProfileQueryPort;
      readonly slos: ReviewOperationalSloProfileQueryPort;
      readonly safetyDecisions: ReviewSafetyDecisionResolverPort;
      readonly authorizationQueries: ReviewRunAuthorizationQueryPort;
      readonly authorizationCommands: ReviewRunAuthorizationCommandPort &
        ReviewRunAuthorizationAdmissionCommandPort;
      readonly tokens: ReviewRunAuthorizationTokenPort;
    },
  ) {}

  async authorizeReviewRun(input: {
    readonly verifiedIdentity: VerifiedScmRunIdentity;
    readonly producerReleaseId: string;
    readonly protocolOfferHash: string;
    readonly oidcReplayKeyHash: string;
    readonly providerVoteLanes: readonly ProviderVoteLane[];
    readonly reviewInvestigationAuthorizationDescriptorCanonicalJson?:
      | string
      | null;
    readonly authorizationTtlMs: number;
    readonly maxAuthorizationLifetimeMs: number;
  }): Promise<ReviewRunAuthorizationUseCaseResult> {
    assertPositiveInteger(input.authorizationTtlMs, "authorization_ttl_ms");
    assertPositiveInteger(
      input.maxAuthorizationLifetimeMs,
      "max_authorization_lifetime_ms",
    );
    const eligibility = await this.loadEligibility(
      input.verifiedIdentity,
      input.producerReleaseId,
      input.providerVoteLanes,
    );
    if ("denied" in eligibility) {
      return denied(eligibility.denied);
    }
    const now = this.dependencies.clock.now();
    const maxExpiresAt = new Date(
      now.getTime() + input.maxAuthorizationLifetimeMs,
    );
    const expiresAt = new Date(
      Math.min(
        now.getTime() + input.authorizationTtlMs,
        maxExpiresAt.getTime(),
      ),
    );
    const tokenProfile = this.dependencies.tokens.profile();
    const write =
      await this.dependencies.authorizationCommands.createOrRestoreReviewRunAuthorizationAtomically(
        {
          candidate: {
            authorizationId: this.dependencies.identifiers.nextId(
              "review_run_authorization",
            ),
            ...input.verifiedIdentity,
            producerReleaseId: eligibility.release.producerReleaseId,
            selectedProtocolVersion: ReviewProtocolVersion.V2,
            schemaDigest: eligibility.release.schemaDigest,
            protocolLimitsProfileId:
              eligibility.release.protocolLimitsProfileId,
            operationalSloProfileId:
              eligibility.release.operationalSloProfileId,
            mutationEpoch: eligibility.authority.epoch,
            providerVoteLanes: input.providerVoteLanes,
            reviewInvestigationAuthorizationDescriptorCanonicalJson:
              input.reviewInvestigationAuthorizationDescriptorCanonicalJson ??
              null,
            authorizationSafetyDecisionHash:
              eligibility.safety.safetyDecisionHash,
            protocolOfferHash: input.protocolOfferHash,
            oidcReplayKeyHash: input.oidcReplayKeyHash,
            tokenSigningKeyId: await this.dependencies.tokens.activeKeyId(),
            tokenIssuer: tokenProfile.issuer,
            tokenAudience: tokenProfile.audience,
            expiresAt,
            maxExpiresAt,
            createdAt: now,
          },
          fence: {
            repositoryIdentityVersion: eligibility.repository.version,
            mutationAuthorityVersion: eligibility.authority.version,
            producerRelease: eligibility.release,
            protocolLimitsDigest: eligibility.limits.limitsDigest,
            operationalSloDigest: eligibility.slo.sloDigest,
            safetySnapshot: eligibility.safety,
            safetyTarget: {
              workspaceId: input.verifiedIdentity.workspaceId,
              repositoryConnectionId:
                input.verifiedIdentity.repositoryConnectionId,
              scmRepositoryIdentityId:
                input.verifiedIdentity.scmRepositoryIdentityId,
              providerTasks: input.providerVoteLanes.map((lane) => ({
                providerKind: lane.providerKind,
                taskKind: ReviewTaskKind.CodeReview,
              })),
            },
          },
        },
      );
    if (!write.authorization) {
      if (
        write.status === ReviewRunAuthorizationCreateStatus.EligibilityChanged
      ) {
        return denied(ReviewRunAuthorizationDenialReason.AdmissionFactsChanged);
      }
      return { status: ReviewRunAuthorizationUseCaseStatus.Conflict };
    }
    if (write.authorization.state === ReviewRunAuthorizationState.Expired) {
      return { status: ReviewRunAuthorizationUseCaseStatus.Expired };
    }
    if (write.authorization.state === ReviewRunAuthorizationState.Revoked) {
      return { status: ReviewRunAuthorizationUseCaseStatus.Revoked };
    }
    if (write.authorization.expiresAt <= now) {
      await this.dependencies.authorizationCommands.terminateReviewRunAuthorization(
        {
          authorizationId: write.authorization.authorizationId,
          expectedVersion: write.authorization.version,
          state: ReviewRunAuthorizationState.Expired,
          at: now,
        },
      );
      return { status: ReviewRunAuthorizationUseCaseStatus.Expired };
    }
    return {
      status:
        write.status === ReviewRunAuthorizationCreateStatus.Created
          ? ReviewRunAuthorizationUseCaseStatus.Authorized
          : ReviewRunAuthorizationUseCaseStatus.Restored,
      authorization: write.authorization,
      token: await this.dependencies.tokens.issue(write.authorization),
      protocolLimits: eligibility.limits,
    };
  }

  async renewReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly verifiedIdentity: VerifiedScmRunIdentity;
    readonly renewalReplayKeyHash: string;
    readonly requestedTtlMs: number;
  }): Promise<ReviewRunAuthorizationUseCaseResult> {
    assertPositiveInteger(input.requestedTtlMs, "requested_ttl_ms");
    const authorization =
      await this.dependencies.authorizationQueries.findReviewRunAuthorizationById(
        input.authorizationId,
      );
    if (!authorization) {
      return { status: ReviewRunAuthorizationUseCaseStatus.Missing };
    }
    if (authorization.state === ReviewRunAuthorizationState.Revoked) {
      return { status: ReviewRunAuthorizationUseCaseStatus.Revoked };
    }
    const now = this.dependencies.clock.now();
    if (
      authorization.state === ReviewRunAuthorizationState.Expired ||
      now >= authorization.expiresAt
    ) {
      if (authorization.state === ReviewRunAuthorizationState.Active) {
        await this.dependencies.authorizationCommands.terminateReviewRunAuthorization(
          {
            authorizationId: authorization.authorizationId,
            expectedVersion: authorization.version,
            state: ReviewRunAuthorizationState.Expired,
            at: now,
          },
        );
      }
      return { status: ReviewRunAuthorizationUseCaseStatus.Expired };
    }
    if (!verifiedIdentityMatches(authorization, input.verifiedIdentity)) {
      return denied(ReviewRunAuthorizationDenialReason.VerifiedIdentityDrift);
    }
    let eligibility = await this.loadEligibility(
      input.verifiedIdentity,
      authorization.producerReleaseId,
      authorization.providerVoteLanes,
    );
    if ("denied" in eligibility) {
      return denied(eligibility.denied);
    }
    if (eligibility.authority.epoch !== authorization.mutationEpoch) {
      return denied(ReviewRunAuthorizationDenialReason.SafetyDecisionChanged);
    }
    if (
      eligibility.safety.safetyDecisionHash !==
      authorization.authorizationSafetyDecisionHash
    ) {
      const confirmed = await this.confirmRenewalFence({
        identity: input.verifiedIdentity,
        producerReleaseId: authorization.producerReleaseId,
        providerVoteLanes: authorization.providerVoteLanes,
        expectedMutationEpoch: authorization.mutationEpoch,
        expectedSafetyDecisionHash:
          authorization.authorizationSafetyDecisionHash,
      });
      if ("denied" in confirmed) {
        return denied(confirmed.denied);
      }
      eligibility = confirmed;
    }
    const expiresAt = new Date(
      Math.min(
        now.getTime() + input.requestedTtlMs,
        authorization.maxExpiresAt.getTime(),
      ),
    );
    const renewalProofHash = await this.dependencies.digest.digestUtf8(
      canonicalJson({
        authorizationId: authorization.authorizationId,
        verifiedIdentity: input.verifiedIdentity,
        renewalReplayKeyHash: input.renewalReplayKeyHash,
        requestedTtlMs: input.requestedTtlMs,
      }),
    );
    const write =
      await this.dependencies.authorizationCommands.renewReviewRunAuthorization(
        {
          authorizationId: authorization.authorizationId,
          expectedVersion: authorization.version,
          renewalReplayKeyHash: input.renewalReplayKeyHash,
          renewalProofHash,
          renewedAt: now,
          expiresAt,
        },
      );
    if (!write.authorization) {
      return {
        status:
          write.status === ReviewRunAuthorizationRenewStatus.Missing
            ? ReviewRunAuthorizationUseCaseStatus.Missing
            : ReviewRunAuthorizationUseCaseStatus.Conflict,
      };
    }
    return {
      status:
        write.status === ReviewRunAuthorizationRenewStatus.Renewed
          ? ReviewRunAuthorizationUseCaseStatus.Renewed
          : ReviewRunAuthorizationUseCaseStatus.Restored,
      authorization: write.authorization,
      token: await this.dependencies.tokens.issue(write.authorization),
      protocolLimits: eligibility.limits,
    };
  }

  async expireOrRevokeReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly state:
      | ReviewRunAuthorizationState.Expired
      | ReviewRunAuthorizationState.Revoked;
  }) {
    const authorization =
      await this.dependencies.authorizationQueries.findReviewRunAuthorizationById(
        input.authorizationId,
      );
    if (!authorization) {
      return {
        status: ReviewRunAuthorizationTerminateStatus.Missing,
      } as const;
    }
    return this.dependencies.authorizationCommands.terminateReviewRunAuthorization(
      {
        authorizationId: authorization.authorizationId,
        expectedVersion: authorization.version,
        state: input.state,
        at: this.dependencies.clock.now(),
      },
    );
  }

  async resolveReviewRunAuthorizationToken(input: {
    readonly token: string;
  }): Promise<ReviewRunAuthorizationTokenResolution> {
    const now = this.dependencies.clock.now();
    let token: VerifiedReviewRunAuthorizationToken;
    try {
      token = await this.dependencies.tokens.verify({
        token: input.token,
        now,
      });
    } catch {
      return { status: ReviewRunAuthorizationTokenResolutionStatus.Invalid };
    }
    const authorization =
      await this.dependencies.authorizationQueries.findReviewRunAuthorizationById(
        token.authorizationId,
      );
    if (!authorization) {
      return { status: ReviewRunAuthorizationTokenResolutionStatus.Missing };
    }
    if (authorization.state === ReviewRunAuthorizationState.Revoked) {
      return { status: ReviewRunAuthorizationTokenResolutionStatus.Revoked };
    }
    if (
      authorization.state === ReviewRunAuthorizationState.Expired ||
      now >= authorization.expiresAt
    ) {
      return { status: ReviewRunAuthorizationTokenResolutionStatus.Expired };
    }
    if (!(await this.tokenClaimsMatchAuthorization(token, authorization))) {
      return { status: ReviewRunAuthorizationTokenResolutionStatus.ClaimDrift };
    }
    return {
      status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
      authorization,
    };
  }

  private async loadEligibility(
    identity: VerifiedScmRunIdentity,
    producerReleaseId: string,
    providerVoteLanes: readonly ProviderVoteLane[],
  ) {
    const [repository, authority, release, safety] = await Promise.all([
      this.dependencies.identities.findScmRepositoryIdentityById(
        identity.scmRepositoryIdentityId,
      ),
      this.dependencies.authorities.findReviewMutationAuthority({
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      }),
      this.dependencies.releases.findProducerReleaseById(producerReleaseId),
      this.dependencies.safetyDecisions.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.RunAuthorization,
        target: {
          workspaceId: identity.workspaceId,
          repositoryConnectionId: identity.repositoryConnectionId,
          scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
          providerTasks: providerVoteLanes.map((lane) => ({
            providerKind: lane.providerKind,
            taskKind: ReviewTaskKind.CodeReview,
          })),
        },
      }),
    ]);
    if (
      !repository ||
      repository.currentWorkspaceId !== identity.workspaceId ||
      repository.currentRepositoryConnectionId !==
        identity.repositoryConnectionId
    ) {
      return {
        denied: ReviewRunAuthorizationDenialReason.RepositoryBindingMismatch,
      } as const;
    }
    if (!authority || authority.mode !== ReviewMutationMode.V2Active) {
      return {
        denied: ReviewRunAuthorizationDenialReason.MutationAuthorityUnavailable,
      } as const;
    }
    if (!release || release.state !== ProducerReleaseState.Registered) {
      return {
        denied: ReviewRunAuthorizationDenialReason.ProducerReleaseUnavailable,
      } as const;
    }
    if (!safety.effectAllowed) {
      return {
        denied: ReviewRunAuthorizationDenialReason.SafetyDecisionDisabled,
      } as const;
    }
    const [limits, slo] = await Promise.all([
      this.dependencies.limits.findProtocolLimitsProfileById(
        release.protocolLimitsProfileId,
      ),
      this.dependencies.slos.findOperationalSloProfileById(
        release.operationalSloProfileId,
      ),
    ]);
    if (!limits || !slo) {
      return {
        denied: ReviewRunAuthorizationDenialReason.ReleaseProfileUnavailable,
      } as const;
    }
    return { repository, authority, release, safety, limits, slo } as const;
  }

  private async confirmRenewalFence(input: {
    readonly identity: VerifiedScmRunIdentity;
    readonly producerReleaseId: string;
    readonly providerVoteLanes: readonly ProviderVoteLane[];
    readonly expectedMutationEpoch: bigint;
    readonly expectedSafetyDecisionHash: string;
  }) {
    for (
      let confirmationRead = 0;
      confirmationRead < 2;
      confirmationRead += 1
    ) {
      const confirmation = await this.loadEligibility(
        input.identity,
        input.producerReleaseId,
        input.providerVoteLanes,
      );
      if ("denied" in confirmation) {
        return confirmation;
      }
      if (
        confirmation.authority.epoch !== input.expectedMutationEpoch ||
        confirmation.safety.safetyDecisionHash !==
          input.expectedSafetyDecisionHash
      ) {
        return {
          denied: ReviewRunAuthorizationDenialReason.SafetyDecisionChanged,
        } as const;
      }
      if (confirmationRead === 1) {
        return confirmation;
      }
    }
    throw new Error("review_run_authorization_fence_confirmation_unreachable");
  }

  private async tokenClaimsMatchAuthorization(
    token: VerifiedReviewRunAuthorizationToken,
    authorization: ReviewRunAuthorization,
  ): Promise<boolean> {
    const scopeHash = await this.dependencies.digest.digestUtf8(
      canonicalJson({
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
      }),
    );
    const issuedAt = authorization.renewedAt ?? authorization.createdAt;
    const expectedLaneIds = authorization.providerVoteLanes.map(
      (lane) => lane.providerVoteIdentityHash,
    );
    return (
      token.capabilityId === authorization.authorizationId &&
      token.authorizationId === authorization.authorizationId &&
      token.issuer === authorization.tokenIssuer &&
      token.audience === authorization.tokenAudience &&
      token.scopeHash === scopeHash &&
      token.producerReleaseId === authorization.producerReleaseId &&
      token.selectedProtocolVersion === authorization.selectedProtocolVersion &&
      token.schemaDigest === authorization.schemaDigest &&
      token.protocolLimitsProfileId === authorization.protocolLimitsProfileId &&
      token.operationalSloProfileId === authorization.operationalSloProfileId &&
      token.mutationEpoch === authorization.mutationEpoch &&
      token.authorizationSafetyDecisionHash ===
        authorization.authorizationSafetyDecisionHash &&
      token.providerVoteLaneIds.length === expectedLaneIds.length &&
      token.providerVoteLaneIds.every(
        (laneId, index) => laneId === expectedLaneIds[index],
      ) &&
      numericDate(token.issuedAt) === numericDate(issuedAt) &&
      numericDate(token.expiresAt) === numericDate(authorization.expiresAt)
    );
  }
}

function numericDate(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

function verifiedIdentityMatches(
  authorization: ReviewRunAuthorization,
  identity: VerifiedScmRunIdentity,
): boolean {
  return (
    authorization.workspaceId === identity.workspaceId &&
    authorization.repositoryConnectionId === identity.repositoryConnectionId &&
    authorization.scmRepositoryIdentityId ===
      identity.scmRepositoryIdentityId &&
    authorization.pullRequestNumber === identity.pullRequestNumber &&
    authorization.sourceRunId === identity.sourceRunId &&
    authorization.sourceRunAttempt === identity.sourceRunAttempt &&
    authorization.workflowIdentityHash === identity.workflowIdentityHash &&
    authorization.baseSha === identity.baseSha &&
    authorization.mergeBaseSha === identity.mergeBaseSha &&
    authorization.headSha === identity.headSha &&
    authorization.reviewRevisionHash === identity.reviewRevisionHash &&
    authorization.trustDomain === identity.trustDomain
  );
}

function denied(
  reason: ReviewRunAuthorizationDenialReason,
): ReviewRunAuthorizationUseCaseResult {
  return {
    status: ReviewRunAuthorizationUseCaseStatus.Denied,
    reason,
  };
}
