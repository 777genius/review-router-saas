import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { HostedCodexMutationFencePort } from "../runtime/hosted-codex-session-runtime";

export class PrismaHostedCodexMutationFence implements HostedCodexMutationFencePort {
  constructor(private readonly prisma: PrismaClient) {}

  async acquire(input: {
    readonly accountId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly ttlMs: number;
    readonly restoredGenerationHash: string;
  }) {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000) {
      return { status: "denied" as const, safeMessage: "Invalid fence TTL." };
    }
    const account = await this.prisma.hostedCodexAccount.findUnique({
      where: { id: input.accountId },
    });
    if (!account?.activeGeneration) {
      return { status: "denied" as const, safeMessage: "Account unavailable." };
    }
    const leaseId = `${input.accountId}.${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    try {
      await this.prisma.$transaction(
        async (transaction) => {
          const current = await transaction.hostedCodexMutationFence.findUnique(
            {
              where: { accountId: input.accountId },
            },
          );
          if (current && current.expiresAt > now) {
            throw new Error("hosted_codex_mutation_fence_busy");
          }
          await transaction.hostedCodexMutationFence.upsert({
            where: { accountId: input.accountId },
            create: {
              accountId: input.accountId,
              workspaceId: account.workspaceId,
              poolId: account.poolId,
              fenceEpoch: 1n,
              ownerIdHash: sha256(leaseId),
              expectedGeneration: account.activeGeneration!,
              expiresAt,
            },
            update: {
              fenceEpoch: { increment: 1 },
              ownerIdHash: sha256(leaseId),
              expectedGeneration: account.activeGeneration!,
              expiresAt,
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "hosted_codex_mutation_fence_busy"
      ) {
        return {
          status: "denied" as const,
          safeMessage: "Account is refreshing.",
        };
      }
      throw error;
    }
    return { status: "granted" as const, leaseId, expiresAt };
  }

  async finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }) {
    await this.requireLiveFence(input.leaseId);
    return input;
  }

  async markWritebackStarted(input: { readonly leaseId: string }) {
    await this.requireLiveFence(input.leaseId);
  }

  async markWritebackCommitted(input: {
    readonly leaseId: string;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
  }) {
    const accountId = accountIdFromLease(input.leaseId);
    const deleted = await this.prisma.hostedCodexMutationFence.deleteMany({
      where: {
        accountId,
        ownerIdHash: sha256(input.leaseId),
        expiresAt: { gt: new Date() },
      },
    });
    if (deleted.count !== 1) {
      throw new Error("hosted_codex_mutation_fence_invalid");
    }
    return { status: "committed" as const };
  }

  async release(input: { readonly leaseId: string; readonly reason: string }) {
    const accountId = accountIdFromLease(input.leaseId);
    await this.prisma.hostedCodexMutationFence.deleteMany({
      where: { accountId, ownerIdHash: sha256(input.leaseId) },
    });
  }

  private async requireLiveFence(leaseId: string) {
    const fence = await this.prisma.hostedCodexMutationFence.findUnique({
      where: { accountId: accountIdFromLease(leaseId) },
    });
    if (
      !fence ||
      fence.ownerIdHash !== sha256(leaseId) ||
      fence.expiresAt <= new Date()
    ) {
      throw new Error("hosted_codex_mutation_fence_invalid");
    }
    return fence;
  }
}

function accountIdFromLease(leaseId: string): string {
  const separator = leaseId.indexOf(".");
  if (separator < 1 || separator > 160) {
    throw new Error("hosted_codex_mutation_lease_invalid");
  }
  return leaseId.slice(0, separator);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
