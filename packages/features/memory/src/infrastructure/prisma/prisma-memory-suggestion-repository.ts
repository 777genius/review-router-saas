import type { Prisma } from "@prisma/client";
import type {
  MemorySuggestionDashboardRepositoryCursor,
  MemorySuggestionRepositoryPort,
} from "../../application/ports/memory-suggestion-repository-port";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type {
  MemorySuggestion,
  MemorySuggestionSnapshot,
  MemorySuggestionStatus,
} from "../../domain/memory-suggestion";
import { memoryError } from "../../domain/memory-errors";
import {
  isPrismaUniqueConstraintError,
  type MemoryPrismaClient,
  toMemorySuggestionSnapshot,
  toPrismaJson,
} from "./prisma-memory-mappers";

export class PrismaMemorySuggestionRepository implements MemorySuggestionRepositoryPort {
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async save(suggestion: MemorySuggestion): Promise<void> {
    const snapshot = suggestion.snapshot();
    try {
      await this.prisma.memorySuggestion.upsert({
        where: { id: snapshot.id },
        create: toMemorySuggestionCreateInput(snapshot),
        update: toMemorySuggestionUpdateInput(snapshot),
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw memoryError("memory_duplicate");
      }
      throw error;
    }
  }

  async findById(input: {
    readonly workspaceId: string;
    readonly suggestionId: string;
  }): Promise<MemorySuggestionSnapshot | null> {
    const record = await this.prisma.memorySuggestion.findFirst({
      where: {
        id: input.suggestionId,
        workspaceId: input.workspaceId,
      },
    });
    return record ? toMemorySuggestionSnapshot(record) : null;
  }

  async findPendingByDedupeKey(input: {
    readonly workspaceId: string;
    readonly dedupeKey: string;
  }): Promise<MemorySuggestionSnapshot | null> {
    const record = await this.prisma.memorySuggestion.findFirst({
      where: {
        workspaceId: input.workspaceId,
        dedupeKey: input.dedupeKey,
        status: "pending",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return record ? toMemorySuggestionSnapshot(record) : null;
  }

  async listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemorySuggestionStatus[];
    readonly limit: number;
    readonly cursor?: MemorySuggestionDashboardRepositoryCursor;
    readonly notExpiredAt?: Date;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    const record = await this.prisma.memorySuggestion.findMany({
      where: toDashboardWhere(input),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: input.limit,
    });
    return record.map(toMemorySuggestionSnapshot);
  }

  async listExpiredPending(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    const record = await this.prisma.memorySuggestion.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: "pending",
        expiresAt: { lte: input.expiredAtOrBefore },
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: input.limit,
    });
    return record.map(toMemorySuggestionSnapshot);
  }
}

function toDashboardWhere(input: {
  readonly workspaceId: string;
  readonly repositoryId?: string | null;
  readonly scope?: MemoryScope;
  readonly statuses: readonly MemorySuggestionStatus[];
  readonly cursor?: MemorySuggestionDashboardRepositoryCursor;
  readonly notExpiredAt?: Date;
}): Prisma.MemorySuggestionWhereInput {
  return {
    workspaceId: input.workspaceId,
    ...(input.repositoryId !== undefined
      ? { repositoryId: input.repositoryId }
      : {}),
    ...(input.scope ? { suggestedScope: input.scope } : {}),
    status: { in: [...input.statuses] },
    ...(input.notExpiredAt ? { expiresAt: { gt: input.notExpiredAt } } : {}),
    ...(input.cursor
      ? {
          OR: [
            { updatedAt: { lt: input.cursor.updatedAt } },
            {
              updatedAt: input.cursor.updatedAt,
              id: { gt: input.cursor.id },
            },
          ],
        }
      : {}),
  };
}

function toMemorySuggestionCreateInput(
  suggestion: MemorySuggestionSnapshot,
): Prisma.MemorySuggestionUncheckedCreateInput {
  return {
    id: suggestion.id,
    schemaVersion: suggestion.schemaVersion,
    workspaceId: suggestion.workspaceId,
    repositoryId: suggestion.repositoryId,
    userId: suggestion.userId,
    suggestedScope: suggestion.suggestedScope,
    suggestedBody: suggestion.suggestedBody,
    suggestedBodyVersion: suggestion.suggestedBodyVersion,
    suggestedBodyHash: suggestion.suggestedBodyHash,
    reason: suggestion.reason,
    source: toPrismaJson(suggestion.source),
    safetyReport: toPrismaJson(suggestion.safetyReport),
    policyVersion: suggestion.policyVersion,
    safetyPolicyVersion: suggestion.safetyPolicyVersion,
    status: suggestion.status,
    createdByActor: suggestion.createdByActor,
    expiresAt: suggestion.expiresAt,
    dedupeKey: suggestion.dedupeKey,
    relatedMemoryItemId: suggestion.relatedMemoryItemId,
    relatedSuggestionId: suggestion.relatedSuggestionId,
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
    resolvedAt: suggestion.resolvedAt,
    resolvedBy: suggestion.resolvedBy,
    resolutionReason: suggestion.resolutionReason,
    version: suggestion.version,
  };
}

function toMemorySuggestionUpdateInput(
  suggestion: MemorySuggestionSnapshot,
): Prisma.MemorySuggestionUncheckedUpdateInput {
  return toMemorySuggestionCreateInput(suggestion);
}
