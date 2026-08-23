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
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    let leaseId: string | undefined;
    try {
      await this.prisma.$transaction(
        async (transaction) => {
          const account = await transaction.hostedCodexAccount.findUnique({
            where: { id: input.accountId },
          });
          if (!account?.activeGeneration) {
            throw new Error("hosted_codex_mutation_account_unavailable");
          }
          const current = await transaction.hostedCodexMutationFence.findUnique(
            {
              where: { accountId: input.accountId },
            },
          );
          if (
            current?.ownerIdHash &&
            current.expiresAt &&
            current.expiresAt > now
          ) {
            throw new Error("hosted_codex_mutation_fence_busy");
          }
          const nextEpoch = (current?.fenceEpoch ?? 0n) + 1n;
          leaseId = encodeLeaseId(input.accountId, nextEpoch);
          const ownerIdHash = sha256(leaseId);
          if (!current) {
            await transaction.hostedCodexMutationFence.create({
              data: {
                accountId: input.accountId,
                workspaceId: account.workspaceId,
                poolId: account.poolId,
                fenceEpoch: nextEpoch,
                ownerIdHash,
                expectedGeneration: account.activeGeneration,
                expiresAt,
                releasedAt: null,
                releaseReason: null,
              },
            });
            return;
          }
          const takeover =
            await transaction.hostedCodexMutationFence.updateMany({
              where: {
                accountId: input.accountId,
                fenceEpoch: current.fenceEpoch,
                OR: [
                  { ownerIdHash: null, expiresAt: null },
                  { expiresAt: { lte: now } },
                ],
              },
              data: {
                fenceEpoch: nextEpoch,
                ownerIdHash,
                expectedGeneration: account.activeGeneration,
                expiresAt,
                releasedAt: null,
                releaseReason: null,
              },
            });
          if (takeover.count !== 1) {
            throw new Error("hosted_codex_mutation_fence_busy");
          }
        },
        { maxWait: 15_000, timeout: 15_000 },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "hosted_codex_mutation_fence_busy" ||
          error.message === "hosted_codex_mutation_account_unavailable")
      ) {
        return {
          status: "denied" as const,
          safeMessage:
            error.message === "hosted_codex_mutation_fence_busy"
              ? "Account is refreshing."
              : "Account unavailable.",
        };
      }
      if (isPrismaErrorCode(error, "P2002")) {
        return {
          status: "denied" as const,
          safeMessage: "Account is refreshing.",
        };
      }
      throw error;
    }
    if (!leaseId) throw new Error("hosted_codex_mutation_fence_unavailable");
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
    const authority = hostedCodexMutationLeaseAuthority(input.leaseId);
    const released = await this.prisma.hostedCodexMutationFence.updateMany({
      where: {
        accountId: authority.accountId,
        ownerIdHash: authority.ownerIdHash,
        fenceEpoch: authority.fenceEpoch,
        expiresAt: { gt: new Date() },
      },
      data: {
        ownerIdHash: null,
        expectedGeneration: null,
        expiresAt: null,
        releasedAt: new Date(),
        releaseReason: "writeback_committed",
      },
    });
    if (released.count !== 1) {
      throw new Error("hosted_codex_mutation_fence_invalid");
    }
    return { status: "committed" as const };
  }

  async release(input: { readonly leaseId: string; readonly reason: string }) {
    const authority = hostedCodexMutationLeaseAuthority(input.leaseId);
    const released = await this.prisma.hostedCodexMutationFence.updateMany({
      where: {
        accountId: authority.accountId,
        ownerIdHash: authority.ownerIdHash,
        fenceEpoch: authority.fenceEpoch,
      },
      data: {
        ownerIdHash: null,
        expectedGeneration: null,
        expiresAt: null,
        releasedAt: new Date(),
        releaseReason: input.reason.slice(0, 120),
      },
    });
    if (released.count !== 1) {
      throw new Error("hosted_codex_mutation_fence_invalid");
    }
  }

  private async requireLiveFence(leaseId: string) {
    const authority = hostedCodexMutationLeaseAuthority(leaseId);
    const fence = await this.prisma.hostedCodexMutationFence.findUnique({
      where: { accountId: authority.accountId },
    });
    if (
      !fence ||
      fence.ownerIdHash !== authority.ownerIdHash ||
      fence.fenceEpoch !== authority.fenceEpoch ||
      !fence.expiresAt ||
      fence.expiresAt <= new Date()
    ) {
      throw new Error("hosted_codex_mutation_fence_invalid");
    }
    return fence;
  }
}

function encodeLeaseId(accountId: string, fenceEpoch: bigint): string {
  if (!accountId || accountId.length > 160 || fenceEpoch < 1n) {
    throw new Error("hosted_codex_mutation_lease_invalid");
  }
  return [
    "hcmf1",
    Buffer.from(accountId, "utf8").toString("base64url"),
    fenceEpoch.toString(10),
    randomBytes(32).toString("base64url"),
  ].join(".");
}

function decodeLeaseId(leaseId: string): {
  readonly accountId: string;
  readonly fenceEpoch: bigint;
} {
  const parts = leaseId.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "hcmf1" ||
    !parts[1] ||
    !/^[1-9][0-9]*$/u.test(parts[2] ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/u.test(parts[3] ?? "")
  ) {
    throw new Error("hosted_codex_mutation_lease_invalid");
  }
  const accountId = Buffer.from(parts[1], "base64url").toString("utf8");
  const fenceEpoch = BigInt(parts[2]!);
  if (
    !accountId ||
    accountId.length > 160 ||
    Buffer.from(accountId, "utf8").toString("base64url") !== parts[1]
  ) {
    throw new Error("hosted_codex_mutation_lease_invalid");
  }
  return { accountId, fenceEpoch };
}

/** Returns the caller-held owner and monotonic terms without exposing its nonce. */
export function hostedCodexMutationLeaseAuthority(leaseId: string): {
  readonly accountId: string;
  readonly fenceEpoch: bigint;
  readonly ownerIdHash: string;
} {
  return { ...decodeLeaseId(leaseId), ownerIdHash: sha256(leaseId) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
