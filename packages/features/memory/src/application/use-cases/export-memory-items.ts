import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { MemoryActor } from "../../domain/memory-actor";
import { memoryActorRef } from "../../domain/memory-actor";
import { memoryError } from "../../domain/memory-errors";
import type { MemoryItemSnapshot } from "../../domain/memory-item";
import type { MemorySource } from "../../domain/memory-source";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

const MEMORY_EXPORT_SCHEMA_VERSION = 1;

export type ExportMemoryItemsInput = {
  readonly workspaceId: string;
  readonly actor: MemoryActor;
  readonly limit?: number;
  readonly maxBytes?: number;
};

export type MemoryExportSourceDto = {
  readonly type: MemorySource["type"];
  readonly sourceId: string;
  readonly githubCommentId: string | null;
  readonly githubPullRequestNumber: number | null;
  readonly githubRepositoryId: string | null;
  readonly url: string | null;
  readonly actorLogin: string | null;
  readonly sourceVisibility: MemorySource["sourceVisibility"];
};

export type MemoryExportItemDto = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly status: Exclude<MemoryItemSnapshot["status"], "deleted">;
  readonly body: string;
  readonly bodyHash: string;
  readonly bodyVersion: number;
  readonly tags: readonly string[];
  readonly riskLevel: MemoryItemSnapshot["riskLevel"];
  readonly confidence: number;
  readonly visibility: MemoryItemSnapshot["visibility"];
  readonly source: MemoryExportSourceDto;
  readonly createdBy: string;
  readonly confirmedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
};

export type MemoryExportManifestDto = {
  readonly schemaVersion: typeof MEMORY_EXPORT_SCHEMA_VERSION;
  readonly exportId: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly policyVersion: number;
  readonly itemCount: number;
  readonly excludedDeletedCount: number;
  readonly truncatedCount: number;
  readonly checksumSha256: string;
  readonly format: "json";
};

export type MemoryExportDto = {
  readonly manifest: MemoryExportManifestDto;
  readonly items: readonly MemoryExportItemDto[];
};

export type ExportMemoryItemsResult =
  | {
      readonly status: "exported";
      readonly export: MemoryExportDto;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly retryable: boolean;
    };

export async function exportMemoryItems(
  input: ExportMemoryItemsInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    | "clock"
    | "memoryItems"
    | "memoryPermissions"
    | "memoryPolicyConfig"
    | "memoryTransaction"
  >,
): Promise<ExportMemoryItemsResult> {
  assertValidWorkspaceId(input.workspaceId);
  const policy = await dependencies.memoryPolicyConfig.getPolicy({
    workspaceId: input.workspaceId,
    repositoryId: null,
  });
  if (!policy.memoryEnabled) {
    return { status: "rejected", reason: "memory_disabled", retryable: false };
  }
  const limit = normalizeExportLimit(input.limit, policy.export);
  const maxBytes = normalizeExportMaxBytes(input.maxBytes, policy.export);

  const permission = await dependencies.memoryPermissions.canConfirmMemory({
    workspaceId: input.workspaceId,
    repositoryId: null,
    userId: null,
    scope: "workspace",
    actor: input.actor,
  });
  if (!permission.allowed) {
    return {
      status: "rejected",
      reason: permission.reason,
      retryable: permission.retryable,
    };
  }

  const records = await dependencies.memoryItems.listForExport({
    workspaceId: input.workspaceId,
    statuses: ["active", "disabled", "expired"],
    limit,
  });
  const truncatedCount = Math.max(
    0,
    records.totalMatchingCount - records.items.length,
  );
  if (truncatedCount > 0) {
    return {
      status: "rejected",
      reason: "memory_export_too_large",
      retryable: false,
    };
  }
  const items = records.items.map(toMemoryExportItem);
  const createdAt = dependencies.clock.now();
  const checksumSha256 = checksumExportItems(items);
  const exportId = [
    "memory_export",
    input.workspaceId,
    createdAt.toISOString().replace(/[^0-9A-Za-z]/g, ""),
  ].join(":");
  const exportDto: MemoryExportDto = {
    manifest: {
      schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
      exportId,
      workspaceId: input.workspaceId,
      createdBy: memoryActorRef(input.actor),
      createdAt: createdAt.toISOString(),
      policyVersion: policy.policyVersion,
      itemCount: items.length,
      excludedDeletedCount: records.excludedDeletedCount,
      truncatedCount,
      checksumSha256,
      format: "json",
    },
    items,
  };
  if (memoryExportByteLength(exportDto) > maxBytes) {
    return {
      status: "rejected",
      reason: "memory_export_too_large",
      retryable: false,
    };
  }

  await dependencies.memoryTransaction.run(async (tx) => {
    await tx.memoryAudit.record({
      workspaceId: input.workspaceId,
      actor: memoryActorRef(input.actor),
      action: "memory.export.created",
      targetType: "memory_export",
      targetId: exportId,
      metadata: {
        itemCount: exportDto.manifest.itemCount,
        excludedDeletedCount: exportDto.manifest.excludedDeletedCount,
        truncatedCount: exportDto.manifest.truncatedCount,
        checksumSha256: exportDto.manifest.checksumSha256,
        format: exportDto.manifest.format,
      },
    });
  });

  return { status: "exported", export: exportDto };
}

export function stringifyMemoryExport(exportDto: MemoryExportDto): string {
  return JSON.stringify(exportDto, null, 2);
}

function toMemoryExportItem(snapshot: MemoryItemSnapshot): MemoryExportItemDto {
  if (snapshot.status === "deleted") {
    throw memoryError("memory_input_invalid");
  }

  return {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    repositoryId: snapshot.repositoryId,
    userId: snapshot.userId,
    scope: snapshot.scope,
    status: snapshot.status,
    body: snapshot.body,
    bodyHash: snapshot.bodyHash,
    bodyVersion: snapshot.bodyVersion,
    tags: snapshot.tags,
    riskLevel: snapshot.riskLevel,
    confidence: snapshot.confidence,
    visibility: snapshot.visibility,
    source: toSafeExportSource(snapshot.source),
    createdBy: snapshot.createdBy,
    confirmedBy: snapshot.confirmedBy,
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
    lastUsedAt: snapshot.lastUsedAt?.toISOString() ?? null,
    expiresAt: snapshot.expiresAt?.toISOString() ?? null,
    policyVersion: snapshot.policyVersion,
    safetyPolicyVersion: snapshot.safetyPolicyVersion,
  };
}

function toSafeExportSource(source: MemorySource): MemoryExportSourceDto {
  return {
    type: source.type,
    sourceId: source.sourceId,
    githubCommentId: source.githubCommentId,
    githubPullRequestNumber: source.githubPullRequestNumber,
    githubRepositoryId: source.githubRepositoryId,
    url: source.sourceVisibility === "private" ? null : source.url,
    actorLogin: source.actorLogin,
    sourceVisibility: source.sourceVisibility,
  };
}

function checksumExportItems(items: readonly MemoryExportItemDto[]): string {
  return createHash("sha256")
    .update(JSON.stringify(items), "utf8")
    .digest("hex");
}

function memoryExportByteLength(exportDto: MemoryExportDto): number {
  return Buffer.byteLength(stringifyMemoryExport(exportDto), "utf8");
}

function assertValidWorkspaceId(value: string): void {
  if (value.trim().length > 0) return;
  throw memoryError("memory_input_invalid");
}

function normalizeExportLimit(
  value: number | undefined,
  policy: { readonly defaultItemLimit: number; readonly maxItemLimit: number },
): number {
  if (value === undefined) return policy.defaultItemLimit;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw memoryError("memory_input_invalid");
  }
  return Math.min(value, policy.maxItemLimit);
}

function normalizeExportMaxBytes(
  value: number | undefined,
  policy: { readonly defaultMaxBytes: number; readonly maxBytes: number },
): number {
  if (value === undefined) return policy.defaultMaxBytes;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw memoryError("memory_input_invalid");
  }
  return Math.min(value, policy.maxBytes);
}
