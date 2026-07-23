import type {
  ProducerRelease,
  ReviewOperationalSloProfileV2,
  ReviewProtocolLimitsV2,
} from "../../domain/producer-release";
import {
  cloneProducerRelease,
  producerReleaseImmutableKey,
  revokeProducerRelease,
} from "../../domain/producer-release";
import {
  bindScmRepositoryIdentity,
  cloneScmRepositoryIdentity,
  scmRepositoryExternalIdentityKey,
  unbindScmRepositoryIdentity,
  type ScmRepositoryExternalIdentity,
  type ScmRepositoryIdentity,
} from "../../domain/scm-repository-identity";
import {
  cloneReviewMutationAuthority,
  type ReviewMutationAuthority,
} from "../../domain/review-mutation-authority";
import {
  cloneReviewRunAuthorization,
  createReviewRunAuthorization,
  renewReviewRunAuthorization,
  reviewRunAttemptKey,
  reviewRunAuthorizationImmutableKey,
  terminateReviewRunAuthorization,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationCandidate,
} from "../../domain/review-run-authorization";
import {
  reviewRunAuthorizedEvent,
  type ReviewRunAuthorizedIntegrationEvent,
} from "../../application/integration-events/review-run-authorized-event";
import {
  cloneReviewSafetyEmergencyControl,
  cloneReviewSafetyPolicy,
  reviewSafetyPolicyKey,
  reviewSafetyScopeKey,
  safetyScopeApplies,
  type ReviewSafetyPolicySnapshot,
  type ReviewSafetyEmergencyControl,
  type ReviewSafetyPolicy,
  type ReviewSafetyResolutionTarget,
  type ReviewSafetyScope,
} from "../../domain/review-safety-policy";
import {
  ProducerReleaseState,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewRunAuthorizationState,
  ReviewRunControlDomainError,
  ReviewRunControlErrorCode,
  canonicalJson,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
} from "../../domain/review-run-control-types";
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
  type ImmutableRegistryWriteResult,
} from "../../application/ports/producer-release-ports";
import type {
  ReviewMutationAuthorityCommandPort,
  ReviewMutationAuthorityQueryPort,
} from "../../application/ports/review-mutation-authority-ports";
import { ReviewMutationAuthorityWriteStatus } from "../../application/ports/review-mutation-authority-ports";
import type {
  ReviewRunAuthorizationCommandPort,
  ReviewRunAuthorizationAdmissionCommandPort,
  ReviewRunAuthorizationQueryPort,
  ReviewRunAuthorizationAdmissionFence,
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

type RenewalReceipt = {
  readonly authorizationId: string;
  readonly proofHash: string;
  readonly authorization: ReviewRunAuthorization;
};

export class InMemoryReviewRunControlStore
  implements
    ReviewProtocolLimitsProfileQueryPort,
    ReviewProtocolLimitsProfileCommandPort,
    ReviewOperationalSloProfileQueryPort,
    ReviewOperationalSloProfileCommandPort,
    ProducerReleaseQueryPort,
    ProducerReleaseCommandPort,
    ScmRepositoryIdentityQueryPort,
    ScmRepositoryIdentityCommandPort,
    ReviewMutationAuthorityQueryPort,
    ReviewMutationAuthorityCommandPort,
    ReviewSafetyPolicyQueryPort,
    ReviewSafetyPolicyCommandPort,
    ReviewSafetyEmergencyControlQueryPort,
    ReviewSafetyEmergencyControlCommandPort,
    ReviewSafetyControlInspectionPort,
    ReviewRunAuthorizationQueryPort,
    ReviewRunAuthorizationCommandPort,
    ReviewRunAuthorizationAdmissionCommandPort
{
  private readonly limits = new Map<string, ReviewProtocolLimitsV2>();
  private readonly limitsByDigest = new Map<string, string>();
  private readonly slos = new Map<string, ReviewOperationalSloProfileV2>();
  private readonly slosByDigest = new Map<string, string>();
  private readonly releases = new Map<string, ProducerRelease>();
  private readonly releaseIdsByTuple = new Map<string, string>();
  private readonly identities = new Map<string, ScmRepositoryIdentity>();
  private readonly identityIdsByExternal = new Map<string, string>();
  private readonly authorities = new Map<string, ReviewMutationAuthority>();
  private readonly policies = new Map<string, ReviewSafetyPolicy>();
  private readonly emergencyControls = new Map<
    string,
    ReviewSafetyEmergencyControl
  >();
  private readonly authorizations = new Map<string, ReviewRunAuthorization>();
  private readonly authorizationIdsByReplay = new Map<string, string>();
  private readonly authorizationIdsByRunAttempt = new Map<string, string>();
  private readonly renewalReceipts = new Map<string, RenewalReceipt>();
  private readonly authorizationEvents = new Map<
    string,
    ReviewRunAuthorizedIntegrationEvent
  >();
  private safetyStoreReadable = true;

  setSafetyStoreReadable(readable: boolean): void {
    this.safetyStoreReadable = readable;
  }

  async findProtocolLimitsProfileById(
    id: string,
  ): Promise<ReviewProtocolLimitsV2 | null> {
    return cloneLimits(this.limits.get(id) ?? null);
  }

  async registerProtocolLimitsProfile(
    profile: ReviewProtocolLimitsV2,
  ): Promise<ImmutableRegistryWriteResult<ReviewProtocolLimitsV2>> {
    return this.registerImmutable(
      profile,
      profile.protocolLimitsProfileId,
      profile.limitsDigest,
      this.limits,
      this.limitsByDigest,
      cloneLimitsValue,
      stripRegisteredAt,
    );
  }

  async findOperationalSloProfileById(
    id: string,
  ): Promise<ReviewOperationalSloProfileV2 | null> {
    return cloneSlo(this.slos.get(id) ?? null);
  }

  async registerOperationalSloProfile(
    profile: ReviewOperationalSloProfileV2,
  ): Promise<ImmutableRegistryWriteResult<ReviewOperationalSloProfileV2>> {
    return this.registerImmutable(
      profile,
      profile.operationalSloProfileId,
      profile.sloDigest,
      this.slos,
      this.slosByDigest,
      cloneSloValue,
      stripRegisteredAt,
    );
  }

  async findProducerReleaseById(id: string): Promise<ProducerRelease | null> {
    const release = this.releases.get(id);
    return release ? cloneProducerRelease(release) : null;
  }

  async registerProducerRelease(
    release: ProducerRelease,
  ): Promise<ImmutableRegistryWriteResult<ProducerRelease>> {
    const tuple = producerReleaseImmutableKey(release);
    const existingById = this.releases.get(release.producerReleaseId);
    if (existingById) {
      return producerReleaseImmutableKey(existingById) === tuple
        ? {
            status: ImmutableRegistryWriteStatus.Restored,
            value: cloneProducerRelease(existingById),
          }
        : {
            status: ImmutableRegistryWriteStatus.Conflict,
            existingId: existingById.producerReleaseId,
          };
    }
    const tupleOwner = this.releaseIdsByTuple.get(tuple);
    if (tupleOwner) {
      return {
        status: ImmutableRegistryWriteStatus.Conflict,
        existingId: tupleOwner,
      };
    }
    this.releases.set(release.producerReleaseId, cloneProducerRelease(release));
    this.releaseIdsByTuple.set(tuple, release.producerReleaseId);
    return {
      status: ImmutableRegistryWriteStatus.Created,
      value: cloneProducerRelease(release),
    };
  }

  async revokeProducerRelease(input: {
    readonly producerReleaseId: string;
    readonly revokedAt: Date;
  }) {
    const release = this.releases.get(input.producerReleaseId);
    if (!release) {
      return { status: ProducerReleaseRevocationStatus.Missing } as const;
    }
    if (release.state === ProducerReleaseState.Revoked) {
      return {
        status: ProducerReleaseRevocationStatus.Restored,
        release: cloneProducerRelease(release),
      } as const;
    }
    const revoked = revokeProducerRelease(release, input.revokedAt);
    this.releases.set(revoked.producerReleaseId, revoked);
    return {
      status: ProducerReleaseRevocationStatus.Revoked,
      release: cloneProducerRelease(revoked),
    } as const;
  }

  async findScmRepositoryIdentityById(
    id: string,
  ): Promise<ScmRepositoryIdentity | null> {
    const identity = this.identities.get(id);
    return identity ? cloneScmRepositoryIdentity(identity) : null;
  }

  async findScmRepositoryIdentityByExternalIdentity(
    identity: ScmRepositoryExternalIdentity,
  ): Promise<ScmRepositoryIdentity | null> {
    const id = this.identityIdsByExternal.get(
      scmRepositoryExternalIdentityKey(identity),
    );
    return id ? this.findScmRepositoryIdentityById(id) : null;
  }

  async resolveOrRegisterScmRepositoryIdentity(input: {
    readonly identity: ScmRepositoryIdentity;
  }) {
    const externalKey = scmRepositoryExternalIdentityKey(input.identity);
    const existingId = this.identityIdsByExternal.get(externalKey);
    if (existingId) {
      const existing = this.identities.get(existingId);
      if (!existing) {
        throw new Error("memory_identity_index_corrupted");
      }
      return {
        status: ScmRepositoryIdentityResolveStatus.Restored,
        identity: cloneScmRepositoryIdentity(existing),
      } as const;
    }
    const idCollision = this.identities.get(
      input.identity.scmRepositoryIdentityId,
    );
    if (idCollision) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.ImmutableConflict,
        "scm_repository_identity_id_conflict",
      );
    }
    this.identities.set(
      input.identity.scmRepositoryIdentityId,
      cloneScmRepositoryIdentity(input.identity),
    );
    this.identityIdsByExternal.set(
      externalKey,
      input.identity.scmRepositoryIdentityId,
    );
    return {
      status: ScmRepositoryIdentityResolveStatus.Created,
      identity: cloneScmRepositoryIdentity(input.identity),
    } as const;
  }

  async bindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly boundAt: Date;
  }) {
    const identity = this.identities.get(input.scmRepositoryIdentityId);
    if (!identity) {
      return { status: ScmRepositoryIdentityBindingStatus.Missing } as const;
    }
    if (
      identity.currentWorkspaceId === input.workspaceId &&
      identity.currentRepositoryConnectionId === input.repositoryConnectionId
    ) {
      return {
        status: ScmRepositoryIdentityBindingStatus.Restored,
        identity: cloneScmRepositoryIdentity(identity),
      } as const;
    }
    if (identity.version !== input.expectedVersion) {
      return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
    }
    try {
      const bound = bindScmRepositoryIdentity(identity, input);
      this.identities.set(bound.scmRepositoryIdentityId, bound);
      return {
        status: ScmRepositoryIdentityBindingStatus.Bound,
        identity: cloneScmRepositoryIdentity(bound),
      } as const;
    } catch (error) {
      if (error instanceof ReviewRunControlDomainError) {
        return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
      }
      throw error;
    }
  }

  async unbindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly unboundAt: Date;
    readonly authority: {
      readonly laneKind: ReviewMutationLaneKind;
      readonly expectedVersion: number;
    };
  }) {
    const identity = this.identities.get(input.scmRepositoryIdentityId);
    if (!identity) {
      return { status: ScmRepositoryIdentityBindingStatus.Missing } as const;
    }
    if (
      identity.currentWorkspaceId === null &&
      identity.currentRepositoryConnectionId === null
    ) {
      return {
        status: ScmRepositoryIdentityBindingStatus.Restored,
        identity: cloneScmRepositoryIdentity(identity),
      } as const;
    }
    const authority = this.authorities.get(
      authorityKey(input.scmRepositoryIdentityId, input.authority.laneKind),
    );
    if (
      !authority ||
      authority.mode !== ReviewMutationMode.Paused ||
      authority.version !== input.authority.expectedVersion
    ) {
      return {
        status: ScmRepositoryIdentityBindingStatus.AuthorityNotPaused,
      } as const;
    }
    if (identity.version !== input.expectedVersion) {
      return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
    }
    const unbound = unbindScmRepositoryIdentity(identity, input);
    this.identities.set(unbound.scmRepositoryIdentityId, unbound);
    return {
      status: ScmRepositoryIdentityBindingStatus.Unbound,
      identity: cloneScmRepositoryIdentity(unbound),
    } as const;
  }

  async findReviewMutationAuthority(input: {
    readonly scmRepositoryIdentityId: string;
    readonly laneKind: ReviewMutationLaneKind;
  }): Promise<ReviewMutationAuthority | null> {
    const authority = this.authorities.get(
      authorityKey(input.scmRepositoryIdentityId, input.laneKind),
    );
    return authority ? cloneReviewMutationAuthority(authority) : null;
  }

  async initializeReviewMutationAuthority(authority: ReviewMutationAuthority) {
    const key = authorityKey(
      authority.scmRepositoryIdentityId,
      authority.laneKind,
    );
    const existing = this.authorities.get(key);
    if (existing) {
      const compatible =
        existing.mode === authority.mode &&
        existing.epoch === authority.epoch &&
        existing.managedWorkflowInventoryHash ===
          authority.managedWorkflowInventoryHash &&
        existing.activationSafetyDecisionHash ===
          authority.activationSafetyDecisionHash;
      return {
        status: compatible
          ? ReviewMutationAuthorityWriteStatus.Restored
          : ReviewMutationAuthorityWriteStatus.Conflict,
        authority: cloneReviewMutationAuthority(existing),
      } as const;
    }
    this.authorities.set(key, cloneReviewMutationAuthority(authority));
    return {
      status: ReviewMutationAuthorityWriteStatus.Created,
      authority: cloneReviewMutationAuthority(authority),
    } as const;
  }

  async compareAndSetReviewMutationAuthority(input: {
    readonly expectedVersion: number;
    readonly authority: ReviewMutationAuthority;
  }) {
    const key = authorityKey(
      input.authority.scmRepositoryIdentityId,
      input.authority.laneKind,
    );
    const current = this.authorities.get(key);
    if (!current) {
      return { status: ReviewMutationAuthorityWriteStatus.Missing } as const;
    }
    if (
      current.version === input.authority.version &&
      canonicalJson(current) === canonicalJson(input.authority)
    ) {
      return {
        status: ReviewMutationAuthorityWriteStatus.Restored,
        authority: cloneReviewMutationAuthority(current),
      } as const;
    }
    if (
      current.version !== input.expectedVersion ||
      input.authority.version !== input.expectedVersion + 1
    ) {
      return { status: ReviewMutationAuthorityWriteStatus.Conflict } as const;
    }
    this.authorities.set(key, cloneReviewMutationAuthority(input.authority));
    return {
      status: ReviewMutationAuthorityWriteStatus.Updated,
      authority: cloneReviewMutationAuthority(input.authority),
    } as const;
  }

  async findApplicableReviewSafetyPolicies(input: {
    readonly target: ReviewSafetyResolutionTarget;
    readonly capabilities: readonly ReviewSafetyCapability[];
  }): Promise<readonly ReviewSafetyPolicy[]> {
    this.assertSafetyReadable();
    const capabilities = new Set(input.capabilities);
    return [...this.policies.values()]
      .filter(
        (policy) =>
          capabilities.has(policy.capability) &&
          safetyScopeApplies(policy.scope, input.target),
      )
      .map(cloneReviewSafetyPolicy);
  }

  async findApplicableReviewSafetyEmergencyControls(
    target: ReviewSafetyResolutionTarget,
  ): Promise<readonly ReviewSafetyEmergencyControl[]> {
    this.assertSafetyReadable();
    return [...this.emergencyControls.values()]
      .filter((control) => safetyScopeApplies(control.scope, target))
      .map(cloneReviewSafetyEmergencyControl);
  }

  async findReviewSafetyPolicy(input: {
    readonly scope: ReviewSafetyScope;
    readonly capability: ReviewSafetyCapability;
  }): Promise<ReviewSafetyPolicy | null> {
    const policy = this.policies.get(reviewSafetyPolicyKey(input));
    return policy ? cloneReviewSafetyPolicy(policy) : null;
  }

  async findReviewSafetyEmergencyControl(
    scope: ReviewSafetyScope,
  ): Promise<ReviewSafetyEmergencyControl | null> {
    const control = this.emergencyControls.get(reviewSafetyScopeKey(scope));
    return control ? cloneReviewSafetyEmergencyControl(control) : null;
  }

  async putReviewSafetyPolicy(input: {
    readonly expectedVersion: number;
    readonly policy: ReviewSafetyPolicy;
  }) {
    const key = reviewSafetyPolicyKey(input.policy);
    const current = this.policies.get(key);
    if (current && equivalentPolicy(current, input.policy)) {
      return {
        status: ReviewSafetyControlWriteStatus.Restored,
        policy: cloneReviewSafetyPolicy(current),
      };
    }
    if (
      (current?.version ?? 0) !== input.expectedVersion ||
      input.policy.version !== input.expectedVersion + 1
    ) {
      return { status: ReviewSafetyControlWriteStatus.Conflict };
    }
    this.policies.set(key, cloneReviewSafetyPolicy(input.policy));
    return {
      status: current
        ? ReviewSafetyControlWriteStatus.Updated
        : ReviewSafetyControlWriteStatus.Created,
      policy: cloneReviewSafetyPolicy(input.policy),
    };
  }

  async putReviewSafetyEmergencyControl(input: {
    readonly expectedVersion: number;
    readonly control: ReviewSafetyEmergencyControl;
  }) {
    const key = reviewSafetyScopeKey(input.control.scope);
    const current = this.emergencyControls.get(key);
    if (current && equivalentEmergency(current, input.control)) {
      return {
        status: ReviewSafetyControlWriteStatus.Restored,
        control: cloneReviewSafetyEmergencyControl(current),
      };
    }
    if (
      (current?.version ?? 0) !== input.expectedVersion ||
      input.control.version !== input.expectedVersion + 1
    ) {
      return { status: ReviewSafetyControlWriteStatus.Conflict };
    }
    this.emergencyControls.set(
      key,
      cloneReviewSafetyEmergencyControl(input.control),
    );
    return {
      status: current
        ? ReviewSafetyControlWriteStatus.Updated
        : ReviewSafetyControlWriteStatus.Created,
      control: cloneReviewSafetyEmergencyControl(input.control),
    };
  }

  async findReviewRunAuthorizationById(
    authorizationId: string,
  ): Promise<ReviewRunAuthorization | null> {
    const authorization = this.authorizations.get(authorizationId);
    return authorization ? cloneReviewRunAuthorization(authorization) : null;
  }

  async createOrRestoreReviewRunAuthorization(
    candidate: ReviewRunAuthorizationCandidate,
  ) {
    const immutableKey = reviewRunAuthorizationImmutableKey(candidate);
    const replayOwner = this.authorizationIdsByReplay.get(
      candidate.oidcReplayKeyHash,
    );
    if (replayOwner) {
      const existing = this.requireAuthorization(replayOwner);
      return reviewRunAuthorizationImmutableKey(existing) === immutableKey
        ? {
            status: ReviewRunAuthorizationCreateStatus.Restored,
            authorization: cloneReviewRunAuthorization(existing),
          }
        : { status: ReviewRunAuthorizationCreateStatus.ReplayConflict };
    }
    const runOwner = this.authorizationIdsByRunAttempt.get(
      reviewRunAttemptKey(candidate),
    );
    if (runOwner) {
      return { status: ReviewRunAuthorizationCreateStatus.RunAttemptConflict };
    }
    if (this.authorizations.has(candidate.authorizationId)) {
      return { status: ReviewRunAuthorizationCreateStatus.IdentifierConflict };
    }
    const authorization = createReviewRunAuthorization(candidate);
    this.authorizations.set(
      authorization.authorizationId,
      cloneReviewRunAuthorization(authorization),
    );
    this.authorizationIdsByReplay.set(
      authorization.oidcReplayKeyHash,
      authorization.authorizationId,
    );
    this.authorizationIdsByRunAttempt.set(
      reviewRunAttemptKey(authorization),
      authorization.authorizationId,
    );
    return {
      status: ReviewRunAuthorizationCreateStatus.Created,
      authorization: cloneReviewRunAuthorization(authorization),
    };
  }

  async createOrRestoreReviewRunAuthorizationAtomically(input: {
    readonly candidate: ReviewRunAuthorizationCandidate;
    readonly fence: ReviewRunAuthorizationAdmissionFence;
  }) {
    const replayOwner = this.authorizationIdsByReplay.get(
      input.candidate.oidcReplayKeyHash,
    );
    if (replayOwner) {
      const existing = this.requireAuthorization(replayOwner);
      if (
        reviewRunAuthorizationImmutableKey(existing) !==
        reviewRunAuthorizationImmutableKey(input.candidate)
      ) {
        return { status: ReviewRunAuthorizationCreateStatus.ReplayConflict };
      }
      this.requireAuthorizationEvent(existing);
      return {
        status: ReviewRunAuthorizationCreateStatus.Restored,
        authorization: cloneReviewRunAuthorization(existing),
      };
    }
    if (!this.admissionFenceMatches(input.candidate, input.fence)) {
      return { status: ReviewRunAuthorizationCreateStatus.EligibilityChanged };
    }
    const write = await this.createOrRestoreReviewRunAuthorization(
      input.candidate,
    );
    if (
      write.status === ReviewRunAuthorizationCreateStatus.Created &&
      write.authorization
    ) {
      const event = reviewRunAuthorizedEvent(write.authorization);
      this.authorizationEvents.set(event.idempotencyKey, event);
    }
    return write;
  }

  findReviewRunAuthorizedEventForTesting(
    authorizationId: string,
  ): ReviewRunAuthorizedIntegrationEvent | null {
    const event = [...this.authorizationEvents.values()].find(
      (candidate) => candidate.aggregateId === authorizationId,
    );
    return event ? cloneAuthorizationEvent(event) : null;
  }

  async renewReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly expectedVersion: number;
    readonly renewalReplayKeyHash: string;
    readonly renewalProofHash: string;
    readonly renewedAt: Date;
    readonly expiresAt: Date;
  }) {
    const receipt = this.renewalReceipts.get(input.renewalReplayKeyHash);
    if (receipt) {
      return receipt.authorizationId === input.authorizationId &&
        receipt.proofHash === input.renewalProofHash
        ? {
            status: ReviewRunAuthorizationRenewStatus.Restored,
            authorization: cloneReviewRunAuthorization(receipt.authorization),
          }
        : { status: ReviewRunAuthorizationRenewStatus.Conflict };
    }
    const current = this.authorizations.get(input.authorizationId);
    if (!current) {
      return { status: ReviewRunAuthorizationRenewStatus.Missing };
    }
    if (current.state !== ReviewRunAuthorizationState.Active) {
      return {
        status: ReviewRunAuthorizationRenewStatus.Terminal,
        authorization: cloneReviewRunAuthorization(current),
      };
    }
    if (current.version !== input.expectedVersion) {
      return { status: ReviewRunAuthorizationRenewStatus.Conflict };
    }
    const renewed = renewReviewRunAuthorization(current, input);
    this.authorizations.set(
      renewed.authorizationId,
      cloneReviewRunAuthorization(renewed),
    );
    this.renewalReceipts.set(input.renewalReplayKeyHash, {
      authorizationId: input.authorizationId,
      proofHash: input.renewalProofHash,
      authorization: cloneReviewRunAuthorization(renewed),
    });
    return {
      status:
        renewed.version === current.version
          ? ReviewRunAuthorizationRenewStatus.Restored
          : ReviewRunAuthorizationRenewStatus.Renewed,
      authorization: cloneReviewRunAuthorization(renewed),
    };
  }

  async terminateReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly expectedVersion: number;
    readonly state:
      | ReviewRunAuthorizationState.Expired
      | ReviewRunAuthorizationState.Revoked;
    readonly at: Date;
  }) {
    const current = this.authorizations.get(input.authorizationId);
    if (!current) {
      return { status: ReviewRunAuthorizationTerminateStatus.Missing };
    }
    if (current.state === input.state) {
      return {
        status: ReviewRunAuthorizationTerminateStatus.Restored,
        authorization: cloneReviewRunAuthorization(current),
      };
    }
    if (
      current.version !== input.expectedVersion ||
      current.state !== ReviewRunAuthorizationState.Active
    ) {
      return {
        status: ReviewRunAuthorizationTerminateStatus.Conflict,
        authorization: cloneReviewRunAuthorization(current),
      };
    }
    const terminated = terminateReviewRunAuthorization(current, input);
    this.authorizations.set(
      terminated.authorizationId,
      cloneReviewRunAuthorization(terminated),
    );
    return {
      status: ReviewRunAuthorizationTerminateStatus.Terminated,
      authorization: cloneReviewRunAuthorization(terminated),
    };
  }

  private registerImmutable<T>(
    value: T,
    id: string,
    digest: string,
    values: Map<string, T>,
    idsByDigest: Map<string, string>,
    clone: (value: T) => T,
    comparable: (value: T) => unknown,
  ): ImmutableRegistryWriteResult<T> {
    const existing = values.get(id);
    if (existing) {
      return canonicalJson(comparable(existing)) ===
        canonicalJson(comparable(value))
        ? {
            status: ImmutableRegistryWriteStatus.Restored,
            value: clone(existing),
          }
        : { status: ImmutableRegistryWriteStatus.Conflict, existingId: id };
    }
    const digestOwner = idsByDigest.get(digest);
    if (digestOwner) {
      return {
        status: ImmutableRegistryWriteStatus.Conflict,
        existingId: digestOwner,
      };
    }
    values.set(id, clone(value));
    idsByDigest.set(digest, id);
    return {
      status: ImmutableRegistryWriteStatus.Created,
      value: clone(value),
    };
  }

  private requireAuthorization(id: string): ReviewRunAuthorization {
    const authorization = this.authorizations.get(id);
    if (!authorization) {
      throw new Error("memory_authorization_index_corrupted");
    }
    return authorization;
  }

  private requireAuthorizationEvent(
    authorization: ReviewRunAuthorization,
  ): void {
    const expected = reviewRunAuthorizedEvent(authorization);
    const event = this.authorizationEvents.get(expected.idempotencyKey);
    if (!event || canonicalJson(event) !== canonicalJson(expected)) {
      throw new Error(
        "memory_review_run_authorized_event_missing_or_conflicting",
      );
    }
  }

  private admissionFenceMatches(
    candidate: ReviewRunAuthorizationCandidate,
    fence: ReviewRunAuthorizationAdmissionFence,
  ): boolean {
    if (!this.safetyStoreReadable) return false;
    const identity = this.identities.get(candidate.scmRepositoryIdentityId);
    const authority = this.authorities.get(
      authorityKey(
        candidate.scmRepositoryIdentityId,
        ReviewMutationLaneKind.HostedReviewRouterApp,
      ),
    );
    const release = this.releases.get(candidate.producerReleaseId);
    const limits = this.limits.get(candidate.protocolLimitsProfileId);
    const slo = this.slos.get(candidate.operationalSloProfileId);
    return Boolean(
      identity &&
      identity.version === fence.repositoryIdentityVersion &&
      identity.currentWorkspaceId === candidate.workspaceId &&
      identity.currentRepositoryConnectionId ===
        candidate.repositoryConnectionId &&
      authority &&
      authority.version === fence.mutationAuthorityVersion &&
      authority.epoch === candidate.mutationEpoch &&
      authority.mode === ReviewMutationMode.V2Active &&
      release &&
      release.state === ProducerReleaseState.Registered &&
      producerReleaseImmutableKey(release) ===
        producerReleaseImmutableKey(fence.producerRelease) &&
      limits?.limitsDigest === fence.protocolLimitsDigest &&
      slo?.sloDigest === fence.operationalSloDigest &&
      candidate.authorizationSafetyDecisionHash ===
        fence.safetySnapshot.safetyDecisionHash &&
      fence.safetyTarget.workspaceId === candidate.workspaceId &&
      fence.safetyTarget.repositoryConnectionId ===
        candidate.repositoryConnectionId &&
      fence.safetyTarget.scmRepositoryIdentityId ===
        candidate.scmRepositoryIdentityId &&
      fence.safetySnapshot.effectAllowed &&
      sameSafetyPolicyVersions(
        this.policies.values(),
        fence.safetyTarget,
        fence.safetySnapshot,
      ) &&
      sameEmergencyVersions(
        this.emergencyControls.values(),
        fence.safetyTarget,
        fence.safetySnapshot.emergencyVersionVector,
      ),
    );
  }

  private assertSafetyReadable(): void {
    if (!this.safetyStoreReadable) {
      throw new Error("memory_safety_store_unreadable");
    }
  }
}

function authorityKey(
  scmRepositoryIdentityId: string,
  laneKind: ReviewMutationLaneKind,
): string {
  return `${scmRepositoryIdentityId}:${laneKind}`;
}

function cloneLimits(
  profile: ReviewProtocolLimitsV2 | null,
): ReviewProtocolLimitsV2 | null {
  return profile ? cloneLimitsValue(profile) : null;
}

function cloneLimitsValue(
  profile: ReviewProtocolLimitsV2,
): ReviewProtocolLimitsV2 {
  return { ...profile, registeredAt: new Date(profile.registeredAt) };
}

function cloneSlo(
  profile: ReviewOperationalSloProfileV2 | null,
): ReviewOperationalSloProfileV2 | null {
  return profile ? cloneSloValue(profile) : null;
}

function cloneSloValue(
  profile: ReviewOperationalSloProfileV2,
): ReviewOperationalSloProfileV2 {
  return {
    ...profile,
    ownerRefs: [...profile.ownerRefs],
    runbookRefs: [...profile.runbookRefs],
    registeredAt: new Date(profile.registeredAt),
  };
}

function stripRegisteredAt<T extends { readonly registeredAt: Date }>(
  value: T,
): Omit<T, "registeredAt"> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "registeredAt"),
  ) as Omit<T, "registeredAt">;
}

function equivalentPolicy(
  left: ReviewSafetyPolicy,
  right: ReviewSafetyPolicy,
): boolean {
  return (
    canonicalJson({ ...left, updatedAt: undefined }) ===
    canonicalJson({ ...right, updatedAt: undefined })
  );
}

function equivalentEmergency(
  left: ReviewSafetyEmergencyControl,
  right: ReviewSafetyEmergencyControl,
): boolean {
  return (
    canonicalJson({ ...left, updatedAt: undefined }) ===
    canonicalJson({ ...right, updatedAt: undefined })
  );
}

function sameSafetyPolicyVersions(
  policies: Iterable<ReviewSafetyPolicy>,
  target: ReviewSafetyResolutionTarget,
  snapshot: ReviewSafetyPolicySnapshot,
): boolean {
  const expected = snapshot.capabilityDecisions.find(
    (decision) =>
      decision.capability === ReviewSafetyCapability.RunAuthorizationV2,
  );
  if (!expected) return false;
  const actual = [...policies]
    .filter(
      (policy) =>
        policy.capability === ReviewSafetyCapability.RunAuthorizationV2 &&
        safetyScopeApplies(policy.scope, target),
    )
    .sort(
      (left, right) =>
        safetyScopeRank(left.scope.scope) - safetyScopeRank(right.scope.scope),
    )
    .map(
      (policy) => `${policy.policyId}:${policy.version}:${policy.rolloutMode}`,
    );
  return (
    canonicalJson(actual) === canonicalJson(expected.contributingPolicyVersions)
  );
}

function sameEmergencyVersions(
  controls: Iterable<ReviewSafetyEmergencyControl>,
  target: ReviewSafetyResolutionTarget,
  expected: readonly string[],
): boolean {
  const byScope = new Map(
    [...controls]
      .filter((control) => safetyScopeApplies(control.scope, target))
      .map((control) => [reviewSafetyScopeKey(control.scope), control]),
  );
  const scopeKeys = [
    ReviewSafetyPolicyScope.Global,
    `${ReviewSafetyPolicyScope.Workspace}:${target.workspaceId}`,
    [
      ReviewSafetyPolicyScope.Repository,
      target.workspaceId,
      target.repositoryConnectionId,
      target.scmRepositoryIdentityId,
    ].join(":"),
  ];
  const actual = scopeKeys.map((scope) => {
    const control = byScope.get(scope);
    return control
      ? `${control.emergencyControlId}:${control.version}:${control.stopped ? "stopped" : "open"}`
      : `${scope}:missing`;
  });
  return canonicalJson(actual) === canonicalJson(expected);
}

function safetyScopeRank(scope: ReviewSafetyPolicyScope): number {
  switch (scope) {
    case ReviewSafetyPolicyScope.Global:
      return 0;
    case ReviewSafetyPolicyScope.Workspace:
      return 1;
    case ReviewSafetyPolicyScope.Repository:
      return 2;
  }
}

function cloneAuthorizationEvent(
  event: ReviewRunAuthorizedIntegrationEvent,
): ReviewRunAuthorizedIntegrationEvent {
  return {
    ...event,
    payload: { ...event.payload },
    occurredAt: new Date(event.occurredAt),
  };
}
