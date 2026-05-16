import {
  createMemoryBodyHash,
  deletedMemoryBodyPlaceholder,
  normalizeMemoryBody,
} from "./memory-body";
import type { MemoryActor } from "./memory-actor";
import { memoryActorRef } from "./memory-actor";
import { memoryError } from "./memory-errors";
import {
  assertValidMemoryScope,
  type MemoryScope,
} from "./memory-scope-policy";
import type { MemorySafetyReport } from "./memory-safety-policy";
import { createDeletedMemorySource, type MemorySource } from "./memory-source";

export type MemorySuggestionStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "blocked"
  | "expired"
  | "superseded";

export type MemorySuggestionSnapshot = {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly suggestedScope: MemoryScope;
  readonly suggestedBody: string;
  readonly suggestedBodyVersion: number;
  readonly suggestedBodyHash: string;
  readonly reason: string;
  readonly source: MemorySource;
  readonly safetyReport: MemorySafetyReport;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly status: MemorySuggestionStatus;
  readonly createdByActor: string;
  readonly expiresAt: Date;
  readonly dedupeKey: string;
  readonly relatedMemoryItemId: string | null;
  readonly relatedSuggestionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
  readonly version: number;
};

export type CreateMemorySuggestionInput = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly suggestedScope: MemoryScope;
  readonly suggestedBody: string;
  readonly reason: string;
  readonly source: MemorySource;
  readonly safetyReport: MemorySafetyReport;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly actor: MemoryActor;
  readonly expiresAt: Date;
  readonly dedupeKey: string;
  readonly now: Date;
};

export class MemorySuggestion {
  private constructor(private readonly value: MemorySuggestionSnapshot) {}

  static createPending(input: CreateMemorySuggestionInput): MemorySuggestion {
    assertValidMemoryScope({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      scope: input.suggestedScope,
    });
    const body = normalizeMemoryBody(input.suggestedBody);
    if (body.length === 0) {
      throw memoryError("memory_input_invalid");
    }
    return new MemorySuggestion({
      ...baseSuggestion(input, body),
      status: "pending",
      relatedMemoryItemId: null,
      relatedSuggestionId: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    });
  }

  static createBlocked(input: CreateMemorySuggestionInput): MemorySuggestion {
    const safeBody = normalizeMemoryBody(input.safetyReport.redactedBody);
    return new MemorySuggestion({
      ...baseSuggestion(input, safeBody),
      status: "blocked",
      relatedMemoryItemId: null,
      relatedSuggestionId: null,
      resolvedAt: input.now,
      resolvedBy: "system:safety",
      resolutionReason: input.safetyReport.blockedReason ?? "blocked",
    });
  }

  static fromSnapshot(snapshot: MemorySuggestionSnapshot): MemorySuggestion {
    return new MemorySuggestion(snapshot);
  }

  snapshot(): MemorySuggestionSnapshot {
    return this.value;
  }

  confirm(input: {
    readonly actor: MemoryActor;
    readonly memoryItemId: string;
    readonly now: Date;
  }): MemorySuggestion {
    this.assertPending(input.now);
    return new MemorySuggestion({
      ...this.value,
      status: "confirmed",
      relatedMemoryItemId: input.memoryItemId,
      resolvedAt: input.now,
      resolvedBy: memoryActorRef(input.actor),
      resolutionReason: "confirmed",
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  reject(input: {
    readonly actor: MemoryActor;
    readonly reason: string;
    readonly now: Date;
  }): MemorySuggestion {
    this.assertPending(input.now);
    return new MemorySuggestion({
      ...this.value,
      status: "rejected",
      resolvedAt: input.now,
      resolvedBy: memoryActorRef(input.actor),
      resolutionReason: input.reason.slice(0, 500),
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  supersede(input: {
    readonly actor: MemoryActor;
    readonly replacementSuggestionId: string;
    readonly now: Date;
  }): MemorySuggestion {
    if (this.value.status !== "pending") {
      throw memoryError("memory_version_conflict");
    }
    return new MemorySuggestion({
      ...this.value,
      status: "superseded",
      relatedSuggestionId: input.replacementSuggestionId,
      resolvedAt: input.now,
      resolvedBy: memoryActorRef(input.actor),
      resolutionReason: "superseded",
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  expire(input: { readonly now: Date }): MemorySuggestion {
    if (this.value.status !== "pending") {
      throw memoryError("memory_version_conflict");
    }
    if (this.value.expiresAt > input.now) {
      throw memoryError("memory_version_conflict");
    }
    return new MemorySuggestion({
      ...this.value,
      status: "expired",
      resolvedAt: input.now,
      resolvedBy: "system:memory-retention",
      resolutionReason: "expired",
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  redactAfterMemoryDeletion(input: {
    readonly memoryItemId: string;
    readonly now: Date;
  }): MemorySuggestion {
    if (
      this.value.status !== "confirmed" ||
      this.value.relatedMemoryItemId !== input.memoryItemId
    ) {
      return this;
    }
    return new MemorySuggestion({
      ...this.value,
      suggestedBody: deletedMemoryBodyPlaceholder,
      suggestedBodyVersion: this.value.suggestedBodyVersion + 1,
      suggestedBodyHash: createMemoryBodyHash(deletedMemoryBodyPlaceholder),
      source: createDeletedMemorySource(),
      safetyReport: {
        ...this.value.safetyReport,
        redactedBody: deletedMemoryBodyPlaceholder,
        redactedSourceExcerpt: null,
        mayEmbed: false,
        mayUseInRuntimeBundle: false,
      },
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  private assertPending(now: Date): void {
    if (this.value.status !== "pending") {
      throw memoryError("memory_version_conflict");
    }
    if (this.value.expiresAt <= now) {
      throw memoryError("memory_version_conflict");
    }
  }
}

function baseSuggestion(
  input: CreateMemorySuggestionInput,
  body: string,
): Omit<
  MemorySuggestionSnapshot,
  | "status"
  | "relatedMemoryItemId"
  | "relatedSuggestionId"
  | "resolvedAt"
  | "resolvedBy"
  | "resolutionReason"
> {
  return {
    id: input.id,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    userId: input.userId,
    suggestedScope: input.suggestedScope,
    suggestedBody: body,
    suggestedBodyVersion: 1,
    suggestedBodyHash: createMemoryBodyHash(body),
    reason: input.reason,
    source: input.source,
    safetyReport: input.safetyReport,
    policyVersion: input.policyVersion,
    safetyPolicyVersion: input.safetyPolicyVersion,
    createdByActor: memoryActorRef(input.actor),
    expiresAt: input.expiresAt,
    dedupeKey: input.dedupeKey,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}
