import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  MemoryItemSnapshot,
  MemoryItemStatus,
  MemoryIndexState,
  MemoryItemVisibility,
} from "../../domain/memory-item";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type {
  MemoryRiskLevel,
  MemorySafetyReport,
} from "../../domain/memory-safety-policy";
import type { MemorySource } from "../../domain/memory-source";
import type {
  MemorySuggestionSnapshot,
  MemorySuggestionStatus,
} from "../../domain/memory-suggestion";

export type MemoryPrismaClient = Pick<
  PrismaClient,
  | "memoryItem"
  | "memorySuggestion"
  | "memoryUsageEvent"
  | "auditEvent"
  | "outboxEvent"
>;

export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}

export function toMemoryItemSnapshot(record: {
  readonly id: string;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: string;
  readonly status: string;
  readonly body: string;
  readonly bodyVersion: number;
  readonly bodyHash: string;
  readonly tags: unknown;
  readonly riskLevel: string;
  readonly confidence: number;
  readonly source: unknown;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly createdBy: string;
  readonly confirmedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly version: number;
  readonly visibility: string;
  readonly originSuggestionId: string | null;
  readonly indexState: string;
  readonly indexVersion: number | null;
}): MemoryItemSnapshot {
  return {
    id: record.id,
    schemaVersion: 1,
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    userId: record.userId,
    scope: record.scope as MemoryScope,
    status: record.status as MemoryItemStatus,
    body: record.body,
    bodyVersion: record.bodyVersion,
    bodyHash: record.bodyHash,
    tags: toStringArray(record.tags),
    riskLevel: record.riskLevel as MemoryRiskLevel,
    confidence: record.confidence,
    source: record.source as MemorySource,
    policyVersion: record.policyVersion,
    safetyPolicyVersion: record.safetyPolicyVersion,
    createdBy: record.createdBy,
    confirmedBy: record.confirmedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    version: record.version,
    visibility: record.visibility as MemoryItemVisibility,
    originSuggestionId: record.originSuggestionId,
    indexState: record.indexState as MemoryIndexState,
    indexVersion: record.indexVersion,
  };
}

export function toMemorySuggestionSnapshot(record: {
  readonly id: string;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly suggestedScope: string;
  readonly suggestedBody: string;
  readonly suggestedBodyVersion: number;
  readonly suggestedBodyHash: string;
  readonly reason: string;
  readonly source: unknown;
  readonly safetyReport: unknown;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly status: string;
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
}): MemorySuggestionSnapshot {
  return {
    id: record.id,
    schemaVersion: 1,
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    userId: record.userId,
    suggestedScope: record.suggestedScope as MemoryScope,
    suggestedBody: record.suggestedBody,
    suggestedBodyVersion: record.suggestedBodyVersion,
    suggestedBodyHash: record.suggestedBodyHash,
    reason: record.reason,
    source: record.source as MemorySource,
    safetyReport: record.safetyReport as MemorySafetyReport,
    policyVersion: record.policyVersion,
    safetyPolicyVersion: record.safetyPolicyVersion,
    status: record.status as MemorySuggestionStatus,
    createdByActor: record.createdByActor,
    expiresAt: record.expiresAt,
    dedupeKey: record.dedupeKey,
    relatedMemoryItemId: record.relatedMemoryItemId,
    relatedSuggestionId: record.relatedSuggestionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt,
    resolvedBy: record.resolvedBy,
    resolutionReason: record.resolutionReason,
    version: record.version,
  };
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
