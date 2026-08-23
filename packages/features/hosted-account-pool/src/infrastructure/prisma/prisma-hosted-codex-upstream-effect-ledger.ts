import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  HostedCodexUpstreamEffectState,
  Prisma,
  PrismaClient,
} from "@prisma/client";

const terminalStates: readonly HostedCodexUpstreamEffectState[] = [
  "succeeded",
  "failed_no_effect",
  "failed_classified",
  "terminal_unknown",
];

export type HostedCodexUpstreamEffectLease = {
  readonly attemptId: string;
  readonly ownerToken: string;
  readonly fenceEpoch: bigint;
  readonly accountId: string;
};

/** Durable, per-request/account upstream POST authority. It never gates peers. */
export class PrismaHostedCodexUpstreamEffectLedger {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  authority(lease: HostedCodexUpstreamEffectLease) {
    return {
      attemptId: lease.attemptId,
      ownerIdHash: sha256(lease.ownerToken),
      fenceEpoch: lease.fenceEpoch,
    };
  }

  async prepare(input: {
    readonly relayRequestId: string;
    readonly grantId: string;
    readonly workspaceId: string;
    readonly poolId: string;
    readonly accountId: string;
    readonly requestHash: string;
    readonly leaseMs?: number;
  }): Promise<HostedCodexUpstreamEffectLease> {
    requireHash(input.requestHash);
    const leaseMs = input.leaseMs ?? 30_000;
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 5_000 ||
      leaseMs > 300_000
    ) {
      throw new Error("hosted_codex_effect_lease_invalid");
    }
    const now = this.now();
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const request = await transaction.hostedCodexRelayRequest.findFirst({
          where: {
            id: input.relayRequestId,
            grantId: input.grantId,
            requestHash: input.requestHash,
            status: "processing",
          },
          include: {
            grant: { include: { account: true } },
          },
        });
        if (!request) throw new Error("hosted_codex_effect_request_invalid");
        assertCurrentDispatchAuthority(request.grant, input.accountId, now);
        const prior =
          await transaction.hostedCodexUpstreamEffectAttempt.findMany({
            where: { relayRequestId: input.relayRequestId },
            orderBy: { attemptOrdinal: "desc" },
            take: 1,
          });
        const latest = prior[0];
        if (latest && !terminalStates.includes(latest.state)) {
          throw new Error("hosted_codex_effect_attempt_in_progress");
        }
        if (
          latest &&
          latest.accountId === input.accountId &&
          latest.state !== "failed_no_effect"
        ) {
          throw new Error("hosted_codex_effect_resend_forbidden");
        }
        const attemptOrdinal = (latest?.attemptOrdinal ?? 0) + 1;
        const ownerToken = randomBytes(32).toString("base64url");
        const attemptId = randomUUID();
        await transaction.hostedCodexUpstreamEffectAttempt.create({
          data: {
            id: attemptId,
            relayRequestId: input.relayRequestId,
            grantId: input.grantId,
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            accountId: input.accountId,
            attemptOrdinal,
            requestHash: input.requestHash,
            idempotencyKeyHash: sha256(
              [
                input.relayRequestId,
                input.accountId,
                String(attemptOrdinal),
              ].join("\u0000"),
            ),
            state: "prepared",
            ownerIdHash: sha256(ownerToken),
            fenceEpoch: BigInt(attemptOrdinal),
            heartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            createdAt: now,
            updatedAt: now,
          },
        });
        return {
          attemptId,
          ownerToken,
          fenceEpoch: BigInt(attemptOrdinal),
          accountId: input.accountId,
        };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async markDispatching(lease: HostedCodexUpstreamEffectLease): Promise<void> {
    const now = this.now();
    await serializableTransaction(
      this.prisma,
      async (transaction) => {
        const attempt =
          await transaction.hostedCodexUpstreamEffectAttempt.findFirst({
            where: this.liveLeaseWhere(lease, "prepared", now),
            include: { grant: { include: { account: true } } },
          });
        if (!attempt) throw new Error("hosted_codex_effect_lease_invalid");
        assertCurrentDispatchAuthority(attempt.grant, attempt.accountId, now);
        const updated =
          await transaction.hostedCodexUpstreamEffectAttempt.updateMany({
            where: this.liveLeaseWhere(lease, "prepared", now),
            data: {
              state: "dispatching",
              dispatchStartedAt: now,
              heartbeatAt: now,
              leaseExpiresAt: new Date(now.getTime() + 30_000),
            },
          });
        if (updated.count !== 1)
          throw new Error("hosted_codex_effect_lease_invalid");
      },
      { isolationLevel: "Serializable" },
    );
  }

  async heartbeat(lease: HostedCodexUpstreamEffectLease): Promise<void> {
    const now = this.now();
    const updated =
      await this.prisma.hostedCodexUpstreamEffectAttempt.updateMany({
        where: {
          id: lease.attemptId,
          ownerIdHash: sha256(lease.ownerToken),
          fenceEpoch: lease.fenceEpoch,
          state: { in: ["dispatching", "response_started"] },
          leaseExpiresAt: { gt: now },
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
        },
      });
    if (updated.count !== 1)
      throw new Error("hosted_codex_effect_lease_invalid");
  }

  async markResponseStarted(
    lease: HostedCodexUpstreamEffectLease,
    providerResponseId: string | null,
  ): Promise<void> {
    const now = this.now();
    const updated =
      await this.prisma.hostedCodexUpstreamEffectAttempt.updateMany({
        where: this.liveLeaseWhere(lease, "dispatching", now),
        data: {
          state: "response_started",
          responseStartedAt: now,
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          providerResponseIdHash: providerResponseId
            ? sha256(providerResponseId)
            : null,
        },
      });
    if (updated.count !== 1)
      throw new Error("hosted_codex_effect_lease_invalid");
  }

  async finish(
    lease: HostedCodexUpstreamEffectLease,
    input: {
      readonly state:
        | "succeeded"
        | "failed_no_effect"
        | "failed_classified"
        | "terminal_unknown";
      readonly errorCode?: string;
      readonly evidence: string;
    },
  ): Promise<void> {
    const now = this.now();
    await this.prisma.$transaction(async (transaction) => {
      const updated =
        await transaction.hostedCodexUpstreamEffectAttempt.updateMany({
          where: {
            id: lease.attemptId,
            ownerIdHash: sha256(lease.ownerToken),
            fenceEpoch: lease.fenceEpoch,
            state: { notIn: [...terminalStates] },
          },
          data: {
            state: input.state,
            completedAt: now,
            heartbeatAt: now,
            terminalEvidenceHash: sha256(input.evidence),
            errorCode: input.errorCode?.slice(0, 120) ?? null,
          },
        });
      if (updated.count !== 1) {
        throw new Error("hosted_codex_effect_completion_conflict");
      }
      if (input.state === "terminal_unknown") {
        const effect =
          await transaction.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
            where: { id: lease.attemptId },
            select: { relayRequestId: true, grantId: true },
          });
        const request = await transaction.hostedCodexRelayRequest.updateMany({
          where: {
            id: effect.relayRequestId,
            grantId: effect.grantId,
            status: { in: ["received", "processing", "response_started"] },
          },
          data: {
            status: "terminal_unknown",
            responseBytes: null,
            responseHash: null,
            errorCode: input.errorCode ?? "upstream_dispatch_outcome_unknown",
            completedAt: now,
          },
        });
        if (request.count !== 1) {
          throw new Error("relay_request_completion_conflict");
        }
        await poisonGrant(transaction, effect.grantId, now);
      }
    });
  }

  /** Crash recovery is conservative once dispatch could have reached upstream. */
  async sweepExpired(limit = 100): Promise<number> {
    const now = this.now();
    const expired = await this.prisma.hostedCodexUpstreamEffectAttempt.findMany(
      {
        where: {
          state: { in: ["prepared", "dispatching", "response_started"] },
          leaseExpiresAt: { lte: now },
        },
        orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
        take: limit,
      },
    );
    let swept = 0;
    for (const attempt of expired) {
      const terminalState =
        attempt.state === "prepared" ? "failed_no_effect" : "terminal_unknown";
      await this.prisma.$transaction(async (transaction) => {
        const changed =
          await transaction.hostedCodexUpstreamEffectAttempt.updateMany({
            where: {
              id: attempt.id,
              state: attempt.state,
              fenceEpoch: attempt.fenceEpoch,
              leaseExpiresAt: { lte: now },
            },
            data: {
              state: terminalState,
              completedAt: now,
              terminalEvidenceHash: sha256(
                `expired\u0000${attempt.id}\u0000${attempt.state}`,
              ),
              errorCode:
                terminalState === "terminal_unknown"
                  ? "upstream_dispatch_outcome_unknown"
                  : "upstream_dispatch_not_started",
            },
          });
        if (changed.count !== 1) return;
        if (terminalState === "terminal_unknown") {
          const request = await transaction.hostedCodexRelayRequest.updateMany({
            where: {
              id: attempt.relayRequestId,
              grantId: attempt.grantId,
              status: { in: ["received", "processing", "response_started"] },
            },
            data: {
              status: "terminal_unknown",
              errorCode: "upstream_dispatch_outcome_unknown",
              completedAt: now,
            },
          });
          if (request.count === 1) {
            await poisonGrant(transaction, attempt.grantId, now);
          }
        } else {
          const request = await transaction.hostedCodexRelayRequest.updateMany({
            where: {
              id: attempt.relayRequestId,
              grantId: attempt.grantId,
              status: { in: ["received", "processing"] },
            },
            data: {
              status: "failed",
              responseBytes: 0,
              responseHash: null,
              errorCode: "upstream_dispatch_not_started",
              completedAt: now,
            },
          });
          if (request.count !== 1) {
            throw new Error("relay_request_completion_conflict");
          }
        }
        swept += 1;
      });
    }
    const orphanCutoff = new Date(now.getTime() - 30_000);
    const terminalOrphans =
      await this.prisma.hostedCodexUpstreamEffectAttempt.findMany({
        where: {
          state: { in: ["failed_classified", "terminal_unknown"] },
          completedAt: { lte: orphanCutoff },
          relayRequest: {
            status: { in: ["received", "processing", "response_started"] },
          },
        },
        orderBy: [{ completedAt: "asc" }, { id: "asc" }],
        take: Math.max(0, limit - swept),
      });
    for (const attempt of terminalOrphans) {
      await this.prisma.$transaction(async (transaction) => {
        const request = await transaction.hostedCodexRelayRequest.updateMany({
          where: {
            id: attempt.relayRequestId,
            grantId: attempt.grantId,
            status: { in: ["received", "processing", "response_started"] },
          },
          data: {
            status:
              attempt.state === "terminal_unknown"
                ? "terminal_unknown"
                : "failed",
            errorCode: attempt.errorCode ?? "classified_failover_interrupted",
            completedAt: now,
          },
        });
        if (request.count !== 1) return;
        if (attempt.state === "terminal_unknown") {
          await poisonGrant(transaction, attempt.grantId, now);
        }
        swept += 1;
      });
    }
    return swept;
  }

  private liveLeaseWhere(
    lease: HostedCodexUpstreamEffectLease,
    state: HostedCodexUpstreamEffectState,
    now: Date,
  ) {
    return {
      id: lease.attemptId,
      ownerIdHash: sha256(lease.ownerToken),
      fenceEpoch: lease.fenceEpoch,
      state,
      leaseExpiresAt: { gt: now },
    };
  }
}

async function poisonGrant(
  transaction: Prisma.TransactionClient,
  grantId: string,
  now: Date,
): Promise<void> {
  await transaction.hostedCodexInvocationGrant.updateMany({
    where: {
      id: grantId,
      status: { in: ["issued", "exhausted"] },
      revokedAt: null,
    },
    data: {
      status: "revoked",
      revokedAt: now,
      revision: { increment: 1 },
    },
  });
  await transaction.hostedCodexCommentRefreshCapability.updateMany({
    where: { grantId, revokedAt: null },
    data: { revokedAt: now, revision: { increment: 1 } },
  });
}

function assertCurrentDispatchAuthority(
  grant: {
    readonly status: string;
    readonly revokedAt: Date | null;
    readonly expiresAt: Date;
    readonly activeAccountId: string;
    readonly account: {
      readonly state: string;
      readonly cooldownUntil: Date | null;
    };
  },
  accountId: string,
  now: Date,
): void {
  const accountUsable =
    grant.account.state === "healthy" ||
    (grant.account.state === "cooldown" &&
      grant.account.cooldownUntil !== null &&
      grant.account.cooldownUntil <= now);
  if (
    !["issued", "exhausted"].includes(grant.status) ||
    grant.revokedAt !== null ||
    grant.expiresAt <= now ||
    grant.activeAccountId !== accountId ||
    !accountUsable
  ) {
    throw new Error("hosted_codex_effect_authority_revoked");
  }
}

export function startHostedCodexEffectSweeper(
  ledger: PrismaHostedCodexUpstreamEffectLedger,
  intervalMs = 10_000,
): () => void {
  const timer = setInterval(() => {
    void ledger.sweepExpired().catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function requireHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("hosted_codex_effect_hash_invalid");
  }
}

async function serializableTransaction<T>(
  prisma: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  options: { readonly isolationLevel: "Serializable" },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, options);
    } catch (error) {
      if (attempt >= 3 || !isSerializableWriteConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

function isSerializableWriteConflict(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "P2034") return true;
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("TransactionWriteConflict") ||
    message.includes("write conflict") ||
    message.includes("could not serialize access")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
