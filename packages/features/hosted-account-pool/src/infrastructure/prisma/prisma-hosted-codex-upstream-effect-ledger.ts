import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  HostedCodexUpstreamEffectState,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

const terminalStates: readonly HostedCodexUpstreamEffectState[] = [
  "succeeded",
  "failed_no_effect",
  "failed_classified",
  "terminal_unknown",
];

const dispatchAuthorityInclude =
  Prisma.validator<Prisma.HostedCodexInvocationGrantInclude>()({
    account: true,
    binding: { include: { pool: true } },
  });

type DispatchAuthorityGrant = Prisma.HostedCodexInvocationGrantGetPayload<{
  include: typeof dispatchAuthorityInclude;
}>;

type RuntimeGateAuthority = Readonly<{
  status: string;
  authzEpoch: bigint;
}>;

export type HostedCodexUpstreamEffectLease = {
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly ownerToken: string;
  readonly fenceEpoch: bigint;
  readonly accountId: string;
  readonly credentialGeneration: number;
};

export class HostedCodexCredentialGenerationChangedError extends Error {
  constructor() {
    super("hosted_codex_credential_generation_changed");
  }
}

export class HostedCodexEffectReservationOutcomeUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super("hosted_codex_effect_reservation_outcome_unknown");
  }
}

export class HostedCodexEffectReservationDeferredError extends Error {
  constructor() {
    super("hosted_codex_effect_reservation_deferred");
  }
}

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

  async assertLiveAuthority(input: {
    readonly grantId: string;
    readonly accountId: string;
  }): Promise<void> {
    const now = this.now();
    await serializableTransaction(
      this.prisma,
      async (transaction) => {
        const grant = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: dispatchAuthorityInclude,
        });
        if (!grant) throw new Error("hosted_codex_effect_authority_revoked");
        const runtimeGate = await lockRuntimeGateAuthority(transaction);
        assertCurrentDispatchAuthority(
          grant,
          runtimeGate,
          input.accountId,
          now,
        );
      },
      { isolationLevel: "Serializable" },
    );
  }

  async prepare(input: {
    readonly relayRequestId: string;
    readonly grantId: string;
    readonly workspaceId: string;
    readonly poolId: string;
    readonly accountId: string;
    readonly credentialGeneration: number;
    readonly requestHash: string;
    readonly leaseMs?: number;
  }): Promise<HostedCodexUpstreamEffectLease> {
    requireHash(input.requestHash);
    if (
      !Number.isSafeInteger(input.credentialGeneration) ||
      input.credentialGeneration < 1
    ) {
      throw new Error("hosted_codex_credential_generation_invalid");
    }
    const leaseMs = input.leaseMs ?? 30_000;
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 5_000 ||
      leaseMs > 300_000
    ) {
      throw new Error("hosted_codex_effect_lease_invalid");
    }
    const now = this.now();
    const ownerToken = randomBytes(32).toString("base64url");
    const ownerIdHash = sha256(ownerToken);
    const attemptId = randomUUID();
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        await lockRelayRequest(
          transaction,
          input.relayRequestId,
          input.grantId,
        );
        const request = await transaction.hostedCodexRelayRequest.findFirst({
          where: {
            id: input.relayRequestId,
            grantId: input.grantId,
            requestHash: input.requestHash,
            status: "processing",
          },
          include: {
            grant: { include: dispatchAuthorityInclude },
          },
        });
        if (!request) throw new Error("hosted_codex_effect_request_invalid");
        const latest =
          await transaction.hostedCodexUpstreamEffectAttempt.findFirst({
            where: { relayRequestId: input.relayRequestId },
            orderBy: { attemptOrdinal: "desc" },
          });
        if (latest && !terminalStates.includes(latest.state)) {
          throw new HostedCodexEffectReservationDeferredError();
        }
        const runtimeGate = await lockRuntimeGateAuthority(transaction);
        assertCurrentDispatchAuthority(
          request.grant,
          runtimeGate,
          input.accountId,
          now,
        );
        if (
          request.grant.account.activeGeneration !==
          BigInt(input.credentialGeneration)
        ) {
          throw new HostedCodexCredentialGenerationChangedError();
        }
        if (
          latest &&
          latest.accountId === input.accountId &&
          latest.state !== "failed_no_effect"
        ) {
          throw new Error("hosted_codex_effect_resend_forbidden");
        }
        const attemptOrdinal = (latest?.attemptOrdinal ?? 0) + 1;
        await transaction.hostedCodexUpstreamEffectAttempt.create({
          data: {
            id: attemptId,
            relayRequestId: input.relayRequestId,
            grantId: input.grantId,
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            accountId: input.accountId,
            credentialGeneration: BigInt(input.credentialGeneration),
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
            ownerIdHash,
            fenceEpoch: BigInt(attemptOrdinal),
            heartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            createdAt: now,
            updatedAt: now,
          },
        });
        return {
          attemptId,
          attemptOrdinal,
          ownerToken,
          fenceEpoch: BigInt(attemptOrdinal),
          accountId: input.accountId,
          credentialGeneration: input.credentialGeneration,
        };
      },
      { isolationLevel: "Serializable" },
    ).catch(async (error: unknown) => {
      let recovered;
      try {
        recovered =
          await this.prisma.hostedCodexUpstreamEffectAttempt.findFirst({
            where: {
              id: attemptId,
              relayRequestId: input.relayRequestId,
              grantId: input.grantId,
              workspaceId: input.workspaceId,
              poolId: input.poolId,
              accountId: input.accountId,
              credentialGeneration: BigInt(input.credentialGeneration),
              requestHash: input.requestHash,
              ownerIdHash,
            },
          });
      } catch (reconciliationError) {
        throw new HostedCodexEffectReservationOutcomeUnknownError(
          reconciliationError,
        );
      }
      if (!recovered) throw error;
      if (
        recovered.state !== "prepared" ||
        recovered.leaseExpiresAt <= this.now() ||
        recovered.fenceEpoch !== BigInt(recovered.attemptOrdinal)
      ) {
        throw new HostedCodexEffectReservationOutcomeUnknownError(error);
      }
      return {
        attemptId: recovered.id,
        attemptOrdinal: recovered.attemptOrdinal,
        ownerToken,
        fenceEpoch: recovered.fenceEpoch,
        accountId: recovered.accountId,
        credentialGeneration: input.credentialGeneration,
      };
    });
  }

  async markDispatching(lease: HostedCodexUpstreamEffectLease): Promise<void> {
    const now = this.now();
    await serializableTransaction(
      this.prisma,
      async (transaction) => {
        const attempt =
          await transaction.hostedCodexUpstreamEffectAttempt.findFirst({
            where: this.liveLeaseWhere(lease, "prepared", now),
            include: { grant: { include: dispatchAuthorityInclude } },
          });
        if (!attempt) throw new Error("hosted_codex_effect_lease_invalid");
        const runtimeGate = await lockRuntimeGateAuthority(transaction);
        assertCurrentDispatchAuthority(
          attempt.grant,
          runtimeGate,
          attempt.accountId,
          now,
        );
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
    await serializableTransaction(
      this.prisma,
      async (transaction) => {
        const attempt =
          await transaction.hostedCodexUpstreamEffectAttempt.findFirst({
            where: {
              id: lease.attemptId,
              ownerIdHash: sha256(lease.ownerToken),
              fenceEpoch: lease.fenceEpoch,
              state: { in: ["dispatching", "response_started"] },
              leaseExpiresAt: { gt: now },
            },
            include: { grant: { include: dispatchAuthorityInclude } },
          });
        if (!attempt) throw new Error("hosted_codex_effect_lease_invalid");
        const runtimeGate = await lockRuntimeGateAuthority(transaction);
        assertCurrentDispatchAuthority(
          attempt.grant,
          runtimeGate,
          attempt.accountId,
          now,
        );
        const updated =
          await transaction.hostedCodexUpstreamEffectAttempt.updateMany({
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
      },
      { isolationLevel: "Serializable" },
    );
  }

  async markResponseStarted(
    lease: HostedCodexUpstreamEffectLease,
    providerResponseId: string | null,
  ): Promise<void> {
    const now = this.now();
    await serializableTransaction(
      this.prisma,
      async (transaction) => {
        const attempt =
          await transaction.hostedCodexUpstreamEffectAttempt.findFirst({
            where: this.liveLeaseWhere(lease, "dispatching", now),
            include: { grant: { include: dispatchAuthorityInclude } },
          });
        if (!attempt) throw new Error("hosted_codex_effect_lease_invalid");
        const runtimeGate = await lockRuntimeGateAuthority(transaction);
        assertCurrentDispatchAuthority(
          attempt.grant,
          runtimeGate,
          attempt.accountId,
          now,
        );
        const updated =
          await transaction.hostedCodexUpstreamEffectAttempt.updateMany({
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
      },
      { isolationLevel: "Serializable" },
    );
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
    const terminalOrphans = await findLatestTerminalOrphans(
      this.prisma,
      orphanCutoff,
      Math.max(0, limit - swept),
    );
    for (const attempt of terminalOrphans) {
      await this.prisma.$transaction(async (transaction) => {
        await lockRelayRequest(
          transaction,
          attempt.relayRequestId,
          attempt.grantId,
        );
        const latest =
          await transaction.hostedCodexUpstreamEffectAttempt.findFirst({
            where: { relayRequestId: attempt.relayRequestId },
            orderBy: { attemptOrdinal: "desc" },
            select: { id: true },
          });
        if (latest?.id !== attempt.id) return;
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
            responseBytes: attempt.state === "failed_no_effect" ? 0 : null,
            responseHash: null,
            errorCode:
              attempt.state === "failed_no_effect"
                ? "upstream_dispatch_not_started"
                : (attempt.errorCode ?? "classified_failover_interrupted"),
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

type LatestTerminalOrphan = {
  readonly id: string;
  readonly relayRequestId: string;
  readonly grantId: string;
  readonly state: HostedCodexUpstreamEffectState;
  readonly errorCode: string | null;
};

async function findLatestTerminalOrphans(
  prisma: PrismaClient,
  completedBefore: Date,
  limit: number,
): Promise<readonly LatestTerminalOrphan[]> {
  if (limit === 0) return [];
  return prisma.$queryRaw<LatestTerminalOrphan[]>(
    Prisma.sql`
      SELECT
        candidate."id",
        candidate."relayRequestId",
        candidate."grantId",
        candidate."state",
        candidate."errorCode"
      FROM "HostedCodexUpstreamEffectAttempt" AS candidate
      INNER JOIN "HostedCodexRelayRequest" AS request
        ON request."id" = candidate."relayRequestId"
        AND request."grantId" = candidate."grantId"
      WHERE candidate."state" IN (
        'failed_no_effect',
        'failed_classified',
        'terminal_unknown'
      )
        AND candidate."completedAt" <= ${completedBefore}
        AND request."status" IN (
          'received',
          'processing',
          'response_started'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "HostedCodexUpstreamEffectAttempt" AS newer
          WHERE newer."relayRequestId" = candidate."relayRequestId"
            AND newer."attemptOrdinal" > candidate."attemptOrdinal"
        )
      ORDER BY candidate."completedAt" ASC, candidate."id" ASC
      LIMIT ${limit}
    `,
  );
}

async function lockRelayRequest(
  transaction: Prisma.TransactionClient,
  relayRequestId: string,
  grantId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`
      SELECT "id"
      FROM "HostedCodexRelayRequest"
      WHERE "id" = ${relayRequestId}
        AND "grantId" = ${grantId}
      FOR UPDATE
    `,
  );
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
  grant: DispatchAuthorityGrant,
  runtimeGate: RuntimeGateAuthority,
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
    grant.runtimeAuthzEpoch === null ||
    runtimeGate.status !== "active" ||
    runtimeGate.authzEpoch !== grant.runtimeAuthzEpoch ||
    grant.binding.status !== "active" ||
    grant.binding.revision !== grant.bindingRevision ||
    grant.binding.pool.status !== "active" ||
    grant.binding.pool.authzEpoch !== grant.authzEpoch ||
    !accountUsable
  ) {
    throw new Error("hosted_codex_effect_authority_revoked");
  }
}

async function lockRuntimeGateAuthority(
  transaction: Prisma.TransactionClient,
): Promise<RuntimeGateAuthority> {
  const rows = await transaction.$queryRaw<
    Array<{ status: string; authzEpoch: bigint }>
  >`
    SELECT "status"::text AS "status", "authzEpoch"
    FROM "HostedCodexRuntimeGate"
    WHERE "id" = 'global'
    FOR SHARE
  `;
  if (rows.length !== 1)
    throw new Error("hosted_codex_effect_authority_revoked");
  return rows[0]!;
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
