import {
  InvestigationStoreCommitGuardKind,
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
  type InvestigationStoreCommitResult,
  type InvestigationStorePort,
} from "../../application/ports/investigation-store-port";
import {
  InvestigationPrivateMaterialPersistenceStatus,
  type InvestigationPrivateMaterialStorePort,
} from "../../application/ports/investigation-private-material-ports";
import {
  assertPersistedInvestigationRequirementsSanitized,
  validateInvestigationPrivateMaterialCommit,
} from "../../application/investigation-private-material-commit-policy";
import {
  createEncryptedInvestigationPrivateMaterial,
  type EncryptedInvestigationPrivateMaterial,
} from "../../domain/investigation-private-material";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import { ReviewInvestigationState } from "../../domain/review-investigation-types";
import { TurnResultAdmissionKind } from "../../domain/turn-result-admission";
import {
  assertReviewInvestigationLease,
  createReviewInvestigationLease,
  decideReviewInvestigationLeaseReplay,
  expireReviewInvestigationLease,
  reviewInvestigationLeaseBindingIsCurrent,
  releaseReviewInvestigationLease,
  revokeReviewInvestigationLease,
  renewReviewInvestigationLease,
  ReviewInvestigationLeaseReplayStatus,
  ReviewInvestigationLeaseState,
  ReviewInvestigationLeaseTransitionStatus,
  type CreateReviewInvestigationLeaseInput,
  type ReviewInvestigationLease,
} from "../../domain/investigation-lease";
import {
  InvestigationLeaseAcquireStatus,
  type InvestigationLeaseAcquireResult,
  type InvestigationLeaseStorePort,
} from "../../application/ports/investigation-lease-store-port";

type StoredCommand = Readonly<{
  commandHash: string;
  investigationId: string;
}>;

export class InMemoryInvestigationStore
  implements
    InvestigationStorePort,
    InvestigationPrivateMaterialStorePort,
    InvestigationLeaseStorePort
{
  private readonly investigations = new Map<string, ReviewInvestigation>();
  private readonly naturalIdentityIndex = new Map<string, string>();
  private readonly commands = new Map<string, StoredCommand>();
  private readonly privateMaterials = new Map<
    string,
    EncryptedInvestigationPrivateMaterial
  >();
  private readonly privateMaterialObligationIndex = new Map<string, string>();
  private readonly leases = new Map<string, ReviewInvestigationLease>();
  private nextLeaseFencingToken = 1n;
  private transactionTail: Promise<void> = Promise.resolve();

  async restoreCommand(input: {
    readonly commandId: string;
    readonly commandHash: string;
  }): Promise<InvestigationStoreCommitResult | null> {
    await this.transactionTail;
    const command = this.commands.get(input.commandId);
    if (!command) return null;
    if (command.commandHash !== input.commandHash) {
      return {
        status: InvestigationStoreCommitStatus.IdempotencyConflict,
        investigation: null,
      };
    }
    return {
      status: InvestigationStoreCommitStatus.Restored,
      investigation: clone(
        this.investigations.get(command.investigationId) ?? null,
      ),
    };
  }

  async findById(investigationId: string): Promise<ReviewInvestigation | null> {
    await this.transactionTail;
    return clone(this.investigations.get(investigationId) ?? null);
  }

  async findByNaturalIdentity(
    naturalIdentityHash: string,
  ): Promise<ReviewInvestigation | null> {
    await this.transactionTail;
    const id = this.naturalIdentityIndex.get(naturalIdentityHash);
    return id ? clone(this.investigations.get(id) ?? null) : null;
  }

  async findByCertificateId(
    certificateId: string,
  ): Promise<ReviewInvestigation | null> {
    await this.transactionTail;
    const investigation = [...this.investigations.values()].find(
      (item) => item.certificate?.certificateId === certificateId,
    );
    return clone(investigation ?? null);
  }

  async findReplayCandidates(
    input: Parameters<InvestigationStorePort["findReplayCandidates"]>[0],
  ): Promise<readonly ReviewInvestigation[]> {
    await this.transactionTail;
    return [...this.investigations.values()]
      .filter(
        (item) =>
          item.replayEvidenceCheckpoint !== null &&
          item.revision.reviewRevisionHash !== input.targetReviewRevisionHash &&
          item.stableReviewUnitKey === input.stableReviewUnitKey &&
          item.providerVoteLaneId === input.providerVoteLaneId &&
          item.contract.producerReleaseId === input.producerReleaseId &&
          item.scope.workspaceId === input.scope.workspaceId &&
          item.scope.repositoryConnectionId ===
            input.scope.repositoryConnectionId &&
          item.scope.scmRepositoryIdentityId ===
            input.scope.scmRepositoryIdentityId &&
          item.scope.pullRequestNumber === input.scope.pullRequestNumber &&
          item.scope.trustDomain === input.scope.trustDomain &&
          item.scope.authorizationScopeHash ===
            input.scope.authorizationScopeHash,
      )
      .sort(
        (left, right) =>
          right.replayEvidenceCheckpoint!.issuedAt.localeCompare(
            left.replayEvidenceCheckpoint!.issuedAt,
          ) || left.investigationId.localeCompare(right.investigationId),
      )
      .slice(0, input.limit)
      .map((item) => clone(item));
  }

  async findExpiredActiveTurnIds(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<readonly string[]> {
    await this.transactionTail;
    const cutoff = new Date(input.expiresAtOrBefore);
    return [...this.investigations.values()]
      .filter(
        (item) =>
          item.activeTurn !== null &&
          new Date(item.activeTurn.expiresAt) <= cutoff,
      )
      .sort(
        (left, right) =>
          left.activeTurn!.expiresAt.localeCompare(
            right.activeTurn!.expiresAt,
          ) || left.investigationId.localeCompare(right.investigationId),
      )
      .slice(0, input.limit)
      .map((item) => item.investigationId);
  }

  async findLease(leaseId: string): Promise<ReviewInvestigationLease | null> {
    await this.transactionTail;
    return cloneLease(this.leases.get(leaseId) ?? null);
  }

  async acquireLease(
    candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
  ): Promise<InvestigationLeaseAcquireResult> {
    return this.atomic(() => {
      const investigation = this.investigations.get(candidate.investigationId);
      if (
        !investigation ||
        !reviewInvestigationLeaseBindingIsCurrent(candidate, investigation)
      ) {
        this.revokeActiveLeasesForInvestigation(candidate.investigationId);
        return leaseAcquireResult(
          InvestigationLeaseAcquireStatus.BindingStale,
          null,
        );
      }
      const existing = [...this.leases.values()].find(
        (lease) =>
          lease.investigationId === candidate.investigationId &&
          lease.turnId === candidate.turnId &&
          lease.acquireRequestIdHash === candidate.acquireRequestIdHash,
      );
      const replay = decideReviewInvestigationLeaseReplay({
        existing: existing ?? null,
        candidate,
      });
      if (replay === ReviewInvestigationLeaseReplayStatus.Restored) {
        return leaseAcquireResult(
          InvestigationLeaseAcquireStatus.Restored,
          existing!,
        );
      }
      if (replay === ReviewInvestigationLeaseReplayStatus.IdempotencyConflict) {
        return leaseAcquireResult(
          InvestigationLeaseAcquireStatus.IdempotencyConflict,
          null,
        );
      }
      const now = new Date(candidate.acquiredAt);
      const active = [...this.leases.values()].find(
        (lease) =>
          lease.investigationId === candidate.investigationId &&
          lease.turnId === candidate.turnId &&
          lease.state === ReviewInvestigationLeaseState.Active,
      );
      if (active && new Date(active.expiresAt) > now) {
        return leaseAcquireResult(InvestigationLeaseAcquireStatus.Busy, null);
      }
      if (active) {
        this.leases.set(active.leaseId, expireReviewInvestigationLease(active));
      }
      const lease = createReviewInvestigationLease({
        ...candidate,
        fencingToken: this.nextLeaseFencingToken,
      });
      this.nextLeaseFencingToken += 1n;
      this.leases.set(lease.leaseId, lease);
      return leaseAcquireResult(
        InvestigationLeaseAcquireStatus.Acquired,
        lease,
      );
    });
  }

  async renewLease(
    input: Parameters<InvestigationLeaseStorePort["renewLease"]>[0],
  ) {
    return this.atomic(() => {
      const lease = this.leases.get(input.leaseId);
      if (!lease) return null;
      const investigation = this.investigations.get(lease.investigationId);
      if (
        !investigation ||
        !reviewInvestigationLeaseBindingIsCurrent(lease, investigation)
      ) {
        const revoked = revokeReviewInvestigationLease(lease);
        this.leases.set(lease.leaseId, revoked);
        return {
          status: ReviewInvestigationLeaseTransitionStatus.BindingStale,
          lease: cloneLease(revoked)!,
        };
      }
      const result = renewReviewInvestigationLease({ lease, ...input });
      this.leases.set(lease.leaseId, result.lease);
      return { ...result, lease: cloneLease(result.lease)! };
    });
  }

  async releaseLease(
    input: Parameters<InvestigationLeaseStorePort["releaseLease"]>[0],
  ) {
    return this.atomic(() => {
      const lease = this.leases.get(input.leaseId);
      if (!lease) return null;
      const investigation = this.investigations.get(lease.investigationId);
      if (
        !investigation ||
        !reviewInvestigationLeaseBindingIsCurrent(lease, investigation)
      ) {
        const revoked = revokeReviewInvestigationLease(lease);
        this.leases.set(lease.leaseId, revoked);
        return {
          status: ReviewInvestigationLeaseTransitionStatus.BindingStale,
          lease: cloneLease(revoked)!,
        };
      }
      const result = releaseReviewInvestigationLease({ lease, ...input });
      this.leases.set(lease.leaseId, result.lease);
      return { ...result, lease: cloneLease(result.lease)! };
    });
  }

  async commit(
    input: Parameters<InvestigationStorePort["commit"]>[0],
  ): Promise<InvestigationStoreCommitResult> {
    return this.atomic(() => {
      const previousCommand = this.commands.get(input.commandId);
      if (previousCommand) {
        if (previousCommand.commandHash !== input.commandHash) {
          return {
            status: InvestigationStoreCommitStatus.IdempotencyConflict,
            investigation: null,
          };
        }
        return {
          status: InvestigationStoreCommitStatus.Restored,
          investigation: clone(
            this.investigations.get(previousCommand.investigationId) ?? null,
          ),
        };
      }
      const privateMaterials = validateInvestigationPrivateMaterialCommit({
        investigation: input.investigation,
        expectedVersion: input.expectedVersion,
        transition: input.transition,
        privateMaterials: input.privateMaterials ?? [],
      });
      const existing = this.investigations.get(
        input.investigation.investigationId,
      );
      const byNaturalIdentity = this.naturalIdentityIndex.get(
        input.investigation.naturalIdentityHash,
      );
      if (
        input.expectedVersion === null
          ? existing !== undefined || byNaturalIdentity !== undefined
          : existing?.version !== input.expectedVersion
      ) {
        return {
          status: InvestigationStoreCommitStatus.ConcurrencyConflict,
          investigation: existing ? clone(existing) : null,
        };
      }
      if (!this.commitGuardIsCurrent(input, existing ?? input.investigation)) {
        return {
          status: InvestigationStoreCommitStatus.LeaseFenceConflict,
          investigation: existing ? clone(existing) : null,
        };
      }
      for (const material of privateMaterials) {
        if (
          this.privateMaterials.has(material.privateMaterialId) ||
          this.privateMaterialObligationIndex.has(
            privateMaterialObligationKey(
              material.investigationId,
              material.obligationId,
            ),
          )
        ) {
          throw new Error("investigation_private_material_conflict");
        }
      }
      const stored = clone(input.investigation)!;
      this.investigations.set(stored.investigationId, stored);
      this.revokeStaleActiveLeases(stored);
      this.naturalIdentityIndex.set(
        stored.naturalIdentityHash,
        stored.investigationId,
      );
      this.commands.set(input.commandId, {
        commandHash: input.commandHash,
        investigationId: stored.investigationId,
      });
      for (const material of privateMaterials) {
        const storedMaterial = clone(material)!;
        this.privateMaterials.set(
          storedMaterial.privateMaterialId,
          storedMaterial,
        );
        this.privateMaterialObligationIndex.set(
          privateMaterialObligationKey(
            storedMaterial.investigationId,
            storedMaterial.obligationId,
          ),
          storedMaterial.privateMaterialId,
        );
      }
      return {
        status: InvestigationStoreCommitStatus.Committed,
        investigation: clone(stored),
      };
    });
  }

  private commitGuardIsCurrent(
    input: Parameters<InvestigationStorePort["commit"]>[0],
    current: ReviewInvestigation,
  ): boolean {
    if (input.guard === undefined) return true;
    if (input.guard.kind !== InvestigationStoreCommitGuardKind.LeaseFence) {
      return false;
    }
    if (
      input.transition.kind !==
        InvestigationStoreTransitionKind.TurnCommitted ||
      input.transition.turnId !== input.guard.turnId
    ) {
      return false;
    }
    const source = this.leases.get(input.guard.leaseId);
    if (
      !source ||
      source.state !== ReviewInvestigationLeaseState.Active ||
      source.investigationId !== input.investigation.investigationId ||
      source.turnId !== input.guard.turnId ||
      source.attemptId !== input.guard.attemptId ||
      source.fencingToken.toString(10) !== input.guard.fencingToken ||
      (input.guard.leaseCapabilityId !== undefined &&
        source.leaseCapabilityId !== input.guard.leaseCapabilityId) ||
      (input.guard.authorizationId !== undefined &&
        source.authorizationId !== input.guard.authorizationId) ||
      (input.guard.mutationEpoch !== undefined &&
        source.mutationEpoch !== input.guard.mutationEpoch)
    ) {
      return false;
    }
    if (!resultAdmissionDeadlineIsCurrent(input.guard, source, current)) {
      return false;
    }
    if (
      input.guard.resultAdmission === TurnResultAdmissionKind.Rejected ||
      (input.guard.resultAdmission ===
        TurnResultAdmissionKind.HistoricalDrain &&
        input.investigation.state !== ReviewInvestigationState.Superseded) ||
      (input.guard.resultAdmission === TurnResultAdmissionKind.Current &&
        input.investigation.state === ReviewInvestigationState.Superseded)
    ) {
      return false;
    }
    if (!reviewInvestigationLeaseBindingIsCurrent(source, current)) {
      return false;
    }
    const newestFence = [...this.leases.values()]
      .filter(
        (lease) =>
          lease.investigationId === source.investigationId &&
          lease.turnId === source.turnId,
      )
      .reduce(
        (latest, lease) =>
          lease.fencingToken > latest ? lease.fencingToken : latest,
        0n,
      );
    return newestFence === source.fencingToken;
  }

  private revokeActiveLeasesForInvestigation(investigationId: string): void {
    for (const lease of this.leases.values()) {
      if (
        lease.investigationId === investigationId &&
        lease.state === ReviewInvestigationLeaseState.Active
      ) {
        this.leases.set(lease.leaseId, revokeReviewInvestigationLease(lease));
      }
    }
  }

  private revokeStaleActiveLeases(investigation: ReviewInvestigation): void {
    for (const lease of this.leases.values()) {
      if (
        lease.investigationId === investigation.investigationId &&
        lease.state === ReviewInvestigationLeaseState.Active &&
        !reviewInvestigationLeaseBindingIsCurrent(lease, investigation)
      ) {
        this.leases.set(lease.leaseId, revokeReviewInvestigationLease(lease));
      }
    }
  }

  async savePrivateMaterial(
    materialInput: EncryptedInvestigationPrivateMaterial,
  ): Promise<InvestigationPrivateMaterialPersistenceStatus> {
    const material = createEncryptedInvestigationPrivateMaterial(materialInput);
    return this.atomic(() => {
      const investigation = this.investigations.get(material.investigationId);
      if (
        !investigation ||
        (material.obligationId !== null &&
          !investigation.obligations.some(
            (obligation) => obligation.obligationId === material.obligationId,
          ))
      ) {
        throw new Error("investigation_private_material_parent_missing");
      }
      const obligationKey = privateMaterialObligationKey(
        material.investigationId,
        material.obligationId,
      );
      const existingId =
        this.privateMaterials.get(material.privateMaterialId) ??
        this.privateMaterials.get(
          this.privateMaterialObligationIndex.get(obligationKey) ?? "",
        );
      if (existingId) {
        return JSON.stringify(existingId) === JSON.stringify(material)
          ? InvestigationPrivateMaterialPersistenceStatus.Idempotent
          : InvestigationPrivateMaterialPersistenceStatus.Conflict;
      }
      const stored = clone(material)!;
      this.privateMaterials.set(stored.privateMaterialId, stored);
      this.privateMaterialObligationIndex.set(
        obligationKey,
        stored.privateMaterialId,
      );
      return InvestigationPrivateMaterialPersistenceStatus.Created;
    });
  }

  async findActivePrivateMaterial(input: {
    readonly investigationId: string;
    readonly obligationId: string | null;
    readonly activeAfter: string;
  }): Promise<EncryptedInvestigationPrivateMaterial | null> {
    await this.transactionTail;
    const privateMaterialId = this.privateMaterialObligationIndex.get(
      privateMaterialObligationKey(input.investigationId, input.obligationId),
    );
    const material = privateMaterialId
      ? this.privateMaterials.get(privateMaterialId)
      : undefined;
    return material && material.expiresAt > input.activeAfter
      ? clone(material)
      : null;
  }

  exportSnapshot(): string {
    return JSON.stringify({
      investigations: [...this.investigations.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      naturalIdentityIndex: [...this.naturalIdentityIndex.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      commands: [...this.commands.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      privateMaterials: [...this.privateMaterials.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      leases: [...this.leases.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, lease]) => [key, serializeLease(lease)]),
      nextLeaseFencingToken: this.nextLeaseFencingToken.toString(10),
    });
  }

  static fromSnapshot(snapshot: string): InMemoryInvestigationStore {
    const parsed = JSON.parse(snapshot) as {
      investigations: [string, ReviewInvestigation][];
      naturalIdentityIndex: [string, string][];
      commands: [string, StoredCommand][];
      privateMaterials?: [string, EncryptedInvestigationPrivateMaterial][];
      leases?: [string, SerializedInvestigationLease][];
      nextLeaseFencingToken?: string;
    };
    const store = new InMemoryInvestigationStore();
    for (const [key, value] of parsed.investigations) {
      assertPersistedInvestigationRequirementsSanitized(value);
      store.investigations.set(key, clone(value)!);
    }
    for (const [key, value] of parsed.naturalIdentityIndex) {
      store.naturalIdentityIndex.set(key, value);
    }
    for (const [key, value] of parsed.commands) {
      store.commands.set(key, { ...value });
    }
    for (const [key, value] of parsed.privateMaterials ?? []) {
      const material = createEncryptedInvestigationPrivateMaterial(value);
      store.privateMaterials.set(key, clone(material)!);
      store.privateMaterialObligationIndex.set(
        privateMaterialObligationKey(
          material.investigationId,
          material.obligationId,
        ),
        key,
      );
    }
    for (const [key, value] of parsed.leases ?? []) {
      store.leases.set(key, deserializeLease(value));
    }
    store.nextLeaseFencingToken = BigInt(parsed.nextLeaseFencingToken ?? "1");
    return store;
  }

  private async atomic<T>(operation: () => T): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

function resultAdmissionDeadlineIsCurrent(
  guard: NonNullable<Parameters<InvestigationStorePort["commit"]>[0]["guard"]>,
  lease: ReviewInvestigationLease,
  investigation: ReviewInvestigation,
): boolean {
  const values = [
    guard.resultAdmission,
    guard.admittedAt,
    guard.effectiveDeadline,
  ];
  if (values.every((value) => value === undefined)) return true;
  if (values.some((value) => value === undefined)) return false;
  const admittedAt = Date.parse(guard.admittedAt!);
  const effectiveDeadline = Date.parse(guard.effectiveDeadline!);
  return (
    Number.isFinite(admittedAt) &&
    Number.isFinite(effectiveDeadline) &&
    admittedAt < effectiveDeadline &&
    effectiveDeadline <= Date.parse(lease.resultReportUntil) &&
    investigation.activeTurn !== null &&
    effectiveDeadline <= Date.parse(investigation.activeTurn.expiresAt)
  );
}

type SerializedInvestigationLease = Omit<
  ReviewInvestigationLease,
  "mutationEpoch" | "fencingToken"
> & {
  mutationEpoch: string;
  fencingToken: string;
};

function serializeLease(
  lease: ReviewInvestigationLease,
): SerializedInvestigationLease {
  return {
    ...lease,
    mutationEpoch: lease.mutationEpoch.toString(10),
    fencingToken: lease.fencingToken.toString(10),
  };
}

function deserializeLease(
  lease: SerializedInvestigationLease,
): ReviewInvestigationLease {
  const deserialized: ReviewInvestigationLease = Object.freeze({
    ...lease,
    mutationEpoch: BigInt(lease.mutationEpoch),
    fencingToken: BigInt(lease.fencingToken),
  });
  assertReviewInvestigationLease(deserialized);
  return deserialized;
}

function cloneLease<T extends ReviewInvestigationLease | null>(lease: T): T {
  return lease === null
    ? lease
    : (deserializeLease(serializeLease(lease)) as T);
}

function leaseAcquireResult(
  status: InvestigationLeaseAcquireStatus,
  lease: ReviewInvestigationLease | null,
): InvestigationLeaseAcquireResult {
  return Object.freeze({ status, lease: cloneLease(lease) });
}

function privateMaterialObligationKey(
  investigationId: string,
  obligationId: string | null,
): string {
  return `${investigationId}\0${obligationId ?? "__global__"}`;
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
