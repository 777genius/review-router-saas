import { createMemoryBodyHash, normalizeMemoryBody } from "./memory-body";
import type { MemoryActor } from "./memory-actor";
import { memoryActorRef } from "./memory-actor";
import { memoryError } from "./memory-errors";
import {
  assertValidMemoryScope,
  defaultMemoryVisibility,
  type MemoryScope,
} from "./memory-scope-policy";
import type { MemorySource } from "./memory-source";
import type { MemoryRiskLevel } from "./memory-safety-policy";

export type MemoryItemStatus = "active" | "disabled" | "expired" | "deleted";

export type MemoryIndexState =
  | "not_indexed"
  | "index_pending"
  | "indexed"
  | "index_failed"
  | "index_deleted";

export type MemoryItemVisibility =
  | "repository_runtime"
  | "workspace_runtime"
  | "user_preference_runtime";

export type MemoryItemSnapshot = {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly status: MemoryItemStatus;
  readonly body: string;
  readonly bodyVersion: number;
  readonly bodyHash: string;
  readonly tags: readonly string[];
  readonly riskLevel: MemoryRiskLevel;
  readonly confidence: number;
  readonly source: MemorySource;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly createdBy: string;
  readonly confirmedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly version: number;
  readonly visibility: MemoryItemVisibility;
  readonly originSuggestionId: string | null;
  readonly indexState: MemoryIndexState;
  readonly indexVersion: number | null;
};

export type CreateMemoryItemInput = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly riskLevel: MemoryRiskLevel;
  readonly confidence: number;
  readonly source: MemorySource;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly actor: MemoryActor;
  readonly now: Date;
  readonly originSuggestionId?: string | null;
};

export class MemoryItem {
  private constructor(private readonly value: MemoryItemSnapshot) {}

  static create(input: CreateMemoryItemInput): MemoryItem {
    assertValidMemoryScope(input);
    const body = normalizeMemoryBody(input.body);
    if (body.length === 0) {
      throw memoryError("memory_input_invalid");
    }
    return new MemoryItem({
      id: input.id,
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      scope: input.scope,
      status: "active",
      body,
      bodyVersion: 1,
      bodyHash: createMemoryBodyHash(body),
      tags: input.tags ?? [],
      riskLevel: input.riskLevel,
      confidence: clampConfidence(input.confidence),
      source: input.source,
      policyVersion: input.policyVersion,
      safetyPolicyVersion: input.safetyPolicyVersion,
      createdBy: memoryActorRef(input.actor),
      confirmedBy: memoryActorRef(input.actor),
      createdAt: input.now,
      updatedAt: input.now,
      lastUsedAt: null,
      expiresAt: null,
      version: 1,
      visibility: defaultMemoryVisibility(input.scope),
      originSuggestionId: input.originSuggestionId ?? null,
      indexState: "index_pending",
      indexVersion: null,
    });
  }

  static fromSnapshot(snapshot: MemoryItemSnapshot): MemoryItem {
    return new MemoryItem(snapshot);
  }

  snapshot(): MemoryItemSnapshot {
    return this.value;
  }

  disable(input: {
    readonly actor: MemoryActor;
    readonly now: Date;
  }): MemoryItem {
    if (this.value.status === "deleted") {
      throw memoryError("memory_version_conflict");
    }
    void input.actor;
    return new MemoryItem({
      ...this.value,
      status: "disabled",
      updatedAt: input.now,
      version: this.value.version + 1,
      indexState: "index_deleted",
    });
  }

  delete(input: {
    readonly actor: MemoryActor;
    readonly now: Date;
  }): MemoryItem {
    if (this.value.status === "deleted") {
      throw memoryError("memory_version_conflict");
    }
    void input.actor;
    return new MemoryItem({
      ...this.value,
      status: "deleted",
      updatedAt: input.now,
      version: this.value.version + 1,
      indexState: "index_deleted",
    });
  }
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
