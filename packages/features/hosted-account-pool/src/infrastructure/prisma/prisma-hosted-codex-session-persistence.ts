import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { HostedCodexSessionPersistencePort } from "../runtime/hosted-codex-session-runtime";
import {
  CredentialEnvelopeVault,
  type EncryptedCredentialEnvelope,
} from "../crypto/credential-envelope-vault";
import { fingerprintCodexAuthJson } from "../security/codex-account-identity.js";

export class PrismaHostedCodexSessionPersistence implements HostedCodexSessionPersistencePort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly vault: CredentialEnvelopeVault,
    private readonly databaseIncarnation: string,
    private readonly fingerprintPepper: Uint8Array,
  ) {
    if (!databaseIncarnation.trim()) {
      throw new Error("hosted_codex_database_incarnation_missing");
    }
    if (fingerprintPepper.byteLength < 32) {
      throw new Error("hosted_codex_fingerprint_pepper_invalid");
    }
  }

  async read(accountId: string) {
    const account = await this.prisma.hostedCodexAccount.findUnique({
      where: { id: accountId },
      include: {
        credentialVersions: { orderBy: { generation: "desc" }, take: 1 },
      },
    });
    const credential = account?.credentialVersions[0];
    if (!account || !credential || account.activeGeneration === null)
      return null;
    if (credential.generation !== account.activeGeneration) {
      throw new Error("hosted_codex_active_generation_corrupt");
    }
    if (credential.databaseIncarnation !== this.databaseIncarnation) {
      throw new Error("hosted_codex_database_incarnation_mismatch");
    }
    const envelope = restoreEnvelope(credential);
    const authJsonBytes = await this.vault.decrypt(envelope, {
      workspaceId: account.workspaceId,
      poolId: account.poolId,
      accountId: account.id,
      generation: toSafeNumber(credential.generation),
      databaseIncarnation: this.databaseIncarnation,
    });
    return {
      accountId: account.id,
      authJsonBytes,
      generation: toSafeNumber(credential.generation),
      generationHash: credential.generationHash,
      storageVersion: `hosted-envelope-v${credential.envelopeVersion}`,
    };
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
    const receiptHash = sha256(
      `${input.accountId}\u0000${input.leaseId}\u0000${input.idempotencyKey}\u0000${nextGeneration}`,
    );
    const replay = await this.prisma.hostedCodexGenerationReceipt.findUnique({
      where: { receiptHash },
      include: { credentialVersion: true },
    });
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
      await this.prisma.hostedCodexAccount.updateMany({
        where: {
          id: account.id,
          accountFingerprint: account.accountFingerprint,
        },
        data: {
          state: "restore_quarantined",
          healthVersion: { increment: 1 },
        },
      });
      throw new Error("hosted_codex_account_identity_drift");
    }
    const envelope = await this.vault.encrypt(input.nextAuthJsonBytes, {
      workspaceId: account.workspaceId,
      poolId: account.poolId,
      accountId: account.id,
      generation: nextGeneration,
      databaseIncarnation: this.databaseIncarnation,
    });
    try {
      await this.prisma.$transaction(async (transaction) => {
        const fence = await transaction.hostedCodexMutationFence.findUnique({
          where: { accountId: input.accountId },
        });
        if (
          !fence ||
          fence.expectedGeneration !== BigInt(input.expectedGeneration) ||
          fence.expiresAt <= new Date()
        ) {
          throw new Error("hosted_codex_mutation_fence_invalid");
        }
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
            actorIdHash: fence.ownerIdHash,
            receiptHash,
            previousReceiptHash: previousReceipt.receiptHash,
          },
        });
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        const committed =
          await this.prisma.hostedCodexGenerationReceipt.findUnique({
            where: { receiptHash },
            include: { credentialVersion: true },
          });
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
