import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { HostedCodexSessionPersistencePort } from "../runtime/hosted-codex-session-runtime";
import {
  CredentialEnvelopeVault,
  type EncryptedCredentialEnvelope,
} from "../crypto/credential-envelope-vault";
import { fingerprintCodexAuthJson } from "../security/codex-account-identity.js";
import {
  isHostedAccountTransactionWriteConflict,
  normalizeExpiredHostedAccountCooldownWithCas,
} from "./prisma-hosted-account-cooldown.js";
import { hostedCodexMutationLeaseAuthority } from "./prisma-hosted-codex-mutation-fence.js";

export class PrismaHostedCodexSessionPersistence implements HostedCodexSessionPersistencePort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly vault: CredentialEnvelopeVault,
    private readonly databaseIncarnation: string,
    private readonly databaseResourceIdentity: string,
    private readonly fingerprintPepper: Uint8Array,
    private readonly productionKmsKeyArn?: string,
  ) {
    if (!databaseIncarnation.trim()) {
      throw new Error("hosted_codex_database_incarnation_missing");
    }
    if (databaseResourceIdentity.trim().length < 16) {
      throw new Error("hosted_codex_database_resource_identity_invalid");
    }
    if (fingerprintPepper.byteLength < 32) {
      throw new Error("hosted_codex_fingerprint_pepper_invalid");
    }
  }

  async read(accountId: string) {
    let account:
      | Awaited<ReturnType<typeof this.readAccountSnapshot>>
      | undefined;
    let lastConflict: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await normalizeExpiredHostedAccountCooldownWithCas(this.prisma, {
        accountId,
        now: new Date(),
      });
      try {
        account = await this.readAccountSnapshot(accountId);
        break;
      } catch (error) {
        if (!isHostedAccountTransactionWriteConflict(error)) throw error;
        lastConflict = error;
      }
    }
    if (account === undefined) throw lastConflict;
    const credential = account?.credentialVersions[0];
    if (!account || !credential || account.activeGeneration === null)
      return null;
    if (account.state !== "healthy") {
      throw new Error("hosted_codex_account_not_servable");
    }
    if (credential.generation !== account.activeGeneration) {
      throw new Error("hosted_codex_active_generation_corrupt");
    }
    const persistedEnvelope = credential.envelopeRevisions[0];
    if (!persistedEnvelope || persistedEnvelope.custodyMode === "legacy_env") {
      throw new Error("hosted_codex_credential_custody_uncertified");
    }
    if (
      persistedEnvelope.databaseResourceIdentity !==
      this.databaseResourceIdentity
    ) {
      throw new Error("hosted_codex_database_resource_identity_mismatch");
    }
    if (persistedEnvelope.databaseIncarnation !== this.databaseIncarnation) {
      throw new Error("hosted_codex_database_incarnation_mismatch");
    }
    if (
      this.productionKmsKeyArn &&
      (persistedEnvelope.custodyMode !== "aws_kms" ||
        persistedEnvelope.kmsKeyArn !== this.productionKmsKeyArn ||
        credential.keyId !== this.productionKmsKeyArn)
    ) {
      throw new Error("hosted_codex_kms_resource_binding_mismatch");
    }
    const envelope = restoreEnvelope({
      ...persistedEnvelope,
      keyId: persistedEnvelope.kmsKeyArn ?? credential.keyId,
    });
    const authJsonBytes = await this.vault.decrypt(envelope, {
      workspaceId: account.workspaceId,
      poolId: account.poolId,
      accountId: account.id,
      generation: toSafeNumber(credential.generation),
      databaseIncarnation: this.databaseIncarnation,
      databaseResourceIdentity: this.databaseResourceIdentity,
    });
    return {
      accountId: account.id,
      authJsonBytes,
      generation: toSafeNumber(credential.generation),
      generationHash: credential.generationHash,
      storageVersion: `hosted-envelope-v${credential.envelopeVersion}`,
    };
  }

  private readAccountSnapshot(accountId: string) {
    // Prisma may materialize relations with more than one SQL statement. A
    // repeatable-read snapshot prevents observing activeGeneration from a CAS
    // commit while still observing the predecessor credential generation.
    return this.prisma.$transaction(
      (transaction) =>
        transaction.hostedCodexAccount.findUnique({
          where: { id: accountId },
          include: {
            credentialVersions: {
              orderBy: { generation: "desc" },
              take: 1,
              include: {
                envelopeRevisions: { orderBy: { revision: "desc" }, take: 1 },
              },
            },
          },
        }),
      {
        isolationLevel: "RepeatableRead",
        maxWait: 15_000,
        timeout: 15_000,
      },
    );
  }

  async compareAndSwap(input: {
    readonly accountId: string;
    readonly expectedGeneration: number;
    readonly nextAuthJsonBytes: Uint8Array;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }) {
    const nextGeneration = input.expectedGeneration + 1;
    const leaseAuthority = hostedCodexMutationLeaseAuthority(input.leaseId);
    if (leaseAuthority.accountId !== input.accountId) {
      throw new Error("hosted_codex_mutation_fence_invalid");
    }
    const receiptHash = sha256(
      `${input.accountId}\u0000${input.leaseId}\u0000${input.idempotencyKey}\u0000${nextGeneration}`,
    );
    const replay = await this.findAuthorizedReplay(receiptHash, leaseAuthority);
    if (replay) {
      return {
        status: "idempotent_replay" as const,
        generation: toSafeNumber(replay.generation),
        generationHash: replay.credentialVersion.generationHash,
      };
    }
    const account = await this.prisma.hostedCodexAccount.findUnique({
      where: { id: input.accountId },
    });
    if (!account || account.activeGeneration === null) {
      throw new Error("hosted_codex_account_not_found");
    }
    if (account.activeGeneration !== BigInt(input.expectedGeneration)) {
      return this.staleResult(account.id, account.activeGeneration);
    }
    const nextFingerprint = fingerprintCodexAuthJson(
      input.nextAuthJsonBytes,
      this.fingerprintPepper,
    );
    if (nextFingerprint !== account.accountFingerprint) {
      await this.prisma.$transaction(async (transaction) => {
        await lockMutationFence(transaction, {
          accountId: input.accountId,
          expectedGeneration: input.expectedGeneration,
          leaseAuthority,
        });
        const quarantined = await transaction.hostedCodexAccount.updateMany({
          where: {
            id: account.id,
            accountFingerprint: account.accountFingerprint,
            activeGeneration: BigInt(input.expectedGeneration),
          },
          data: {
            state: "restore_quarantined",
            healthVersion: { increment: 1 },
          },
        });
        if (quarantined.count !== 1) {
          throw new Error("hosted_codex_auth_generation_conflict");
        }
      });
      throw new Error("hosted_codex_account_identity_drift");
    }
    const envelope = await this.vault.encrypt(input.nextAuthJsonBytes, {
      workspaceId: account.workspaceId,
      poolId: account.poolId,
      accountId: account.id,
      generation: nextGeneration,
      databaseIncarnation: this.databaseIncarnation,
      databaseResourceIdentity: this.databaseResourceIdentity,
    });
    try {
      await this.prisma.$transaction(async (transaction) => {
        const fence = await lockMutationFence(transaction, {
          accountId: input.accountId,
          expectedGeneration: input.expectedGeneration,
          leaseAuthority,
        });
        const previousReceipt =
          await transaction.hostedCodexGenerationReceipt.findFirst({
            where: {
              accountId: account.id,
              generation: BigInt(input.expectedGeneration),
              kind: "activated",
            },
            orderBy: { occurredAt: "desc" },
          });
        if (!previousReceipt) {
          throw new Error("hosted_codex_generation_receipt_chain_missing");
        }
        const version = await transaction.hostedCodexCredentialVersion.create({
          data: {
            workspaceId: account.workspaceId,
            poolId: account.poolId,
            accountId: account.id,
            generation: BigInt(nextGeneration),
            envelopeVersion: envelope.schemaVersion,
            encryptionAlgorithm: envelope.encryptionAlgorithm,
            keyId: envelope.keyId,
            aadHash: envelope.associatedDataHash,
            ciphertextHash: envelope.ciphertextHash,
            generationHash: input.nextGenerationHash,
            encryptedCiphertext: envelope.ciphertext,
            databaseIncarnation: this.databaseIncarnation,
            credentialExpiresAt: null,
            envelopeMetadata: {
              nonce: envelope.nonce,
              authenticationTag: envelope.authenticationTag,
              wrappedDataEncryptionKey: envelope.wrappedDataEncryptionKey,
            },
          },
        });
        const kmsKeyArn = isImmutableKmsKeyArn(envelope.keyId)
          ? envelope.keyId
          : null;
        if (
          this.productionKmsKeyArn &&
          kmsKeyArn !== this.productionKmsKeyArn
        ) {
          throw new Error("hosted_codex_kms_resource_binding_mismatch");
        }
        await transaction.hostedCodexCredentialEnvelopeRevision.create({
          data: {
            id: randomUUID(),
            credentialVersionId: version.id,
            accountId: account.id,
            workspaceId: account.workspaceId,
            poolId: account.poolId,
            generation: BigInt(nextGeneration),
            revision: 1n,
            custodyMode: kmsKeyArn ? "aws_kms" : "local_test",
            kmsKeyArn,
            kmsContextVersion: 1,
            databaseResourceIdentity: this.databaseResourceIdentity,
            databaseIncarnation: this.databaseIncarnation,
            reason: "refresh",
            envelopeVersion: envelope.schemaVersion,
            encryptionAlgorithm: envelope.encryptionAlgorithm,
            aadHash: envelope.associatedDataHash,
            ciphertextHash: envelope.ciphertextHash,
            encryptedCiphertext: envelope.ciphertext,
            envelopeMetadata: {
              nonce: envelope.nonce,
              authenticationTag: envelope.authenticationTag,
              wrappedDataEncryptionKey: envelope.wrappedDataEncryptionKey,
            },
            fenceOwnerIdHash: fence.ownerIdHash,
            fenceEpoch: fence.fenceEpoch,
            actorIdHash: fence.ownerIdHash!,
            idempotencyKeyHash: sha256(
              `refresh\u0000${account.id}\u0000${nextGeneration}\u0000${receiptHash}`,
            ),
          },
        });
        const updated = await transaction.hostedCodexAccount.updateMany({
          where: {
            id: account.id,
            activeGeneration: BigInt(input.expectedGeneration),
          },
          data: {
            activeGeneration: BigInt(nextGeneration),
            state: "healthy",
            healthVersion: { increment: 1 },
            lastHealthyAt: new Date(),
          },
        });
        if (updated.count !== 1) {
          throw new Error("hosted_codex_auth_generation_conflict");
        }
        await transaction.hostedCodexGenerationReceipt.create({
          data: {
            credentialVersionId: version.id,
            accountId: account.id,
            workspaceId: account.workspaceId,
            poolId: account.poolId,
            generation: BigInt(nextGeneration),
            kind: "activated",
            mutationFenceEpoch: fence.fenceEpoch,
            actorIdHash: fence.ownerIdHash!,
            receiptHash,
            previousReceiptHash: previousReceipt.receiptHash,
          },
        });
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        const committed = await this.findAuthorizedReplay(
          receiptHash,
          leaseAuthority,
        );
        if (committed) {
          return {
            status: "idempotent_replay" as const,
            generation: toSafeNumber(committed.generation),
            generationHash: committed.credentialVersion.generationHash,
          };
        }
      }
      if (
        error instanceof Error &&
        error.message === "hosted_codex_auth_generation_conflict"
      ) {
        const current = await this.prisma.hostedCodexAccount.findUniqueOrThrow({
          where: { id: input.accountId },
        });
        return this.staleResult(current.id, current.activeGeneration ?? 0n);
      }
      throw error;
    }
    return {
      status: "accepted" as const,
      generation: nextGeneration,
      generationHash: input.nextGenerationHash,
    };
  }

  private findAuthorizedReplay(
    receiptHash: string,
    leaseAuthority: ReturnType<typeof hostedCodexMutationLeaseAuthority>,
  ) {
    return this.prisma.$transaction(
      async (transaction) => {
        const receipt =
          await transaction.hostedCodexGenerationReceipt.findUnique({
            where: { receiptHash },
            include: { credentialVersion: true },
          });
        if (!receipt) return null;
        if (
          receipt.accountId !== leaseAuthority.accountId ||
          receipt.actorIdHash !== leaseAuthority.ownerIdHash ||
          receipt.mutationFenceEpoch !== leaseAuthority.fenceEpoch
        ) {
          throw new Error("hosted_codex_mutation_fence_invalid");
        }
        const currentFence =
          await transaction.hostedCodexMutationFence.findUnique({
            where: { accountId: leaseAuthority.accountId },
          });
        if (
          currentFence &&
          (currentFence.fenceEpoch !== leaseAuthority.fenceEpoch ||
            (currentFence.ownerIdHash !== null &&
              (currentFence.ownerIdHash !== leaseAuthority.ownerIdHash ||
                !currentFence.expiresAt ||
                currentFence.expiresAt <= new Date())))
        ) {
          throw new Error("hosted_codex_mutation_fence_invalid");
        }
        return receipt;
      },
      { isolationLevel: "Serializable" },
    );
  }

  private async staleResult(accountId: string, generation: bigint) {
    const credential =
      await this.prisma.hostedCodexCredentialVersion.findUnique({
        where: {
          accountId_generation: { accountId, generation },
        },
      });
    return {
      status: "stale_generation" as const,
      currentGeneration: toSafeNumber(generation),
      currentGenerationHash: credential?.generationHash ?? "unknown",
    };
  }
}

function restoreEnvelope(credential: {
  readonly envelopeVersion: number;
  readonly encryptionAlgorithm: string;
  readonly keyId: string;
  readonly aadHash: string;
  readonly ciphertextHash: string;
  readonly encryptedCiphertext: string;
  readonly envelopeMetadata: unknown;
}): EncryptedCredentialEnvelope {
  const metadata =
    credential.envelopeMetadata as Partial<EncryptedCredentialEnvelope>;
  if (
    credential.envelopeVersion !== 1 ||
    credential.encryptionAlgorithm !== "aes-256-gcm" ||
    typeof metadata.nonce !== "string" ||
    typeof metadata.authenticationTag !== "string" ||
    !metadata.wrappedDataEncryptionKey
  ) {
    throw new Error("hosted_codex_envelope_metadata_invalid");
  }
  return {
    schemaVersion: 1,
    encryptionAlgorithm: "aes-256-gcm",
    keyId: credential.keyId,
    nonce: metadata.nonce,
    authenticationTag: metadata.authenticationTag,
    ciphertext: credential.encryptedCiphertext,
    wrappedDataEncryptionKey: metadata.wrappedDataEncryptionKey,
    associatedDataHash: credential.aadHash,
    ciphertextHash: credential.ciphertextHash,
  };
}

async function lockMutationFence(
  transaction: Prisma.TransactionClient,
  input: {
    readonly accountId: string;
    readonly expectedGeneration: number;
    readonly leaseAuthority: ReturnType<
      typeof hostedCodexMutationLeaseAuthority
    >;
  },
) {
  const fence = await transaction.hostedCodexMutationFence.findUnique({
    where: { accountId: input.accountId },
  });
  if (!fence) throw new Error("hosted_codex_mutation_fence_invalid");
  const locked = await transaction.hostedCodexMutationFence.updateMany({
    where: {
      accountId: input.accountId,
      expectedGeneration: BigInt(input.expectedGeneration),
      ownerIdHash: input.leaseAuthority.ownerIdHash,
      fenceEpoch: input.leaseAuthority.fenceEpoch,
      expiresAt: { gt: new Date() },
    },
    // This deliberate no-op update turns all caller terms into a row-level CAS
    // lock held through the credential/account/receipt transaction.
    data: { expiresAt: fence.expiresAt! },
  });
  if (locked.count !== 1) {
    throw new Error("hosted_codex_mutation_fence_invalid");
  }
  return fence;
}

function isImmutableKmsKeyArn(value: string): boolean {
  return /^arn:(?:aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/iu.test(
    value,
  );
}

function toSafeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("hosted_codex_generation_out_of_range");
  }
  return number;
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
