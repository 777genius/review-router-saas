import {
  assertDigest,
  assertIdentifier,
  assertPositiveInteger,
  ReviewInvestigationDomainError,
} from "../../domain/canonicalization";
import {
  reviewInvestigationLeaseBindingIsCurrent,
  ReviewInvestigationLeaseState,
  type ReviewInvestigationLease,
  type ReviewInvestigationLeaseTransitionResult,
} from "../../domain/investigation-lease";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import type { InvestigationManifestIdentityPort } from "../ports/investigation-manifest-identity-port";
import type {
  InvestigationLeaseAcquireResult,
  InvestigationLeaseStorePort,
} from "../ports/investigation-lease-store-port";
import type { InvestigationStorePort } from "../ports/investigation-store-port";
import {
  computeInvestigationManifestKey,
  requireCurrentExecution,
} from "./investigation-use-case-support";

export type AcquireInvestigationLeaseCommand = Readonly<{
  investigationId: string;
  expectedVersion: number;
  turnId: string;
  authorizationId: string;
  mutationEpoch: bigint;
  providerStrategyId: string;
  investigationManifestCanonicalJson: string;
  investigationManifestHash: string;
  acquireRequestId: string;
  acquireRequestHash: string;
  ownerIdHash: string;
  leaseId: string;
  attemptId: string;
  leaseCapabilityId: string;
  capabilitySigningKeyId: string;
  initialLeaseDurationMs: number;
  retentionDurationMs: number;
}>;

export class AcquireInvestigationLease {
  constructor(
    private readonly investigations: InvestigationStorePort,
    private readonly leases: InvestigationLeaseStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly manifestIdentity: InvestigationManifestIdentityPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: AcquireInvestigationLeaseCommand,
  ): Promise<InvestigationLeaseAcquireResult> {
    validateAcquireCommand(command);
    const investigation = await this.investigations.findById(
      command.investigationId,
    );
    if (!investigation) throw new Error("investigation_missing");
    const turn = investigation.activeTurn;
    if (
      investigation.version !== command.expectedVersion ||
      turn === null ||
      turn.turnId !== command.turnId ||
      investigation.providerStrategyId !== command.providerStrategyId ||
      investigation.investigationManifestCanonicalJson !==
        command.investigationManifestCanonicalJson ||
      investigation.investigationManifestHash !==
        command.investigationManifestHash
    ) {
      throw new Error("investigation_lease_binding_stale");
    }
    await requireCurrentExecution({ authority: this.authority, investigation });
    if (
      (await computeInvestigationManifestKey(
        this.manifestIdentity,
        command.investigationManifestCanonicalJson,
      )) !== command.investigationManifestHash
    ) {
      throw new ReviewInvestigationDomainError(
        "investigation_lease_manifest_hash_mismatch",
      );
    }
    const now = this.clock.now();
    const turnExpiresAt = new Date(turn.expiresAt);
    if (turnExpiresAt <= now) {
      throw new Error("investigation_turn_expired");
    }
    const expiresAt = new Date(
      Math.min(
        now.getTime() + command.initialLeaseDurationMs,
        turnExpiresAt.getTime(),
      ),
    );
    return this.leases.acquireLease({
      leaseId: command.leaseId,
      workspaceId: investigation.scope.workspaceId,
      repositoryConnectionId: investigation.scope.repositoryConnectionId,
      scmRepositoryIdentityId: investigation.scope.scmRepositoryIdentityId,
      pullRequestNumber: investigation.scope.pullRequestNumber,
      authorizationId: command.authorizationId,
      mutationEpoch: command.mutationEpoch,
      executionId: investigation.executionId,
      workSlotId: investigation.workSlotId,
      revision: investigation.revision,
      investigationId: investigation.investigationId,
      investigationVersion: investigation.version,
      turnId: turn.turnId,
      turnPurpose: turn.purpose,
      providerVoteLaneId: investigation.providerVoteLaneId,
      providerStrategyId: investigation.providerStrategyId,
      investigationManifestCanonicalJson:
        command.investigationManifestCanonicalJson,
      investigationManifestHash: command.investigationManifestHash,
      attemptId: command.attemptId,
      acquireRequestIdHash: await this.digest.digestUtf8(
        command.acquireRequestId,
      ),
      acquireRequestHash: command.acquireRequestHash,
      ownerIdHash: command.ownerIdHash,
      leaseCapabilityId: command.leaseCapabilityId,
      capabilitySigningKeyId: command.capabilitySigningKeyId,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      resultReportUntil: turnExpiresAt.toISOString(),
      retainUntil: new Date(
        turnExpiresAt.getTime() + command.retentionDurationMs,
      ).toISOString(),
    });
  }
}

export type RenewInvestigationLeaseCommand = Readonly<{
  leaseId: string;
  ownerIdHash: string;
  leaseCapabilityId: string;
  fencingToken: bigint;
  renewRequestId: string;
  renewRequestHash: string;
  leaseDurationMs: number;
}>;

export class RenewInvestigationLease {
  constructor(
    private readonly investigations: InvestigationStorePort,
    private readonly leases: InvestigationLeaseStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: RenewInvestigationLeaseCommand,
  ): Promise<ReviewInvestigationLeaseTransitionResult | null> {
    assertIdentifier(command.leaseId, "investigation_lease_id");
    assertDigest(command.ownerIdHash, "investigation_lease_owner_id_hash");
    assertIdentifier(
      command.leaseCapabilityId,
      "investigation_lease_capability_id",
    );
    assertIdentifier(
      command.renewRequestId,
      "investigation_lease_renew_request_id",
    );
    assertDigest(
      command.renewRequestHash,
      "investigation_lease_renew_request_hash",
    );
    assertPositiveInteger(
      command.leaseDurationMs,
      "investigation_lease_duration_ms",
    );
    const lease = await this.leases.findLease(command.leaseId);
    if (!lease) return null;
    const investigation = await this.requireBoundCurrentInvestigation(lease);
    const turn = investigation.activeTurn!;
    const now = this.clock.now();
    const expiresAt = new Date(
      Math.min(
        now.getTime() + command.leaseDurationMs,
        new Date(turn.expiresAt).getTime(),
      ),
    );
    return this.leases.renewLease({
      leaseId: command.leaseId,
      ownerIdHash: command.ownerIdHash,
      leaseCapabilityId: command.leaseCapabilityId,
      fencingToken: command.fencingToken,
      renewRequestIdHash: await this.digest.digestUtf8(command.renewRequestId),
      renewRequestHash: command.renewRequestHash,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  }

  private async requireBoundCurrentInvestigation(
    lease: ReviewInvestigationLease,
  ) {
    const investigation = await this.investigations.findById(
      lease.investigationId,
    );
    if (
      !investigation ||
      !reviewInvestigationLeaseBindingIsCurrent(lease, investigation)
    ) {
      throw new Error("investigation_lease_binding_stale");
    }
    await requireCurrentExecution({ authority: this.authority, investigation });
    return investigation;
  }
}

export type ReleaseInvestigationLeaseCommand = Readonly<{
  leaseId: string;
  ownerIdHash: string;
  leaseCapabilityId: string;
  fencingToken: bigint;
  releaseRequestId: string;
  releaseRequestHash: string;
}>;

export class ReleaseInvestigationLease {
  constructor(
    private readonly leases: InvestigationLeaseStorePort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: ReleaseInvestigationLeaseCommand,
  ): Promise<ReviewInvestigationLeaseTransitionResult | null> {
    assertIdentifier(command.leaseId, "investigation_lease_id");
    assertDigest(command.ownerIdHash, "investigation_lease_owner_id_hash");
    assertIdentifier(
      command.leaseCapabilityId,
      "investigation_lease_capability_id",
    );
    assertIdentifier(
      command.releaseRequestId,
      "investigation_lease_release_request_id",
    );
    assertDigest(
      command.releaseRequestHash,
      "investigation_lease_release_request_hash",
    );
    return this.leases.releaseLease({
      leaseId: command.leaseId,
      ownerIdHash: command.ownerIdHash,
      leaseCapabilityId: command.leaseCapabilityId,
      fencingToken: command.fencingToken,
      releaseRequestIdHash: await this.digest.digestUtf8(
        command.releaseRequestId,
      ),
      releaseRequestHash: command.releaseRequestHash,
      now: this.clock.now().toISOString(),
    });
  }
}

function validateAcquireCommand(
  command: AcquireInvestigationLeaseCommand,
): void {
  for (const [value, field] of [
    [command.investigationId, "investigation_id"],
    [command.turnId, "investigation_turn_id"],
    [command.authorizationId, "investigation_authorization_id"],
    [command.providerStrategyId, "investigation_provider_strategy_id"],
    [command.acquireRequestId, "investigation_lease_acquire_request_id"],
    [command.leaseId, "investigation_lease_id"],
    [command.attemptId, "investigation_lease_attempt_id"],
    [command.leaseCapabilityId, "investigation_lease_capability_id"],
    [
      command.capabilitySigningKeyId,
      "investigation_lease_capability_signing_key_id",
    ],
  ] as const) {
    assertIdentifier(value, field);
  }
  assertPositiveInteger(command.expectedVersion, "investigation_version");
  assertPositiveInteger(
    command.initialLeaseDurationMs,
    "investigation_lease_duration_ms",
  );
  assertPositiveInteger(
    command.retentionDurationMs,
    "investigation_lease_retention_ms",
  );
  assertDigest(
    command.investigationManifestHash,
    "investigation_lease_manifest_hash",
  );
  assertDigest(command.ownerIdHash, "investigation_lease_owner_id_hash");
  assertDigest(command.acquireRequestHash, "investigation_lease_request_hash");
  if (command.mutationEpoch <= 0n) {
    throw new ReviewInvestigationDomainError(
      "investigation_lease_mutation_epoch_invalid",
    );
  }
}

export function investigationLeaseIsUsable(
  lease: ReviewInvestigationLease,
  now: Date,
): boolean {
  return (
    lease.state === ReviewInvestigationLeaseState.Active &&
    new Date(lease.expiresAt) > now
  );
}
