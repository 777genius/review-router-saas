import {
  InvestigationStoreCommitStatus,
  type InvestigationStoreCommitResult,
  type InvestigationStorePort,
} from "../../application/ports/investigation-store-port";
import type { ReviewInvestigation } from "../../domain/review-investigation";

type StoredCommand = Readonly<{
  commandHash: string;
  investigationId: string;
}>;

export class InMemoryInvestigationStore implements InvestigationStorePort {
  private readonly investigations = new Map<string, ReviewInvestigation>();
  private readonly naturalIdentityIndex = new Map<string, string>();
  private readonly commands = new Map<string, StoredCommand>();
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

  async commit(input: {
    readonly investigation: ReviewInvestigation;
    readonly expectedVersion: number | null;
    readonly commandId: string;
    readonly commandHash: string;
    readonly transition: import("../../application/ports/investigation-store-port").InvestigationStoreTransition;
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
      const existing = this.investigations.get(input.investigation.investigationId);
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
      return {
        status: InvestigationStoreCommitStatus.Committed,
        investigation: clone(stored),
      };
    });
  }

  exportSnapshot(): string {
    return JSON.stringify({
      investigations: [...this.investigations.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      naturalIdentityIndex: [...this.naturalIdentityIndex.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      commands: [...this.commands.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    });
  }

  static fromSnapshot(snapshot: string): InMemoryInvestigationStore {
    const parsed = JSON.parse(snapshot) as {
      investigations: [string, ReviewInvestigation][];
      naturalIdentityIndex: [string, string][];
      commands: [string, StoredCommand][];
    };
    const store = new InMemoryInvestigationStore();
    for (const [key, value] of parsed.investigations) {
      store.investigations.set(key, clone(value)!);
    }
    for (const [key, value] of parsed.naturalIdentityIndex) {
      store.naturalIdentityIndex.set(key, value);
    }
    for (const [key, value] of parsed.commands) {
      store.commands.set(key, { ...value });
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

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
