import {
  InvestigationStoreCommitStatus,
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

type StoredCommand = Readonly<{
  commandHash: string;
  investigationId: string;
}>;

export class InMemoryInvestigationStore
  implements InvestigationStorePort, InvestigationPrivateMaterialStorePort
{
  private readonly investigations = new Map<string, ReviewInvestigation>();
  private readonly naturalIdentityIndex = new Map<string, string>();
  private readonly commands = new Map<string, StoredCommand>();
  private readonly privateMaterials = new Map<
    string,
    EncryptedInvestigationPrivateMaterial
  >();
  private readonly privateMaterialObligationIndex = new Map<string, string>();
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
          item.certificate !== null &&
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
          right.certificate!.issuedAt.localeCompare(
            left.certificate!.issuedAt,
          ) || left.investigationId.localeCompare(right.investigationId),
      )
      .slice(0, input.limit)
      .map((item) => clone(item));
  }

  async commit(input: {
    readonly investigation: ReviewInvestigation;
    readonly expectedVersion: number | null;
    readonly commandId: string;
    readonly commandHash: string;
    readonly transition: import("../../application/ports/investigation-store-port").InvestigationStoreTransition;
    readonly privateMaterials?: readonly EncryptedInvestigationPrivateMaterial[];
  }): Promise<InvestigationStoreCommitResult> {
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
    });
  }

  static fromSnapshot(snapshot: string): InMemoryInvestigationStore {
    const parsed = JSON.parse(snapshot) as {
      investigations: [string, ReviewInvestigation][];
      naturalIdentityIndex: [string, string][];
      commands: [string, StoredCommand][];
      privateMaterials?: [string, EncryptedInvestigationPrivateMaterial][];
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
