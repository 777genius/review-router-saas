import type { Prisma } from "@prisma/client";
import type {
  MarkActiveMemoryItemsUsedInput,
  MarkActiveMemoryItemsUsedResult,
  MemoryDashboardRepositoryCursor,
  MemoryItemRepositoryPort,
} from "../../application/ports/memory-item-repository-port";
import type {
  MemoryItem,
  MemoryItemSnapshot,
  MemoryItemStatus,
} from "../../domain/memory-item";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import { memoryError } from "../../domain/memory-errors";
import {
  isPrismaUniqueConstraintError,
  type MemoryPrismaClient,
  toMemoryItemSnapshot,
  toPrismaJson,
} from "./prisma-memory-mappers";

export class PrismaMemoryItemRepository implements MemoryItemRepositoryPort {
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async save(
    item: MemoryItem,
    options?: {
      readonly expectedVersion?: number;
    },
  ): Promise<void> {
    const snapshot = item.snapshot();
    if (options?.expectedVersion !== undefined) {
      const result = await this.prisma.memoryItem.updateMany({
        where: {
          id: snapshot.id,
          workspaceId: snapshot.workspaceId,
          version: options.expectedVersion,
        },
        data: toMemoryItemUpdateInput(snapshot),
      });
      if (result.count !== 1) {
        throw memoryError("memory_version_conflict", true);
      }
      return;
    }

    try {
      await this.prisma.memoryItem.upsert({
        where: { id: snapshot.id },
        create: toMemoryItemCreateInput(snapshot),
        update: toMemoryItemUpdateInput(snapshot),
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
    readonly itemId: string;
  }): Promise<MemoryItemSnapshot | null> {
    const record = await this.prisma.memoryItem.findFirst({
      where: {
        id: input.itemId,
        workspaceId: input.workspaceId,
      },
    });
    return record ? toMemoryItemSnapshot(record) : null;
  }

  async findActiveByBodyHash(input: {
    readonly workspaceId: string;
    readonly scope: MemoryScope;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly bodyHash: string;
  }): Promise<MemoryItemSnapshot | null> {
    const record = await this.prisma.memoryItem.findFirst({
      where: {
        workspaceId: input.workspaceId,
        scope: input.scope,
        repositoryId: input.repositoryId,
        userId: input.userId,
        bodyHash: input.bodyHash,
        status: { in: ["active", "disabled"] },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    return record ? toMemoryItemSnapshot(record) : null;
  }

  async listActiveForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    const record = await this.prisma.memoryItem.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: "active",
        OR: [
          { scope: "workspace", repositoryId: null, userId: null },
          {
            scope: "repository",
            repositoryId: input.repositoryId,
            userId: null,
          },
          ...(input.userId
            ? [
                {
                  scope: "user_prefs" as const,
                  repositoryId: null,
                  userId: input.userId,
                },
              ]
            : []),
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: input.limit,
    });
    return record.map(toMemoryItemSnapshot);
  }

  async listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemoryItemStatus[];
    readonly limit: number;
    readonly cursor?: MemoryDashboardRepositoryCursor;
  }): Promise<readonly MemoryItemSnapshot[]> {
    const record = await this.prisma.memoryItem.findMany({
      where: toDashboardWhere(input),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: input.limit,
    });
    return record.map(toMemoryItemSnapshot);
  }

  async markActiveItemsUsed(
    input: MarkActiveMemoryItemsUsedInput,
  ): Promise<MarkActiveMemoryItemsUsedResult> {
    const itemIds = [...new Set(input.itemIds)];
    if (itemIds.length === 0) {
      return { updatedCount: 0 };
    }

    const result = await this.prisma.memoryItem.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: itemIds },
        status: "active",
      },
      data: {
        lastUsedAt: input.usedAt,
      },
    });
    return { updatedCount: result.count };
  }
}

function toDashboardWhere(input: {
  readonly workspaceId: string;
  readonly repositoryId?: string | null;
  readonly scope?: MemoryScope;
  readonly statuses: readonly MemoryItemStatus[];
  readonly cursor?: MemoryDashboardRepositoryCursor;
}): Prisma.MemoryItemWhereInput {
  return {
    workspaceId: input.workspaceId,
    ...(input.repositoryId !== undefined
      ? { repositoryId: input.repositoryId }
      : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    status: { in: [...input.statuses] },
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

function toMemoryItemCreateInput(
  item: MemoryItemSnapshot,
): Prisma.MemoryItemUncheckedCreateInput {
  return {
    id: item.id,
    schemaVersion: item.schemaVersion,
    workspaceId: item.workspaceId,
    repositoryId: item.repositoryId,
    userId: item.userId,
    scope: item.scope,
    status: item.status,
    body: item.body,
    bodyVersion: item.bodyVersion,
    bodyHash: item.bodyHash,
    tags: toPrismaJson(item.tags),
    riskLevel: item.riskLevel,
    confidence: item.confidence,
    source: toPrismaJson(item.source),
    policyVersion: item.policyVersion,
    safetyPolicyVersion: item.safetyPolicyVersion,
    createdBy: item.createdBy,
    confirmedBy: item.confirmedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastUsedAt: item.lastUsedAt,
    expiresAt: item.expiresAt,
    version: item.version,
    visibility: item.visibility,
    originSuggestionId: item.originSuggestionId,
    indexState: item.indexState,
    indexVersion: item.indexVersion,
  };
}

function toMemoryItemUpdateInput(
  item: MemoryItemSnapshot,
): Prisma.MemoryItemUncheckedUpdateInput {
  return toMemoryItemCreateInput(item);
}
