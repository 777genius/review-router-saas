import type { Prisma, PrismaClient } from "@prisma/client";
import { commentTokenRefreshCapabilityStatus } from "../../domain/invocation-grant";
import type {
  HostedCommentTokenMintLedgerPort,
  PreparedHostedCommentTokenMint,
} from "../../application/ports/hosted-comment-token-mint-ledger-port";

type AuthoritySnapshot = Readonly<{
  gateStatus: string;
  runtimeAuthzEpoch: bigint;
  runtimeGateRevision: bigint;
  grantId: string;
  grantInvocationId: string;
  grantStatus: string;
  grantRevokedAt: Date | null;
  grantExpiresAt: Date;
  grantRuntimeAuthzEpoch: bigint | null;
  grantAuthzEpoch: bigint;
  grantBindingRevision: bigint;
  workspaceId: string;
  capabilityId: string | null;
  capabilityTokenHash: string | null;
  capabilityExpiresAt: Date | null;
  capabilityRevokedAt: Date | null;
  capabilityMaxUses: number | null;
  capabilityUseCount: number | null;
  bindingId: string;
  bindingStatus: string;
  bindingRevision: bigint;
  bindingStateVersion: bigint;
  attestedGithubRepositoryId: bigint | null;
  poolId: string;
  poolStatus: string;
  poolRevision: bigint;
  poolAuthzEpoch: bigint;
  repositoryConnectionId: string;
  repositoryProvider: string;
  repositorySelected: boolean;
  repositoryArchived: boolean;
  repositoryVisibility: string;
  repositoryUpdatedAt: Date;
  githubRepositoryId: bigint | null;
  repositoryFullName: string;
  installationRowId: string | null;
  installationStatus: string | null;
  installationSelection: string | null;
  installationUpdatedAt: Date | null;
  installationWorkspaceId: string | null;
  githubInstallationId: bigint | null;
}>;

const transactionOptions = {
  isolationLevel:
    "ReadCommitted" as const satisfies Prisma.TransactionIsolationLevel,
  maxWait: 5_000,
  timeout: 10_000,
};

/** Prisma adapter for short prepare/authorize/finalize transactions. */
export class PrismaHostedCommentTokenMintLedger implements HostedCommentTokenMintLedgerPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly testHooks?: Readonly<{
      afterPrepare?: () => Promise<void>;
      afterReplayAuthority?: () => Promise<void>;
    }>,
  ) {}

  async recoverStale(
    input: Parameters<HostedCommentTokenMintLedgerPort["recoverStale"]>[0],
  ) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error("hosted_comment_mint_recovery_batch_invalid");
    return this.prisma.$transaction(async (transaction) => {
      const rows = await mutateMint(transaction, "recover_stale", {
        limit: input.limit,
      });
      return rows.length;
    }, transactionOptions);
  }

  async prepare(
    input: Parameters<HostedCommentTokenMintLedgerPort["prepare"]>[0],
  ) {
    try {
      return await this.prepareOnce(input);
    } catch (error) {
      // Concurrent callers can both observe no row before one wins a unique
      // mint/use constraint. Re-entering the short transaction converts that
      // storage race into the durable replay/busy/fingerprint result without
      // ever authorizing a second provider attempt.
      if (!isPrismaUniqueConflict(error)) throw error;
      return this.prepareOnce(input);
    }
  }

  private async prepareOnce(
    input: Parameters<HostedCommentTokenMintLedgerPort["prepare"]>[0],
  ) {
    return this.prisma.$transaction(async (transaction) => {
      // One lock order is used by every authority transaction: gate;
      // installation/repository; pool/binding; grant/capability; mint.
      const rows = await readAuthoritySnapshot(transaction, input.grantId);
      const authority = rows[0];
      if (rows.length !== 1 || !authority) throw authorityMismatch();

      if (input.purpose === "refresh") {
        const lockedCapability = await transaction.$queryRaw<
          Array<{ id: string }>
        >`
          SELECT "id" FROM "HostedCodexCommentRefreshCapability"
          WHERE "id" = ${authority.capabilityId}
          FOR UPDATE
        `;
        if (lockedCapability.length !== 1) throw authorityMismatch();
      }

      const existing = await tryLockMint(transaction, input.mintId);
      // clock_timestamp() is deliberately read only after every authority and
      // mint lock. A waiter must never validate deadlines against pre-wait time.
      const databaseNow = await readDatabaseNow(transaction);
      assertAuthority(authority, input, databaseNow);
      if (existing) {
        if (
          existing.logicalKeyHash !== input.logicalKeyHash ||
          existing.requestFingerprintHash !== input.requestFingerprintHash ||
          existing.grantId !== input.grantId ||
          existing.purpose !== input.purpose ||
          existing.requestIdHash !== (input.requestIdHash ?? null) ||
          existing.presentedTokenHash !== (input.presentedTokenHash ?? null)
        ) {
          throw new Error("hosted_comment_mint_replay_fingerprint_conflict");
        }
        // Replay is a delivery authorization, not merely a lookup. The same
        // durable mint may be returned only while its exact prepared authority
        // snapshot still matches the currently locked rows.
        assertAttemptSnapshot(existing, authority);
        if (existing.state !== "prepared")
          return { mintId: existing.id, state: existing.state } as never;
        if (
          existing.ownerIdHash !== input.ownerIdHash &&
          existing.leaseExpiresAt > databaseNow
        )
          throw new Error("hosted_comment_mint_busy");
        const [reclaimed] = await mutateMint(transaction, "reclaim_prepared", {
          mintId: existing.id,
          ownerIdHash: input.ownerIdHash,
          leaseExpiresAt: translateDeadline(
            databaseNow,
            input.now,
            input.leaseExpiresAt,
            5 * 60_000,
          ),
        });
        if (!reclaimed) throw new Error("hosted_comment_mint_reclaim_conflict");
        return prepared(reclaimed);
      }

      const [created] = await mutateMint(transaction, "prepare", {
        mintId: input.mintId,
        purpose: input.purpose,
        ownerIdHash: input.ownerIdHash,
        logicalKeyHash: input.logicalKeyHash,
        requestFingerprintHash: input.requestFingerprintHash,
        grantId: authority.grantId,
        capabilityId:
          input.purpose === "refresh" ? authority.capabilityId : null,
        requestIdHash: input.requestIdHash ?? null,
        presentedTokenHash: input.presentedTokenHash ?? null,
        runtimeAuthzEpoch: authority.runtimeAuthzEpoch,
        runtimeGateRevision: authority.runtimeGateRevision,
        workspaceId: authority.workspaceId,
        repositoryBindingId: authority.bindingId,
        bindingRevision: authority.bindingRevision,
        bindingStateVersion: authority.bindingStateVersion,
        poolId: authority.poolId,
        poolRevision: authority.poolRevision,
        poolAuthzEpoch: authority.poolAuthzEpoch,
        repositoryConnectionId: authority.repositoryConnectionId,
        repositoryUpdatedAt: authority.repositoryUpdatedAt,
        githubInstallationRowId: authority.installationRowId!,
        installationUpdatedAt: authority.installationUpdatedAt!,
        installationStatus: authority.installationStatus as "active",
        installationSelection: authority.installationSelection!,
        installationWorkspaceId: authority.installationWorkspaceId!,
        githubInstallationId: authority.githubInstallationId!,
        githubRepositoryId: authority.githubRepositoryId!,
        repositoryFullName: authority.repositoryFullName,
        preparedAt: databaseNow,
        leaseExpiresAt: translateDeadline(
          databaseNow,
          input.now,
          input.leaseExpiresAt,
          5 * 60_000,
        ),
      });
      if (!created) throw new Error("hosted_comment_mint_prepare_conflict");
      if (input.purpose === "refresh") {
        if (
          !authority.capabilityId ||
          !authority.capabilityExpiresAt ||
          authority.capabilityMaxUses === null ||
          authority.capabilityUseCount === null ||
          !input.requestIdHash ||
          !input.presentedTokenHash
        )
          throw authorityMismatch();
        const status = commentTokenRefreshCapabilityStatus({
          expiresAt: authority.capabilityExpiresAt,
          revokedAt: authority.capabilityRevokedAt,
          maxUses: authority.capabilityMaxUses,
          useCount: authority.capabilityUseCount,
          now: databaseNow,
        });
        if (status !== "available")
          throw new Error(`hosted_comment_refresh_${status}`);
        await transaction.hostedCodexCommentRefreshUse.create({
          data: {
            capabilityId: authority.capabilityId,
            grantId: authority.grantId,
            invocationId: authority.grantInvocationId,
            repositoryBindingId: authority.bindingId,
            workspaceId: authority.workspaceId,
            poolId: authority.poolId,
            repositoryConnectionId: authority.repositoryConnectionId,
            ordinal: authority.capabilityUseCount + 1,
            requestIdHash: input.requestIdHash,
            presentedTokenHash: input.presentedTokenHash,
            mintId: input.mintId,
            usedAt: databaseNow,
          },
        });
      }
      await this.testHooks?.afterPrepare?.();
      return prepared(created);
    }, transactionOptions);
  }

  async authorizeDispatch(
    input: Parameters<HostedCommentTokenMintLedgerPort["authorizeDispatch"]>[0],
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await lockRuntimeGate(transaction);
      await lockAuthorityForMintId(transaction, input.mintId);
      const attempt = await lockMint(transaction, input.mintId);
      const databaseNow = await readDatabaseNow(transaction);
      const authorized = await currentAuthority(
        transaction,
        attempt,
        databaseNow,
      );
      if (
        attempt.state !== "prepared" ||
        attempt.ownerIdHash !== input.ownerIdHash ||
        attempt.leaseExpiresAt <= databaseNow ||
        !authorized
      ) {
        throw new Error("hosted_comment_mint_dispatch_conflict");
      }
      const changed = await mutateMint(transaction, "authorize_dispatch", {
        mintId: input.mintId,
        ownerIdHash: input.ownerIdHash,
        dispatchAuthorizedUntil: translateDeadline(
          databaseNow,
          input.now,
          input.dispatchAuthorizedUntil,
          60_000,
        ),
        unsafeUntil: translateDeadline(
          databaseNow,
          input.now,
          input.unsafeUntil,
          2 * 60 * 60_000,
        ),
      });
      if (changed.length !== 1)
        throw new Error("hosted_comment_mint_dispatch_conflict");
    }, transactionOptions);
  }

  async releasePrepared(
    input: Parameters<HostedCommentTokenMintLedgerPort["releasePrepared"]>[0],
  ) {
    await this.prisma.$transaction(async (transaction) => {
      const changed = await mutateMint(transaction, "release_prepared", {
        mintId: input.mintId,
        ownerIdHash: input.ownerIdHash,
        errorCode: input.errorCode,
      });
      if (changed.length !== 1)
        throw new Error("hosted_comment_mint_prepared_release_conflict");
    }, transactionOptions);
  }

  async confirmDispatch(
    input: Parameters<HostedCommentTokenMintLedgerPort["confirmDispatch"]>[0],
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await lockRuntimeGate(transaction);
      await lockAuthorityForMintId(transaction, input.mintId);
      const mint = await lockMint(transaction, input.mintId);
      const databaseNow = await readDatabaseNow(transaction);
      const authorized = await currentAuthority(transaction, mint, databaseNow);
      if (
        !authorized ||
        mint.state !== "dispatching" ||
        mint.ownerIdHash !== input.ownerIdHash ||
        mint.providerAttempt !== 1 ||
        !(mint.dispatchAuthorizedUntil instanceof Date) ||
        mint.dispatchAuthorizedUntil <= databaseNow
      )
        throw new Error("hosted_comment_mint_dispatch_authorization_expired");
      return {
        sendAuthorizedUntil: mint.dispatchAuthorizedUntil,
        remainingBudgetMs:
          mint.dispatchAuthorizedUntil.getTime() - databaseNow.getTime(),
      };
    }, transactionOptions);
  }

  async replayAuthorized(
    input: Parameters<HostedCommentTokenMintLedgerPort["replayAuthorized"]>[0],
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await lockRuntimeGate(transaction);
      await lockAuthorityForMintId(transaction, input.mintId);
      const mint = await lockMint(transaction, input.mintId);
      const databaseNow = await readDatabaseNow(transaction);
      const authorized = await currentAuthority(transaction, mint, databaseNow);
      await this.testHooks?.afterReplayAuthority?.();
      if (
        !authorized ||
        mint.state !== "issued" ||
        !(mint.tokenExpiresAt instanceof Date) ||
        mint.tokenExpiresAt <= databaseNow ||
        typeof mint.tokenHash !== "string"
      )
        throw new Error("hosted_comment_mint_replay_not_authorized");
      const secretEnvelope = await readSecretEnvelope(
        transaction,
        input.mintId,
      );
      if (!secretEnvelope)
        throw new Error("hosted_comment_mint_replay_secret_unavailable");
      return {
        tokenHash: mint.tokenHash as string,
        tokenExpiresAt: mint.tokenExpiresAt as Date,
        repositoryFullName: mint.repositoryFullName as string,
        workspaceId: mint.workspaceId as string,
        poolId: mint.poolId as string,
        secretEnvelope,
      };
    }, transactionOptions);
  }

  async confirmReplayDelivery(
    input: Parameters<
      HostedCommentTokenMintLedgerPort["confirmReplayDelivery"]
    >[0],
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await lockRuntimeGate(transaction);
      await lockAuthorityForMintId(transaction, input.mintId);
      const mint = await lockMint(transaction, input.mintId);
      const databaseNow = await readDatabaseNow(transaction);
      const authorized = await currentAuthority(transaction, mint, databaseNow);
      if (
        !authorized ||
        mint.state !== "issued" ||
        mint.tokenHash !== input.tokenHash ||
        !(mint.tokenExpiresAt instanceof Date) ||
        mint.tokenExpiresAt <= databaseNow
      )
        throw new Error("hosted_comment_mint_replay_not_authorized");
      const changed = await mutateMint(transaction, "claim_delivery", {
        mintId: input.mintId,
        tokenHash: input.tokenHash,
        deliveryClaimIdHash: input.deliveryClaimIdHash,
      });
      if (changed.length !== 1)
        throw new Error("hosted_comment_mint_replay_not_authorized");
    }, transactionOptions);
  }

  async releaseDelivery(
    input: Parameters<HostedCommentTokenMintLedgerPort["releaseDelivery"]>[0],
  ) {
    await this.prisma.$transaction(async (transaction) => {
      const changed = await mutateMint(transaction, "release_delivery", {
        mintId: input.mintId,
        tokenHash: input.tokenHash,
        deliveryClaimIdHash: input.deliveryClaimIdHash,
      });
      if (changed.length !== 1) {
        const observed =
          await transaction.hostedCodexCommentTokenMint.findUnique({
            where: { id: input.mintId },
            select: { deliveryClaimIdHash: true, state: true },
          });
        if (
          observed?.deliveryClaimIdHash !== null &&
          observed?.state !== "revoked" &&
          observed?.state !== "expired"
        )
          throw new Error("hosted_comment_mint_delivery_release_conflict");
      }
    }, transactionOptions);
  }

  async finalizeKnownToken(
    input: Parameters<
      HostedCommentTokenMintLedgerPort["finalizeKnownToken"]
    >[0],
  ) {
    const persistedEnvelope = copyEnvelope(input.secretEnvelope);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await lockRuntimeGate(transaction);
        await lockAuthorityForMintId(transaction, input.mintId);
        const mint = await lockMint(transaction, input.mintId);
        const databaseNow = await readDatabaseNow(transaction);
        const authorized = await currentAuthority(
          transaction,
          mint,
          databaseNow,
        );
        assertProviderExpiry(
          databaseNow,
          mint.unsafeUntil,
          input.tokenExpiresAt,
        );
        if (mint.state === "issued" && mint.tokenHash === input.tokenHash) {
          if (authorized) return "issued" as const;
          const changed = await mutateMint(
            transaction,
            "enqueue_issued_revocation",
            { mintId: input.mintId, tokenHash: input.tokenHash },
          );
          if (changed.length !== 1)
            throw new Error("hosted_comment_mint_finalize_conflict");
          return "revoke_pending" as const;
        }
        if (
          mint.state !== "dispatching" ||
          mint.ownerIdHash !== input.ownerIdHash ||
          mint.fenceEpoch !== input.fenceEpoch
        )
          return "revoke_pending" as const;
        const state = authorized ? "issued" : "revoke_pending";
        const changed = await mutateMint(transaction, "capture_known_token", {
          mintId: input.mintId,
          ownerIdHash: input.ownerIdHash,
          fenceEpoch: input.fenceEpoch,
          state,
          tokenHash: input.tokenHash,
          tokenExpiresAt: input.tokenExpiresAt,
          secretCiphertext: persistedEnvelope.ciphertext.toString("base64"),
          secretEncryptedDataKey:
            persistedEnvelope.encryptedDataKey.toString("base64"),
          secretIv: persistedEnvelope.iv.toString("base64"),
          secretAuthTag: persistedEnvelope.authTag.toString("base64"),
          secretKeyId: input.secretEnvelope.keyId,
          secretAadHash: input.secretEnvelope.aadHash,
        });
        if (changed.length !== 1) return "revoke_pending" as const;
        return state;
      }, transactionOptions);
    } finally {
      zeroEnvelope(persistedEnvelope);
    }
  }

  async stageRevocation(
    input: Parameters<HostedCommentTokenMintLedgerPort["stageRevocation"]>[0],
  ) {
    const persistedEnvelope = input.secretEnvelope
      ? copyEnvelope(input.secretEnvelope)
      : undefined;
    try {
      await this.prisma.$transaction(async (transaction) => {
        const databaseNow = await readDatabaseNow(transaction);
        const current = await lockMint(transaction, input.mintId);
        assertCustodyExpiry(databaseNow, input.tokenExpiresAt);
        const extendedUnsafeUntil = new Date(
          Math.max(
            current.unsafeUntil?.getTime() ?? 0,
            input.tokenExpiresAt.getTime() + 60_000,
          ),
        );
        const changed = await mutateMint(transaction, "stage_revocation", {
          mintId: input.mintId,
          tokenHash: input.tokenHash,
          tokenExpiresAt: input.tokenExpiresAt,
          unsafeUntil: extendedUnsafeUntil,
          ...(persistedEnvelope
            ? {
                secretCiphertext:
                  persistedEnvelope.ciphertext.toString("base64"),
                secretEncryptedDataKey:
                  persistedEnvelope.encryptedDataKey.toString("base64"),
                secretIv: persistedEnvelope.iv.toString("base64"),
                secretAuthTag: persistedEnvelope.authTag.toString("base64"),
                secretKeyId: persistedEnvelope.keyId,
                secretAadHash: persistedEnvelope.aadHash,
              }
            : {}),
          errorCode: input.errorCode,
        });
        if (changed.length !== 1)
          throw new Error("hosted_comment_mint_stage_revocation_conflict");
      }, transactionOptions);
    } finally {
      if (persistedEnvelope) zeroEnvelope(persistedEnvelope);
    }
  }
  async finalizeOutcomeUnknown(
    input: Parameters<
      HostedCommentTokenMintLedgerPort["finalizeOutcomeUnknown"]
    >[0],
  ) {
    await this.finish(input);
  }
  async claimRevocations(
    input: Parameters<HostedCommentTokenMintLedgerPort["claimRevocations"]>[0],
  ) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error("hosted_comment_mint_revocation_batch_invalid");
    return this.prisma.$transaction(async (transaction) => {
      await lockRuntimeGate(transaction);
      const gateRows = await transaction.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS "status" FROM "HostedCodexRuntimeGate"
        WHERE "id" = 'global'
      `;
      const gateStatus = gateRows[0]?.status;
      const databaseNow = await readDatabaseNow(transaction);
      if (gateStatus !== "closed" && gateStatus !== "active")
        throw new Error("hosted_comment_mint_runtime_gate_invalid");
      const rows = await mutateMint(
        transaction,
        "claim_revocations",
        {
          limit: input.limit,
          ownerIdHash: input.ownerIdHash,
          leaseExpiresAt: translateDeadline(
            databaseNow,
            input.now,
            input.leaseExpiresAt,
            5 * 60_000,
          ),
        },
        true,
      );
      try {
        return rows.map((mint) => ({
          mintId: mint.id as string,
          ownerIdHash: mint.ownerIdHash as string,
          fenceEpoch: mint.fenceEpoch as bigint,
          tokenHash: mint.tokenHash as string,
          tokenExpiresAt: mint.tokenExpiresAt as Date,
          repositoryFullName: mint.repositoryFullName as string,
          workspaceId: mint.workspaceId as string,
          poolId: mint.poolId as string,
          secretEnvelope: {
            ciphertext: Buffer.from(mint.secretCiphertext as Uint8Array),
            encryptedDataKey: Buffer.from(
              mint.secretEncryptedDataKey as Uint8Array,
            ),
            iv: Buffer.from(mint.secretIv as Uint8Array),
            authTag: Buffer.from(mint.secretAuthTag as Uint8Array),
            keyId: mint.secretKeyId as string,
            aadHash: mint.secretAadHash as string,
          },
        }));
      } finally {
        for (const row of rows) zeroMintRowSecretBuffers(row);
      }
    }, transactionOptions);
  }
  async releaseRevocation(
    input: Parameters<HostedCommentTokenMintLedgerPort["releaseRevocation"]>[0],
  ) {
    await this.prisma.$transaction(async (transaction) => {
      const changed = await mutateMint(transaction, "release_revocation", {
        mintId: input.mintId,
        ownerIdHash: input.ownerIdHash,
        fenceEpoch: input.fenceEpoch,
        errorCode: input.errorCode,
      });
      if (changed.length !== 1) {
        const observed =
          await transaction.hostedCodexCommentTokenMint.findUnique({
            where: { id: input.mintId },
            select: { state: true },
          });
        if (observed?.state !== "revoked" && observed?.state !== "expired")
          throw new Error("hosted_comment_mint_revocation_release_conflict");
      }
    }, transactionOptions);
  }
  async finalizeRevoked(
    input: Parameters<HostedCommentTokenMintLedgerPort["finalizeRevoked"]>[0],
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<
        Array<{ hosted_codex_finalize_comment_token_revocation: boolean }>
      >`
        SELECT hosted_codex_finalize_comment_token_revocation(
          ${input.mintId}, ${input.tokenHash}, ${input.evidenceHash},
          ${input.ownerIdHash}, ${input.fenceEpoch},
          ${input.receipt.authority}, ${input.receipt.result}
        )
      `;
    }, transactionOptions);
  }
  async observe(
    input: Parameters<HostedCommentTokenMintLedgerPort["observe"]>[0],
  ) {
    const mint = await this.prisma.hostedCodexCommentTokenMint.findUnique({
      where: { id: input.mintId },
      select: {
        state: true,
        tokenHash: true,
      },
    });
    if (!mint) return null;
    return {
      state: mint.state,
      tokenHash: mint.tokenHash,
    };
  }
  private async finish(input: {
    mintId: string;
    ownerIdHash: string;
    now: Date;
    errorCode: string;
    unsafeUntil?: Date;
  }) {
    await this.prisma.$transaction(async (transaction) => {
      const current = input.unsafeUntil
        ? await lockMint(transaction, input.mintId)
        : null;
      const changed = await mutateMint(transaction, "outcome_unknown", {
        mintId: input.mintId,
        ownerIdHash: input.ownerIdHash,
        errorCode: input.errorCode,
        unsafeUntil: input.unsafeUntil
          ? new Date(
              Math.max(
                current?.unsafeUntil?.getTime() ?? 0,
                input.unsafeUntil.getTime(),
              ),
            )
          : null,
      });
      if (changed.length !== 1) {
        const observed =
          await transaction.hostedCodexCommentTokenMint.findUnique({
            where: { id: input.mintId },
            select: { state: true },
          });
        if (observed?.state !== "outcome_unknown")
          throw new Error("hosted_comment_mint_finalize_conflict");
      }
    }, transactionOptions);
  }
}

async function mutateMint(
  transaction: Prisma.TransactionClient,
  operation: string,
  arguments_: Record<string, unknown>,
  retainSecretBuffers = false,
): Promise<any[]> {
  const serialized = JSON.stringify(arguments_, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const rows = retainSecretBuffers
    ? await transaction.$queryRaw<any[]>`
        SELECT "id", "ownerIdHash", "fenceEpoch", "tokenHash", "tokenExpiresAt",
          "repositoryFullName", "workspaceId", "poolId", "secretCiphertext",
          "secretEncryptedDataKey", "secretIv", "secretAuthTag", "secretKeyId",
          "secretAadHash"
        FROM hosted_codex_mutate_comment_token_mint(
          ${operation}, ${serialized}::jsonb
        )
      `
    : await transaction.$queryRaw<any[]>`
        SELECT "id", "purpose", "state", "providerAttempt", "ownerIdHash",
          "fenceEpoch", "grantId", "capabilityId", "logicalKeyHash",
          "requestFingerprintHash", "requestIdHash", "presentedTokenHash",
          "runtimeAuthzEpoch", "runtimeGateRevision", "workspaceId",
          "repositoryBindingId", "bindingRevision", "bindingStateVersion",
          "poolId", "poolRevision", "poolAuthzEpoch", "repositoryConnectionId",
          "repositoryUpdatedAt", "githubInstallationRowId", "installationUpdatedAt",
          "installationStatus", "installationSelection", "installationWorkspaceId",
          "githubInstallationId", "githubRepositoryId", "repositoryFullName",
          "leaseExpiresAt", "dispatchAuthorizedUntil", "unsafeUntil", "tokenHash",
          "tokenExpiresAt", "deliveryClaimIdHash"
        FROM hosted_codex_mutate_comment_token_mint(
          ${operation}, ${serialized}::jsonb
        )
      `;
  if (!retainSecretBuffers) {
    for (const row of rows) zeroMintRowSecretBuffers(row);
  }
  return rows;
}

function zeroMintRowSecretBuffers(row: Record<string, unknown>): void {
  for (const key of [
    "secretCiphertext",
    "secretEncryptedDataKey",
    "secretIv",
    "secretAuthTag",
  ]) {
    const value = row[key];
    if (value instanceof Uint8Array) value.fill(0);
  }
}

function assertCustodyExpiry(databaseNow: Date, tokenExpiresAt: Date) {
  if (
    !Number.isFinite(tokenExpiresAt.getTime()) ||
    tokenExpiresAt <= databaseNow
  )
    throw new Error("hosted_comment_mint_provider_expiry_invalid");
}

function assertProviderExpiry(
  databaseNow: Date,
  unsafeUntil: Date | null,
  tokenExpiresAt: Date,
) {
  if (
    !(unsafeUntil instanceof Date) ||
    !Number.isFinite(tokenExpiresAt.getTime()) ||
    tokenExpiresAt <= databaseNow ||
    tokenExpiresAt.getTime() > databaseNow.getTime() + 61 * 60_000 ||
    tokenExpiresAt > unsafeUntil
  )
    throw new Error("hosted_comment_mint_provider_expiry_invalid");
}

function prepared(mint: any): PreparedHostedCommentTokenMint {
  return {
    mintId: mint.id,
    state: "prepared",
    fenceEpoch: mint.fenceEpoch,
    runtimeAuthzEpoch: mint.runtimeAuthzEpoch,
    runtimeGateRevision: mint.runtimeGateRevision,
    githubInstallationId: mint.githubInstallationId.toString(),
    githubRepositoryId: mint.githubRepositoryId.toString(),
    repositoryFullName: mint.repositoryFullName,
    workspaceId: mint.workspaceId,
    poolId: mint.poolId,
  };
}
function assertAuthority(
  authority: AuthoritySnapshot,
  input: Parameters<HostedCommentTokenMintLedgerPort["prepare"]>[0],
  databaseNow: Date,
) {
  const refreshInvalid =
    input.purpose === "refresh" &&
    (!authority.capabilityId ||
      authority.capabilityTokenHash !== input.presentedTokenHash ||
      !input.requestIdHash ||
      !input.presentedTokenHash);
  if (
    authority.gateStatus !== "active" ||
    authority.grantStatus !== "issued" ||
    authority.grantRevokedAt !== null ||
    authority.grantExpiresAt <= databaseNow ||
    authority.grantRuntimeAuthzEpoch !== authority.runtimeAuthzEpoch ||
    authority.bindingId !== input.bindingId ||
    authority.bindingRevision !== BigInt(input.bindingVersion) ||
    authority.grantBindingRevision !== authority.bindingRevision ||
    authority.bindingStatus !== "active" ||
    authority.attestedGithubRepositoryId !== authority.githubRepositoryId ||
    authority.poolStatus !== "active" ||
    authority.poolAuthzEpoch !== authority.grantAuthzEpoch ||
    authority.repositoryProvider !== "github" ||
    !authority.repositorySelected ||
    authority.repositoryArchived ||
    !["private", "internal"].includes(authority.repositoryVisibility) ||
    !authority.githubRepositoryId ||
    !authority.installationRowId ||
    authority.installationStatus !== "active" ||
    !["all", "selected"].includes(authority.installationSelection ?? "") ||
    !authority.installationUpdatedAt ||
    authority.installationWorkspaceId !== authority.workspaceId ||
    !authority.githubInstallationId ||
    refreshInvalid
  )
    throw authorityMismatch();
}
function assertAttemptSnapshot(mint: any, authority: AuthoritySnapshot) {
  if (
    mint.runtimeAuthzEpoch !== authority.runtimeAuthzEpoch ||
    mint.runtimeGateRevision !== authority.runtimeGateRevision ||
    mint.bindingRevision !== authority.bindingRevision ||
    mint.bindingStateVersion !== authority.bindingStateVersion ||
    mint.poolRevision !== authority.poolRevision ||
    mint.poolAuthzEpoch !== authority.poolAuthzEpoch ||
    mint.repositoryUpdatedAt.getTime() !==
      authority.repositoryUpdatedAt.getTime() ||
    mint.installationUpdatedAt.getTime() !==
      authority.installationUpdatedAt?.getTime() ||
    mint.installationStatus !== authority.installationStatus ||
    mint.installationSelection !== authority.installationSelection ||
    mint.installationWorkspaceId !== authority.installationWorkspaceId ||
    mint.githubInstallationRowId !== authority.installationRowId ||
    mint.githubInstallationId !== authority.githubInstallationId ||
    mint.githubRepositoryId !== authority.githubRepositoryId ||
    mint.repositoryFullName !== authority.repositoryFullName
  )
    throw authorityMismatch();
}
function authorityMismatch() {
  return new Error("hosted_comment_mint_authority_mismatch");
}
function isPrismaUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}
async function lockMint(
  transaction: Prisma.TransactionClient,
  id: string,
): Promise<any> {
  const mint = await tryLockMint(transaction, id);
  if (!mint) throw new Error("hosted_comment_mint_missing");
  return mint;
}

async function tryLockMint(
  transaction: Prisma.TransactionClient,
  id: string,
): Promise<any | null> {
  const locked = await transaction.$queryRaw<Array<{ locked: boolean }>>`
    SELECT hosted_codex_lock_comment_token_mint(${id}) AS "locked"
  `;
  if (locked[0]?.locked !== true) return null;
  const mint = await transaction.hostedCodexCommentTokenMint.findUnique({
    where: { id },
    select: mintNonSecretProjection,
  });
  if (!mint) throw new Error("hosted_comment_mint_missing");
  return mint;
}

const mintNonSecretProjection = {
  id: true,
  purpose: true,
  state: true,
  providerAttempt: true,
  ownerIdHash: true,
  fenceEpoch: true,
  grantId: true,
  capabilityId: true,
  logicalKeyHash: true,
  requestFingerprintHash: true,
  requestIdHash: true,
  presentedTokenHash: true,
  runtimeAuthzEpoch: true,
  runtimeGateRevision: true,
  workspaceId: true,
  repositoryBindingId: true,
  bindingRevision: true,
  bindingStateVersion: true,
  poolId: true,
  poolRevision: true,
  poolAuthzEpoch: true,
  repositoryConnectionId: true,
  repositoryUpdatedAt: true,
  githubInstallationRowId: true,
  installationUpdatedAt: true,
  installationStatus: true,
  installationSelection: true,
  installationWorkspaceId: true,
  githubInstallationId: true,
  githubRepositoryId: true,
  repositoryFullName: true,
  leaseExpiresAt: true,
  dispatchAuthorizedUntil: true,
  unsafeUntil: true,
  tokenHash: true,
  tokenExpiresAt: true,
  deliveryClaimIdHash: true,
} as const;

async function readSecretEnvelope(
  transaction: Prisma.TransactionClient,
  mintId: string,
) {
  const loaded = await transaction.hostedCodexCommentTokenMint.findUnique({
    where: { id: mintId },
    select: {
      secretCiphertext: true,
      secretEncryptedDataKey: true,
      secretIv: true,
      secretAuthTag: true,
      secretKeyId: true,
      secretAadHash: true,
    },
  });
  try {
    if (
      !loaded?.secretCiphertext ||
      !loaded.secretEncryptedDataKey ||
      !loaded.secretIv ||
      !loaded.secretAuthTag ||
      !loaded.secretKeyId ||
      !loaded.secretAadHash
    )
      return null;
    return {
      ciphertext: Buffer.from(loaded.secretCiphertext),
      encryptedDataKey: Buffer.from(loaded.secretEncryptedDataKey),
      iv: Buffer.from(loaded.secretIv),
      authTag: Buffer.from(loaded.secretAuthTag),
      keyId: loaded.secretKeyId,
      aadHash: loaded.secretAadHash,
    };
  } finally {
    loaded?.secretCiphertext?.fill(0);
    loaded?.secretEncryptedDataKey?.fill(0);
    loaded?.secretIv?.fill(0);
    loaded?.secretAuthTag?.fill(0);
  }
}
async function lockRuntimeGate(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT public.hosted_codex_lock_comment_token_runtime_gate() IS NULL AS "locked"
  `;
}

async function readAuthoritySnapshot(
  transaction: Prisma.TransactionClient,
  grantId: string,
): Promise<AuthoritySnapshot[]> {
  return transaction.$queryRaw<AuthoritySnapshot[]>`
    SELECT * FROM public.hosted_codex_comment_token_authority_snapshot(${grantId})
  `;
}
async function readDatabaseNow(
  transaction: Prisma.TransactionClient,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error("hosted_comment_mint_database_time_invalid");
  return now;
}

function translateDeadline(
  databaseNow: Date,
  callerNow: Date,
  callerDeadline: Date,
  maximumDurationMs: number,
): Date {
  const durationMs = callerDeadline.getTime() - callerNow.getTime();
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > maximumDurationMs
  )
    throw new Error("hosted_comment_mint_deadline_invalid");
  return new Date(databaseNow.getTime() + durationMs);
}

function copyEnvelope(envelope: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
  aadHash: string;
}) {
  return {
    ciphertext: Buffer.from(envelope.ciphertext),
    encryptedDataKey: Buffer.from(envelope.encryptedDataKey),
    iv: Buffer.from(envelope.iv),
    authTag: Buffer.from(envelope.authTag),
    keyId: envelope.keyId,
    aadHash: envelope.aadHash,
  };
}

function zeroEnvelope(envelope: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}) {
  envelope.ciphertext.fill(0);
  envelope.encryptedDataKey.fill(0);
  envelope.iv.fill(0);
  envelope.authTag.fill(0);
}
async function currentAuthority(
  transaction: Prisma.TransactionClient,
  mint: any,
  databaseNow: Date,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ valid: boolean }>>`
    SELECT TRUE AS "valid" FROM "HostedCodexRuntimeGate" gate
    JOIN "GitHubInstallation" installation ON installation."id" = ${mint.githubInstallationRowId}
    JOIN "RepositoryConnection" repository ON repository."id" = ${mint.repositoryConnectionId}
    JOIN "HostedCodexPool" pool ON pool."id" = ${mint.poolId}
    JOIN "HostedCodexRepositoryBinding" binding ON binding."id" = ${mint.repositoryBindingId}
    JOIN "HostedCodexInvocationGrant" invocation_grant ON invocation_grant."id" = ${mint.grantId}
    WHERE gate."id" = 'global' AND gate."status" = 'active' AND gate."authzEpoch" = ${mint.runtimeAuthzEpoch} AND gate."revision" = ${mint.runtimeGateRevision}
      AND invocation_grant."status" = 'issued' AND invocation_grant."revokedAt" IS NULL AND invocation_grant."expiresAt" > ${databaseNow}
      AND invocation_grant."runtimeAuthzEpoch" = ${mint.runtimeAuthzEpoch} AND invocation_grant."bindingRevision" = ${mint.bindingRevision}
      AND invocation_grant."workspaceId" = ${mint.workspaceId} AND invocation_grant."poolId" = ${mint.poolId} AND invocation_grant."repositoryConnectionId" = ${mint.repositoryConnectionId}
      AND binding."status" = 'active' AND binding."revision" = ${mint.bindingRevision} AND binding."stateVersion" = ${mint.bindingStateVersion}
      AND binding."attestedGithubRepositoryId" = ${mint.githubRepositoryId}
      AND binding."workspaceId" = ${mint.workspaceId} AND binding."poolId" = ${mint.poolId} AND binding."repositoryConnectionId" = ${mint.repositoryConnectionId}
      AND pool."status" = 'active' AND pool."revision" = ${mint.poolRevision} AND pool."authzEpoch" = ${mint.poolAuthzEpoch}
      AND repository."updatedAt" = ${mint.repositoryUpdatedAt} AND repository."provider" = 'github' AND repository."selected"
      AND NOT repository."archived" AND repository."visibility" IN ('private','internal')
      AND repository."githubRepositoryId" = ${mint.githubRepositoryId} AND repository."fullName" = ${mint.repositoryFullName}
      AND repository."installationId" = ${mint.githubInstallationRowId}
      AND installation."updatedAt" = ${mint.installationUpdatedAt}
      AND installation."status"::text = ${mint.installationStatus}
      AND installation."repositorySelection" = ${mint.installationSelection}
      AND installation."workspaceId" = ${mint.installationWorkspaceId}
      AND installation."status" = 'active'
      AND installation."repositorySelection" IN ('all','selected')
      AND installation."workspaceId" = ${mint.workspaceId}
      AND installation."githubInstallationId" = ${mint.githubInstallationId}
  `;
  if (rows.length !== 1) return false;
  if (mint.purpose === "initial") return true;
  const refreshRows = await transaction.$queryRaw<Array<{ valid: boolean }>>`
    SELECT TRUE AS "valid"
    FROM "HostedCodexCommentRefreshCapability" capability
    JOIN "HostedCodexCommentRefreshUse" refresh_use
      ON refresh_use."mintId" = ${mint.id}
    WHERE capability."id" = ${mint.capabilityId}
      AND capability."grantId" = ${mint.grantId}
      AND capability."workspaceId" = ${mint.workspaceId}
      AND capability."poolId" = ${mint.poolId}
      AND capability."repositoryBindingId" = ${mint.repositoryBindingId}
      AND capability."repositoryConnectionId" = ${mint.repositoryConnectionId}
      AND capability."capabilityTokenHash" = ${mint.presentedTokenHash}
      AND capability."revokedAt" IS NULL
      AND capability."expiresAt" > ${databaseNow}
      AND refresh_use."capabilityId" = capability."id"
      AND refresh_use."grantId" = ${mint.grantId}
      AND refresh_use."requestIdHash" = ${mint.requestIdHash}
      AND refresh_use."presentedTokenHash" = ${mint.presentedTokenHash}
    FOR SHARE OF capability
  `;
  return refreshRows.length === 1;
}

async function lockAuthorityForMintId(
  transaction: Prisma.TransactionClient,
  mintId: string,
): Promise<void> {
  const identity = await transaction.hostedCodexCommentTokenMint.findUnique({
    where: { id: mintId },
    select: { grantId: true, purpose: true, capabilityId: true },
  });
  if (!identity) throw new Error("hosted_comment_mint_missing");
  const rows = await readAuthoritySnapshot(transaction, identity.grantId);
  if (rows.length !== 1) throw authorityMismatch();
  if (identity.purpose === "refresh") {
    const capability = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "HostedCodexCommentRefreshCapability"
      WHERE "id" = ${identity.capabilityId}
      FOR SHARE
    `;
    if (capability.length !== 1) throw authorityMismatch();
  }
}
