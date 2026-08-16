import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { InvocationGrantRepositoryPort } from "../../application/ports/invocation-grant-repository-port";
import type { CommentTokenRefreshCapabilityPort } from "../../application/ports/comment-token-refresh-capability-port";
import type { CurrentRelayRequestFailoverPort } from "../../application/ports/current-relay-request-failover-port";
import type {
  RelayRequestAdmissionPort,
  RelayRequestCompletionPort,
  RelayResponseStartedPort,
} from "../../application/ports/relay-request-ledger-port";
import type { InvocationGrant } from "../../domain/invocation-grant";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  relayRequestId,
  repositoryId,
  workspaceId,
} from "../../domain/identifiers";

type StoredGrant = Prisma.HostedCodexInvocationGrantGetPayload<{
  include: { relayRequests: true; commentRefreshCapability: true };
}>;

const grantInclude = {
  relayRequests: { orderBy: { ordinal: "asc" as const } },
  commentRefreshCapability: true,
} as const;

export class PrismaInvocationGrantRepository
  implements
    InvocationGrantRepositoryPort,
    CommentTokenRefreshCapabilityPort,
    RelayRequestAdmissionPort,
    RelayRequestCompletionPort,
    RelayResponseStartedPort,
    CurrentRelayRequestFailoverPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findByInvocationId(id: ReturnType<typeof invocationId>) {
    const stored = await this.prisma.hostedCodexInvocationGrant.findUnique({
      where: { invocationId: id },
      include: grantInclude,
    });
    return stored ? restoreGrant(stored) : null;
  }

  async insert(grant: InvocationGrant): Promise<void> {
    await this.prisma.hostedCodexInvocationGrant.create({
      data: {
        id: grant.id,
        invocationId: grant.invocationId,
        workspaceId: grant.workspaceId,
        poolId: grant.poolId,
        repositoryConnectionId: grant.repositoryId,
        repositoryBindingId: grant.repositoryBindingId,
        activeAccountId: grant.activeAccountId,
        primaryAccountId: grant.primaryAccountId,
        backupAccountId: grant.backupAccountId,
        reviewRequestId: grant.authority.reviewRequestId,
        providerInvocationKey: grant.authority.providerInvocationKey,
        runId: grant.authority.runId,
        runAttempt: grant.authority.runAttempt,
        model: grant.authority.model,
        policyVersion: "hosted-codex-v1",
        policyFingerprint: grant.authority.policyFingerprint,
        runtimeConfigVersion: grant.authority.runtimeConfigVersion,
        bindingRevision: BigInt(grant.authority.bindingRevision),
        authzEpoch: grant.authority.authzEpoch,
        capabilityTokenHash: grant.capabilityTokenHash,
        issuedAt: grant.createdAt,
        expiresAt: grant.budget.expiresAt,
        maxRequests: grant.budget.maxRequests,
        maxConcurrentRequests: grant.budget.maxConcurrentRequests,
        maxRequestBytes: grant.budget.maxRequestBytes,
        requestCount: 0,
        inFlight: 0,
        commentRefreshCapability: {
          create: {
            capabilityTokenHash: grant.commentTokenRefreshCapability.tokenHash,
            issuedAt: grant.createdAt,
            expiresAt: grant.commentTokenRefreshCapability.expiresAt,
            maxUses: grant.commentTokenRefreshCapability.maxUses,
            useCount: grant.commentTokenRefreshCapability.useCount,
            revokedAt: grant.commentTokenRefreshCapability.revokedAt,
          },
        },
      },
    });
  }

  async issue() {
    const plaintextToken = randomBytes(32).toString("base64url");
    return { plaintextToken, tokenHash: sha256(plaintextToken) };
  }

  async consume(
    input: Parameters<CommentTokenRefreshCapabilityPort["consume"]>[0],
  ) {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const current = restoreGrant(stored);
        if (
          current.commentTokenRefreshCapability.tokenHash !==
          input.presentedTokenHash
        ) {
          throw new Error("comment_refresh_capability_invalid");
        }
        const capability = stored.commentRefreshCapability!;
        const replay =
          await transaction.hostedCodexCommentRefreshUse.findUnique({
            where: {
              capabilityId_requestIdHash: {
                capabilityId: capability.id,
                requestIdHash: input.requestIdHash,
              },
            },
          });
        if (replay) return { status: "replayed" as const, grant: current };
        const consumption = input.transition(current);
        if (consumption.status !== "consumed") return consumption;
        // The DB BEFORE INSERT trigger is the sole atomic consumption
        // authority: it checks token/scope/TTL/budget and increments useCount.
        await transaction.hostedCodexCommentRefreshUse.create({
          data: {
            capabilityId: capability.id,
            grantId: stored.id,
            invocationId: stored.invocationId,
            repositoryBindingId: stored.repositoryBindingId,
            workspaceId: stored.workspaceId,
            poolId: stored.poolId,
            repositoryConnectionId: stored.repositoryConnectionId,
            ordinal: capability.useCount + 1,
            requestIdHash: input.requestIdHash,
            presentedTokenHash: input.presentedTokenHash,
            usedAt: input.now,
          },
        });
        return consumption;
      },
      { isolationLevel: "Serializable" },
    ).catch(async (error: unknown) => {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      const stored = await this.prisma.hostedCodexInvocationGrant.findUnique({
        where: { id: input.grantId },
        include: grantInclude,
      });
      const capability = stored?.commentRefreshCapability;
      if (!stored || !capability) throw error;
      const replay = await this.prisma.hostedCodexCommentRefreshUse.findUnique({
        where: {
          capabilityId_requestIdHash: {
            capabilityId: capability.id,
            requestIdHash: input.requestIdHash,
          },
        },
      });
      if (
        !replay ||
        capability.capabilityTokenHash !== input.presentedTokenHash
      ) {
        throw error;
      }
      return { status: "replayed" as const, grant: restoreGrant(stored) };
    });
  }

  async revoke(
    input: Parameters<CommentTokenRefreshCapabilityPort["revoke"]>[0],
  ) {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const current = restoreGrant(stored);
        const next = input.transition(current);
        const capability = stored.commentRefreshCapability!;
        if (capability.revokedAt === null) {
          const updated =
            await transaction.hostedCodexCommentRefreshCapability.updateMany({
              where: { id: capability.id, revision: capability.revision },
              data: {
                revokedAt: input.revokedAt,
                revision: { increment: 1 },
              },
            });
          if (updated.count !== 1) {
            throw new Error("comment_refresh_capability_cas_conflict");
          }
        }
        return next;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async mutate(
    grantId: ReturnType<typeof invocationGrantId>,
    transition: (current: InvocationGrant) => InvocationGrant,
  ): Promise<InvocationGrant> {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const current = restoreGrant(stored);
        const next = transition(current);
        assertImmutableGrantFields(current, next);

        const updated = await transaction.hostedCodexInvocationGrant.updateMany(
          {
            where: { id: next.id, revision: stored.revision },
            data: {
              activeAccountId: next.activeAccountId,
              failoverCount: next.backupActivated ? 1 : 0,
              revision: { increment: 1 },
            },
          },
        );
        if (updated.count !== 1) {
          throw new Error("invocation_grant_revision_conflict");
        }
        return next;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async admit(input: Parameters<RelayRequestAdmissionPort["admit"]>[0]) {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const current = restoreGrant(stored);
        const admission = input.transition(current);
        if (
          admission.status !== "admitted" &&
          admission.status !== "already_admitted"
        ) {
          return admission;
        }
        const existing = stored.relayRequests.find(
          (request) => request.id === input.requestId,
        );
        if (admission.status === "already_admitted") {
          if (
            !existing ||
            existing.ordinal !== input.ordinal ||
            existing.idempotencyKeyHash !== input.idempotencyKeyHash ||
            existing.requestBytes !== input.requestBytes
          ) {
            throw new Error("relay_request_replay_conflict");
          }
          return admission;
        }
        await transaction.hostedCodexRelayRequest.create({
          data: {
            id: input.requestId,
            grantId: input.grantId,
            ordinal: input.ordinal,
            idempotencyKeyHash: input.idempotencyKeyHash,
            requestHash: null,
            requestBytes: input.requestBytes,
            status: "processing",
            startedAt: new Date(),
          },
        });
        const persisted =
          await transaction.hostedCodexInvocationGrant.findUniqueOrThrow({
            where: { id: input.grantId },
            include: grantInclude,
          });
        return { ...admission, grant: restoreGrant(persisted) };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async complete(input: Parameters<RelayRequestCompletionPort["complete"]>[0]) {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const current = restoreGrant(stored);
        const next = input.transition(current);
        assertImmutableGrantFields(current, next);
        const succeeded = input.errorCode === null;
        const updatedRequest =
          await transaction.hostedCodexRelayRequest.updateMany({
            where: {
              id: input.requestId,
              grantId: input.grantId,
              status: { in: ["received", "processing", "response_started"] },
            },
            data: {
              status: succeeded ? "succeeded" : "failed",
              responseBytes: input.responseBytes,
              responseHash: input.responseHash,
              errorCode: input.errorCode,
              completedAt: input.completedAt,
            },
          });
        if (updatedRequest.count !== 1) {
          throw new Error("relay_request_completion_conflict");
        }
        let persisted =
          await transaction.hostedCodexInvocationGrant.findUniqueOrThrow({
            where: { id: input.grantId },
            include: grantInclude,
          });
        if (
          persisted.activeAccountId !== next.activeAccountId ||
          persisted.failoverCount !== (next.backupActivated ? 1 : 0)
        ) {
          await updateGrantWithCas(transaction, persisted, next);
          persisted =
            await transaction.hostedCodexInvocationGrant.findUniqueOrThrow({
              where: { id: input.grantId },
              include: grantInclude,
            });
        }
        return restoreGrant(persisted);
      },
      { isolationLevel: "Serializable" },
    );
  }

  async markStarted(
    input: Parameters<RelayResponseStartedPort["markStarted"]>[0],
  ) {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const current = restoreGrant(stored);
        const next = input.transition(current);
        const updated = await transaction.hostedCodexRelayRequest.updateMany({
          where: {
            id: input.requestId,
            grantId: input.grantId,
            status: { in: ["received", "processing"] },
            successfulResponseStartedAt: null,
          },
          data: {
            status: "response_started",
            responseBytes: 0,
            successfulResponseStartedAt: input.startedAt,
          },
        });
        if (updated.count !== 1) {
          throw new Error("relay_response_started_conflict");
        }
        const persisted =
          await transaction.hostedCodexInvocationGrant.findUniqueOrThrow({
            where: { id: input.grantId },
            include: grantInclude,
          });
        if (!next.successfulProviderResponseRecorded) {
          throw new Error("relay_response_started_transition_invalid");
        }
        return restoreGrant(persisted);
      },
      { isolationLevel: "Serializable" },
    );
  }

  async recordRequestHash(input: {
    readonly grantId: string;
    readonly requestId: string;
    readonly requestHash: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
      throw new Error("relay_request_hash_invalid");
    }
    const existing = await this.prisma.hostedCodexRelayRequest.findFirst({
      where: { id: input.requestId, grantId: input.grantId },
      select: { requestHash: true, status: true },
    });
    if (!existing) throw new Error("relay_request_not_found");
    if (existing.requestHash !== null) {
      if (existing.requestHash !== input.requestHash) {
        throw new Error("relay_request_hash_conflict");
      }
      return;
    }
    const updated = await this.prisma.hostedCodexRelayRequest.updateMany({
      where: {
        id: input.requestId,
        grantId: input.grantId,
        requestHash: null,
        status: { in: ["received", "processing"] },
      },
      data: { requestHash: input.requestHash },
    });
    if (updated.count !== 1) throw new Error("relay_request_hash_conflict");
  }

  /** Failure fallback: fills missing evidence but never replaces a real body hash. */
  async ensureRequestHash(input: {
    readonly grantId: string;
    readonly requestId: string;
    readonly fallbackRequestHash: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.fallbackRequestHash)) {
      throw new Error("relay_request_hash_invalid");
    }
    const request = await this.prisma.hostedCodexRelayRequest.findFirst({
      where: { id: input.requestId, grantId: input.grantId },
      select: { requestHash: true },
    });
    if (!request) throw new Error("relay_request_not_found");
    if (request.requestHash !== null) return;
    const updated = await this.prisma.hostedCodexRelayRequest.updateMany({
      where: { id: input.requestId, grantId: input.grantId, requestHash: null },
      data: { requestHash: input.fallbackRequestHash },
    });
    if (updated.count !== 1) {
      const raced = await this.prisma.hostedCodexRelayRequest.findFirst({
        where: { id: input.requestId, grantId: input.grantId },
        select: { requestHash: true },
      });
      if (raced?.requestHash === null)
        throw new Error("relay_request_hash_conflict");
    }
  }

  async failover(
    input: Parameters<CurrentRelayRequestFailoverPort["failover"]>[0],
  ) {
    return serializableTransaction(
      this.prisma,
      async (transaction) => {
        const stored = await transaction.hostedCodexInvocationGrant.findUnique({
          where: { id: input.grantId },
          include: grantInclude,
        });
        if (!stored) throw new Error("invocation_grant_not_found");
        const accountIds = [
          stored.activeAccountId,
          stored.backupAccountId,
        ].filter((id): id is string => id !== null);
        const accounts = await transaction.hostedCodexAccount.findMany({
          where: { id: { in: accountIds }, poolId: stored.poolId },
          include: {
            credentialVersions: {
              orderBy: { generation: "desc" },
              take: 1,
            },
          },
        });
        const failedStored = accounts.find(
          (account) => account.id === stored.activeAccountId,
        );
        if (!failedStored) throw new Error("hosted_failover_primary_missing");
        const failedAccount = restorePoolAccount(failedStored);
        const backupStored = accounts.find(
          (account) => account.id === stored.backupAccountId,
        );
        const result = input.transition(
          restoreGrant(stored),
          failedAccount,
          backupStored ? restorePoolAccount(backupStored) : null,
        );
        if (result.status === "denied") return result;
        const grantUpdated =
          await transaction.hostedCodexInvocationGrant.updateMany({
            where: {
              id: stored.id,
              revision: stored.revision,
              failoverCount: 0,
            },
            data: {
              activeAccountId: result.grant.activeAccountId,
              failoverCount: result.grant.failoverCount,
              revision: { increment: 1 },
            },
          });
        if (grantUpdated.count !== 1)
          throw new Error("invocation_grant_revision_conflict");
        const availability = result.failedAccount.availability;
        const accountUpdated = await transaction.hostedCodexAccount.updateMany({
          where: {
            id: failedStored.id,
            healthVersion: failedStored.healthVersion,
          },
          data: {
            state:
              availability.status === "cooldown" ? "cooldown" : "quarantined",
            cooldownUntil:
              availability.status === "cooldown" ? availability.until : null,
            healthVersion: { increment: 1 },
          },
        });
        if (accountUpdated.count !== 1)
          throw new Error("hosted_account_health_conflict");
        return result;
      },
      { isolationLevel: "Serializable" },
    );
  }
}

async function updateGrantWithCas(
  transaction: Prisma.TransactionClient,
  stored: StoredGrant,
  next: InvocationGrant,
): Promise<void> {
  const updated = await transaction.hostedCodexInvocationGrant.updateMany({
    where: { id: next.id, revision: stored.revision },
    data: {
      activeAccountId: next.activeAccountId,
      failoverCount: next.backupActivated ? 1 : 0,
      revision: { increment: 1 },
    },
  });
  if (updated.count !== 1)
    throw new Error("invocation_grant_revision_conflict");
}

function restoreGrant(stored: StoredGrant): InvocationGrant {
  const admitted = stored.relayRequests.map((request) =>
    relayRequestId(request.id),
  );
  const inFlight = stored.relayRequests
    .filter(
      (request) =>
        request.status === "received" ||
        request.status === "processing" ||
        request.status === "response_started",
    )
    .map((request) => relayRequestId(request.id));
  return {
    id: invocationGrantId(stored.id),
    invocationId: invocationId(stored.invocationId),
    repositoryId: repositoryId(stored.repositoryConnectionId),
    workspaceId: workspaceId(stored.workspaceId),
    poolId: hostedPoolId(stored.poolId),
    repositoryBindingId: hostedBindingId(stored.repositoryBindingId),
    primaryAccountId: hostedAccountId(stored.primaryAccountId),
    backupAccountId:
      stored.backupAccountId === null
        ? null
        : hostedAccountId(stored.backupAccountId),
    activeAccountId: hostedAccountId(stored.activeAccountId),
    failoverCount: stored.failoverCount,
    backupActivated: stored.failoverCount > 0,
    successfulProviderResponseRecorded:
      stored.firstSuccessfulResponseAt !== null,
    capabilityTokenHash: stored.capabilityTokenHash,
    commentTokenRefreshCapability: restoreCommentRefreshCapability(stored),
    authority: {
      repositoryBindingId: hostedBindingId(stored.repositoryBindingId),
      reviewRequestId: stored.reviewRequestId,
      providerInvocationKey: stored.providerInvocationKey,
      runId: stored.runId,
      runAttempt: stored.runAttempt,
      model: stored.model,
      policyFingerprint: stored.policyFingerprint,
      runtimeConfigVersion: stored.runtimeConfigVersion,
      bindingRevision: toSafeNumber(stored.bindingRevision),
      authzEpoch: stored.authzEpoch,
    },
    budget: {
      expiresAt: stored.expiresAt,
      maxRequests: stored.maxRequests,
      maxConcurrentRequests: stored.maxConcurrentRequests,
      maxRequestBytes: stored.maxRequestBytes,
    },
    admittedRequestIds: admitted,
    inFlightRequestIds: inFlight,
    createdAt: stored.issuedAt,
  };
}

function restoreCommentRefreshCapability(
  stored: StoredGrant,
): InvocationGrant["commentTokenRefreshCapability"] {
  const capability = stored.commentRefreshCapability;
  if (!capability) throw new Error("hosted_comment_refresh_capability_missing");
  return {
    tokenHash: capability.capabilityTokenHash,
    grantId: invocationGrantId(stored.id),
    invocationId: invocationId(stored.invocationId),
    repositoryBindingId: hostedBindingId(stored.repositoryBindingId),
    expiresAt: capability.expiresAt,
    maxUses: capability.maxUses,
    useCount: capability.useCount,
    revokedAt: capability.revokedAt,
  };
}

function assertImmutableGrantFields(
  current: InvocationGrant,
  next: InvocationGrant,
): void {
  if (
    current.id !== next.id ||
    current.invocationId !== next.invocationId ||
    current.repositoryId !== next.repositoryId ||
    current.workspaceId !== next.workspaceId ||
    current.poolId !== next.poolId ||
    current.repositoryBindingId !== next.repositoryBindingId ||
    current.primaryAccountId !== next.primaryAccountId ||
    current.backupAccountId !== next.backupAccountId ||
    current.capabilityTokenHash !== next.capabilityTokenHash
  ) {
    throw new Error("invocation_grant_immutable_field_changed");
  }
}

function toSafeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("hosted_codex_revision_out_of_range");
  }
  return number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function restorePoolAccount(account: {
  readonly id: string;
  readonly poolId: string;
  readonly label: string;
  readonly priority: number;
  readonly accountFingerprint: string;
  readonly state: string;
  readonly cooldownUntil: Date | null;
  readonly healthVersion: bigint;
  readonly activeGeneration: bigint | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly credentialVersions: readonly {
    readonly generation: bigint;
    readonly credentialExpiresAt: Date | null;
    readonly createdAt: Date;
  }[];
}) {
  const credential = account.credentialVersions[0];
  if (!credential || account.activeGeneration !== credential.generation) {
    throw new Error("hosted_account_active_credential_missing");
  }
  const availability =
    account.state === "healthy"
      ? ({ status: "healthy" } as const)
      : account.state === "cooldown" && account.cooldownUntil
        ? ({
            status: "cooldown",
            reason: "rate_limited",
            until: account.cooldownUntil,
          } as const)
        : account.state === "paused"
          ? ({ status: "paused", reason: "paused" } as const)
          : ({ status: "quarantined", reason: account.state } as const);
  return {
    id: hostedAccountId(account.id),
    poolId: hostedPoolId(account.poolId),
    label: account.label,
    priority: account.priority,
    credential: {
      credentialRef: `hosted-envelope:${account.id}:${credential.generation}`,
      subjectFingerprint: account.accountFingerprint,
      authGeneration: toSafeNumber(credential.generation),
      validatedAt: credential.createdAt,
      expiresAt: credential.credentialExpiresAt,
    },
    availability,
    healthVersion: toSafeNumber(account.healthVersion),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
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

function isPrismaErrorCode(error: unknown, expected: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === expected
  );
}
