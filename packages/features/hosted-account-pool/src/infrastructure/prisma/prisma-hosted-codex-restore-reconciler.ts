import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  HostedCodexRestorePermit,
  HostedCodexRestorePermitVerifierPort,
} from "../../application/ports/hosted-codex-restore-permit-port.js";
import {
  CredentialEnvelopeVault,
  type EncryptedCredentialEnvelope,
} from "../crypto/credential-envelope-vault.js";
import {
  hostedCodexMutationLeaseAuthority,
  PrismaHostedCodexMutationFence,
} from "./prisma-hosted-codex-mutation-fence.js";

type RestorePhase =
  | "after_inventory"
  | "after_witness_persisted"
  | "after_item_decrypt"
  | "after_item_encrypt"
  | "after_item_committed"
  | "after_reconciled"
  | "after_item_promoted";

export class PrismaHostedCodexRestoreReconciler {
  private readonly fences: PrismaHostedCodexMutationFence;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly recoveryVault: CredentialEnvelopeVault,
    private readonly databaseResourceIdentity: string,
    private readonly databaseIncarnation: string,
    private readonly permitVerifier: HostedCodexRestorePermitVerifierPort,
    private readonly fault?: (phase: RestorePhase, itemId?: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (databaseResourceIdentity.length < 16) {
      throw new Error("hosted_codex_database_resource_identity_invalid");
    }
    if (databaseIncarnation.length < 16) {
      throw new Error("hosted_codex_database_incarnation_invalid");
    }
    this.fences = new PrismaHostedCodexMutationFence(prisma);
  }

  /** Metadata-only clone check. No KMS call is reachable before quarantine. */
  async assertRelayReady(): Promise<void> {
    const inventory = await this.loadInventory();
    const mismatched = inventory.filter(
      (item) =>
        item.databaseResourceIdentity !== this.databaseResourceIdentity ||
        item.databaseIncarnation !== this.databaseIncarnation ||
        item.custodyMode !== "aws_kms",
    );
    if (mismatched.length > 0) {
      await this.quarantineAccountsAndRevokeGrants(
        mismatched.map((item) => item.accountId),
      );
      throw new Error("hosted_codex_external_database_witness_mismatch");
    }
    const quarantined = await this.prisma.hostedCodexAccount.count({
      where: { state: "restore_quarantined", activeGeneration: { not: null } },
    });
    if (quarantined > 0) {
      throw new Error("hosted_codex_restore_promotion_required");
    }
  }

  async begin(token: string): Promise<string> {
    const inventory = await this.loadInventory();
    const sourceItems = inventory.filter(
      (item) =>
        item.databaseResourceIdentity !== this.databaseResourceIdentity ||
        item.databaseIncarnation !== this.databaseIncarnation,
    );
    if (sourceItems.length === 0) {
      throw new Error("hosted_codex_restore_source_missing");
    }
    const inventoryHash = hashInventory(sourceItems);
    this.fault?.("after_inventory");
    const permit = this.permitVerifier.verify({
      token,
      databaseResourceIdentity: this.databaseResourceIdentity,
      targetIncarnation: this.databaseIncarnation,
      inventoryHash,
    });
    this.assertPermit(permit, sourceItems, inventoryHash);
    const nonceHash = sha256(permit.nonce);
    const replay = await this.prisma.hostedCodexRestoreOperation.findUnique({
      where: { nonceHash },
    });
    if (replay) {
      return this.assertReplayBinding(replay, inventoryHash);
    }
    const operationId = randomUUID();
    try {
      await this.prisma.$transaction(
        async (transaction) => {
          await transaction.hostedCodexAccount.updateMany({
            where: {
              id: { in: sourceItems.map((item) => item.accountId) },
              state: { notIn: ["restore_quarantined", "tombstoned"] },
            },
            data: {
              state: "restore_quarantined",
              healthVersion: { increment: 1 },
            },
          });
          const affectedGrantIds = (
            await transaction.hostedCodexInvocationGrant.findMany({
              where: {
                status: "issued",
                OR: [
                  {
                    activeAccountId: {
                      in: sourceItems.map((item) => item.accountId),
                    },
                  },
                  {
                    primaryAccountId: {
                      in: sourceItems.map((item) => item.accountId),
                    },
                  },
                  {
                    backupAccountId: {
                      in: sourceItems.map((item) => item.accountId),
                    },
                  },
                ],
              },
              select: { id: true },
            })
          ).map((grant) => grant.id);
          await transaction.hostedCodexInvocationGrant.updateMany({
            where: {
              id: { in: affectedGrantIds },
              status: "issued",
            },
            data: {
              status: "revoked",
              revokedAt: this.now(),
              inFlight: 0,
              revision: { increment: 1 },
            },
          });
          await transaction.hostedCodexCommentRefreshCapability.updateMany({
            where: { grantId: { in: affectedGrantIds }, revokedAt: null },
            data: { revokedAt: this.now(), revision: { increment: 1 } },
          });
          await transaction.hostedCodexRestoreOperation.create({
            data: {
              id: operationId,
              inventoryHash,
              databaseResourceIdentity: permit.databaseResourceIdentity,
              sourceIncarnation: permit.sourceIncarnation,
              targetIncarnation: permit.targetIncarnation,
              sourceKmsKeyArn: permit.sourceKmsKeyArn,
              targetKmsKeyArn: permit.targetKmsKeyArn,
              authorityKeyId: permit.authorityKeyId,
              actorIdHash: sha256(permit.actorId),
              nonceHash,
              permitExpiresAt: permit.expiresAt,
              itemCount: sourceItems.length,
              createdAt: this.now(),
            },
          });
          await transaction.hostedCodexRestoreItem.createMany({
            data: sourceItems.map((item) => ({
              id: randomUUID(),
              restoreOperationId: operationId,
              credentialVersionId: item.credentialVersionId,
              accountId: item.accountId,
              workspaceId: item.workspaceId,
              poolId: item.poolId,
              generation: item.generation,
              sourceRevision: item.revision,
              sourceAadHash: item.aadHash,
              sourceCiphertextHash: item.ciphertextHash,
              createdAt: this.now(),
            })),
          });
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const racedReplay =
        await this.prisma.hostedCodexRestoreOperation.findUnique({
          where: { nonceHash },
        });
      if (!racedReplay) throw error;
      return this.assertReplayBinding(racedReplay, inventoryHash);
    }
    this.fault?.("after_witness_persisted");
    return operationId;
  }

  private assertReplayBinding(
    replay: {
      readonly id: string;
      readonly inventoryHash: string;
      readonly databaseResourceIdentity: string;
      readonly targetIncarnation: string;
    },
    inventoryHash: string,
  ): string {
    if (
      replay.inventoryHash !== inventoryHash ||
      replay.databaseResourceIdentity !== this.databaseResourceIdentity ||
      replay.targetIncarnation !== this.databaseIncarnation
    ) {
      throw new Error("hosted_codex_restore_permit_replay_conflict");
    }
    return replay.id;
  }

  async reconcile(operationId: string): Promise<{
    readonly reconciled: number;
    readonly busy: number;
  }> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === "promoted") return { reconciled: 0, busy: 0 };
    if (operation.state === "failed") {
      throw new Error(
        "hosted_codex_restore_operation_failed_new_permit_required",
      );
    }
    // Expiry is an admission boundary checked before the immutable witnessed
    // operation is persisted. Once witnessed, the operation must remain
    // resumable after a process crash; otherwise a partially rewrapped
    // inventory could become permanently stranded when the original permit
    // expires between attempts.
    if (operation.targetKmsKeyArn !== this.recoveryVault.currentKeyId) {
      throw new Error("hosted_codex_restore_target_kms_mismatch");
    }
    await this.prisma.hostedCodexRestoreOperation.updateMany({
      where: { id: operationId, state: "witnessed" },
      data: { state: "reconciling", reconciliationStartedAt: this.now() },
    });
    const items = await this.prisma.hostedCodexRestoreItem.findMany({
      where: {
        restoreOperationId: operationId,
        state: { in: ["pending", "busy"] },
      },
      orderBy: { id: "asc" },
    });
    let reconciled = 0;
    let busy = 0;
    for (const item of items) {
      const source = await this.loadSource(item);
      const lease = await this.fences.acquire({
        accountId: item.accountId,
        runId: `restore:${operationId}`,
        attempt: item.attemptCount + 1,
        ttlMs: 120_000,
        restoredGenerationHash: source.generationHash,
      });
      if (lease.status !== "granted") {
        await this.prisma.hostedCodexRestoreItem.updateMany({
          where: { id: item.id, state: { in: ["pending", "busy"] } },
          data: {
            state: "busy",
            attemptCount: { increment: 1 },
            lastAttemptAt: this.now(),
          },
        });
        busy += 1;
        continue;
      }
      const authority = hostedCodexMutationLeaseAuthority(lease.leaseId);
      try {
        const plaintext = await this.recoveryVault.decrypt(source.envelope, {
          workspaceId: item.workspaceId,
          poolId: item.poolId,
          accountId: item.accountId,
          generation: toSafeNumber(item.generation),
          databaseIncarnation: operation.sourceIncarnation,
          databaseResourceIdentity: source.databaseResourceIdentity,
        });
        this.fault?.("after_item_decrypt", item.id);
        let target: EncryptedCredentialEnvelope;
        try {
          target = await this.recoveryVault.encrypt(plaintext, {
            workspaceId: item.workspaceId,
            poolId: item.poolId,
            accountId: item.accountId,
            generation: toSafeNumber(item.generation),
            databaseIncarnation: operation.targetIncarnation,
            databaseResourceIdentity: operation.databaseResourceIdentity,
          });
        } finally {
          plaintext.fill(0);
        }
        this.fault?.("after_item_encrypt", item.id);
        const nextRevision = item.sourceRevision + 1n;
        const idempotencyKeyHash = sha256(
          [operationId, item.credentialVersionId, nextRevision.toString()].join(
            "\u0000",
          ),
        );
        await this.prisma.$transaction(
          async (transaction) => {
            await requireFence(transaction, {
              accountId: item.accountId,
              generation: item.generation,
              authority,
              now: this.now(),
            });
            const current =
              await transaction.hostedCodexRestoreItem.findUniqueOrThrow({
                where: { id: item.id },
              });
            if (current.state === "rewrapped" || current.state === "promoted")
              return;
            const latest =
              await transaction.hostedCodexCredentialEnvelopeRevision.findFirst(
                {
                  where: { credentialVersionId: item.credentialVersionId },
                  orderBy: { revision: "desc" },
                },
              );
            if (
              !latest ||
              latest.revision !== item.sourceRevision ||
              latest.aadHash !== item.sourceAadHash ||
              latest.ciphertextHash !== item.sourceCiphertextHash
            ) {
              throw new Error("hosted_codex_restore_inventory_changed");
            }
            await transaction.hostedCodexCredentialEnvelopeRevision.create({
              data: {
                id: randomUUID(),
                credentialVersionId: item.credentialVersionId,
                accountId: item.accountId,
                workspaceId: item.workspaceId,
                poolId: item.poolId,
                generation: item.generation,
                revision: nextRevision,
                sourceRevision: item.sourceRevision,
                custodyMode: "aws_kms",
                kmsKeyArn: target.keyId,
                kmsContextVersion: 1,
                databaseResourceIdentity: operation.databaseResourceIdentity,
                databaseIncarnation: operation.targetIncarnation,
                reason: "restore_reconciliation",
                envelopeVersion: target.schemaVersion,
                encryptionAlgorithm: target.encryptionAlgorithm,
                aadHash: target.associatedDataHash,
                ciphertextHash: target.ciphertextHash,
                encryptedCiphertext: target.ciphertext,
                envelopeMetadata: envelopeMetadata(target),
                fenceOwnerIdHash: authority.ownerIdHash,
                fenceEpoch: authority.fenceEpoch,
                actorIdHash: operation.actorIdHash,
                idempotencyKeyHash,
              },
            });
            await transaction.hostedCodexRestoreItem.update({
              where: { id: item.id },
              data: {
                state: "rewrapped",
                targetRevision: nextRevision,
                attemptCount: { increment: 1 },
                lastAttemptAt: this.now(),
                rewrappedAt: this.now(),
              },
            });
          },
          { isolationLevel: "Serializable" },
        );
        this.fault?.("after_item_committed", item.id);
        reconciled += 1;
      } finally {
        await this.fences.release({
          leaseId: lease.leaseId,
          reason: "restore_reconciliation_complete",
        });
      }
    }
    const remaining = await this.prisma.hostedCodexRestoreItem.count({
      where: {
        restoreOperationId: operationId,
        state: { notIn: ["rewrapped", "promoted"] },
      },
    });
    if (remaining === 0) {
      await this.assertInventoryMembership(operationId, operation.itemCount);
      await this.prisma.hostedCodexRestoreOperation.updateMany({
        where: { id: operationId, state: { in: ["witnessed", "reconciling"] } },
        data: { state: "reconciled", reconciledAt: this.now() },
      });
      this.fault?.("after_reconciled");
    }
    return { reconciled, busy };
  }

  async promote(operationId: string): Promise<number> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === "promoted") return 0;
    if (operation.state !== "reconciled") {
      throw new Error("hosted_codex_restore_reconciliation_incomplete");
    }
    await this.assertInventoryMembership(operationId, operation.itemCount);
    const items = await this.prisma.hostedCodexRestoreItem.findMany({
      where: { restoreOperationId: operationId, state: "rewrapped" },
      orderBy: { id: "asc" },
    });
    let promoted = 0;
    for (const item of items) {
      await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.hostedCodexAccount.updateMany({
          where: {
            id: item.accountId,
            workspaceId: item.workspaceId,
            poolId: item.poolId,
            activeGeneration: item.generation,
            state: "restore_quarantined",
          },
          data: {
            state: "healthy",
            healthVersion: { increment: 1 },
            lastHealthyAt: this.now(),
          },
        });
        if (updated.count !== 1) {
          throw new Error("hosted_codex_restore_promotion_conflict");
        }
        await transaction.hostedCodexRestoreItem.update({
          where: { id: item.id },
          data: { state: "promoted", promotedAt: this.now() },
        });
      });
      promoted += 1;
      this.fault?.("after_item_promoted", item.id);
    }
    const remaining = await this.prisma.hostedCodexRestoreItem.count({
      where: { restoreOperationId: operationId, state: { not: "promoted" } },
    });
    if (remaining !== 0)
      throw new Error("hosted_codex_restore_promotion_incomplete");
    await this.prisma.hostedCodexRestoreOperation.updateMany({
      where: { id: operationId, state: "reconciled" },
      data: { state: "promoted", promotedAt: this.now() },
    });
    return promoted;
  }

  private async loadInventory() {
    const accounts = await this.prisma.hostedCodexAccount.findMany({
      where: {
        activeGeneration: { not: null },
        state: { notIn: ["tombstoned", "draining"] },
      },
      include: {
        credentialVersions: {
          orderBy: { generation: "desc" },
          take: 1,
          include: {
            envelopeRevisions: { orderBy: { revision: "desc" }, take: 1 },
          },
        },
      },
      orderBy: { id: "asc" },
    });
    const incompleteAccountIds = accounts
      .filter((account) => {
        const credential = account.credentialVersions[0];
        return (
          !credential ||
          credential.envelopeRevisions.length !== 1 ||
          account.activeGeneration !== credential.generation
        );
      })
      .map((account) => account.id);
    if (incompleteAccountIds.length > 0) {
      await this.quarantineAccountsAndRevokeGrants(incompleteAccountIds);
      throw new Error("hosted_codex_restore_inventory_incomplete");
    }
    return accounts.flatMap((account) => {
      const credential = account.credentialVersions[0];
      const revision = credential?.envelopeRevisions[0];
      if (
        !credential ||
        !revision ||
        account.activeGeneration !== credential.generation
      ) {
        return [];
      }
      return [
        {
          accountId: account.id,
          workspaceId: account.workspaceId,
          poolId: account.poolId,
          credentialVersionId: credential.id,
          generation: credential.generation,
          revision: revision.revision,
          custodyMode: revision.custodyMode,
          kmsKeyArn: revision.kmsKeyArn,
          databaseResourceIdentity: revision.databaseResourceIdentity,
          databaseIncarnation: revision.databaseIncarnation,
          aadHash: revision.aadHash,
          ciphertextHash: revision.ciphertextHash,
        },
      ];
    });
  }

  private async loadSource(item: {
    readonly credentialVersionId: string;
    readonly sourceRevision: bigint;
    readonly sourceAadHash: string;
    readonly sourceCiphertextHash: string;
  }) {
    const credential =
      await this.prisma.hostedCodexCredentialVersion.findUniqueOrThrow({
        where: { id: item.credentialVersionId },
        include: {
          envelopeRevisions: {
            where: { revision: item.sourceRevision },
            take: 1,
          },
        },
      });
    const revision = credential.envelopeRevisions[0];
    if (
      !revision ||
      revision.aadHash !== item.sourceAadHash ||
      revision.ciphertextHash !== item.sourceCiphertextHash ||
      revision.custodyMode !== "aws_kms" ||
      !revision.kmsKeyArn ||
      !revision.databaseResourceIdentity
    ) {
      throw new Error("hosted_codex_restore_inventory_changed");
    }
    return {
      generationHash: credential.generationHash,
      databaseResourceIdentity: revision.databaseResourceIdentity,
      envelope: restoreEnvelope({ ...revision, keyId: revision.kmsKeyArn }),
    };
  }

  private async assertInventoryMembership(
    operationId: string,
    itemCount: number,
  ) {
    const [operation, items] = await Promise.all([
      this.requireOperation(operationId),
      this.prisma.hostedCodexRestoreItem.findMany({
        where: { restoreOperationId: operationId },
        select: {
          credentialVersionId: true,
          accountId: true,
          generation: true,
          targetRevision: true,
          state: true,
        },
      }),
    ]);
    if (items.length !== itemCount)
      throw new Error("hosted_codex_restore_inventory_changed");
    const active = await this.prisma.hostedCodexAccount.findMany({
      where: { id: { in: items.map((item) => item.accountId) } },
      select: { id: true, activeGeneration: true },
    });
    if (
      active.length !== items.length ||
      active.some(
        (account) =>
          !items.some(
            (item) =>
              item.accountId === account.id &&
              item.generation === account.activeGeneration,
          ),
      )
    ) {
      throw new Error("hosted_codex_restore_inventory_changed");
    }
    // A permit witnesses the complete source inventory, not merely the rows
    // that happened to exist when this process last ran. Re-enveloped items no
    // longer match the source scope, while a newly restored/source credential
    // does and therefore invalidates the permit before completion/promotion.
    const witnessedCredentialIds = new Set(
      items.map((item) => item.credentialVersionId),
    );
    const currentInventory = await this.loadInventory();
    if (
      currentInventory.some(
        (entry) =>
          entry.databaseIncarnation === operation.sourceIncarnation &&
          entry.kmsKeyArn === operation.sourceKmsKeyArn &&
          !witnessedCredentialIds.has(entry.credentialVersionId),
      )
    ) {
      throw new Error("hosted_codex_restore_inventory_changed");
    }
    const affectedInventory = currentInventory.filter((entry) =>
      witnessedCredentialIds.has(entry.credentialVersionId),
    );
    if (
      affectedInventory.length !== items.length ||
      affectedInventory.some((entry) => {
        const witnessed = items.find(
          (item) => item.credentialVersionId === entry.credentialVersionId,
        );
        return (
          !witnessed ||
          witnessed.targetRevision === null ||
          entry.revision !== witnessed.targetRevision ||
          entry.databaseResourceIdentity !==
            operation.databaseResourceIdentity ||
          entry.databaseIncarnation !== operation.targetIncarnation ||
          entry.kmsKeyArn !== operation.targetKmsKeyArn ||
          !["rewrapped", "promoted"].includes(witnessed.state)
        );
      })
    ) {
      throw new Error("hosted_codex_restore_inventory_changed");
    }
  }

  private assertPermit(
    permit: HostedCodexRestorePermit,
    items: Awaited<
      ReturnType<PrismaHostedCodexRestoreReconciler["loadInventory"]>
    >,
    inventoryHash: string,
  ) {
    const sourceIncarnations = new Set(
      items.map((item) => item.databaseIncarnation),
    );
    const sourceKeys = new Set(items.map((item) => item.kmsKeyArn));
    if (
      permit.inventoryHash !== inventoryHash ||
      permit.databaseResourceIdentity !== this.databaseResourceIdentity ||
      permit.targetIncarnation !== this.databaseIncarnation ||
      permit.targetKmsKeyArn !== this.recoveryVault.currentKeyId ||
      sourceIncarnations.size !== 1 ||
      !sourceIncarnations.has(permit.sourceIncarnation) ||
      sourceKeys.size !== 1 ||
      !sourceKeys.has(permit.sourceKmsKeyArn) ||
      permit.expiresAt <= this.now()
    ) {
      throw new Error("hosted_codex_restore_permit_scope_invalid");
    }
  }

  private requireOperation(id: string) {
    return this.prisma.hostedCodexRestoreOperation.findUniqueOrThrow({
      where: { id },
    });
  }

  private quarantineAccountsAndRevokeGrants(accountIds: readonly string[]) {
    const uniqueAccountIds = [...new Set(accountIds)];
    const now = this.now();
    return this.prisma.$transaction(async (transaction) => {
      await transaction.hostedCodexAccount.updateMany({
        where: { id: { in: uniqueAccountIds }, state: { not: "tombstoned" } },
        data: {
          state: "restore_quarantined",
          healthVersion: { increment: 1 },
        },
      });
      const grants = await transaction.hostedCodexInvocationGrant.findMany({
        where: {
          status: "issued",
          OR: [
            { activeAccountId: { in: uniqueAccountIds } },
            { primaryAccountId: { in: uniqueAccountIds } },
            { backupAccountId: { in: uniqueAccountIds } },
          ],
        },
        select: { id: true },
      });
      if (grants.length === 0) return;
      const grantIds = grants.map((grant) => grant.id);
      await transaction.hostedCodexInvocationGrant.updateMany({
        where: { id: { in: grantIds }, status: "issued" },
        data: {
          status: "revoked",
          revokedAt: now,
          inFlight: 0,
          revision: { increment: 1 },
        },
      });
      await transaction.hostedCodexCommentRefreshCapability.updateMany({
        where: { grantId: { in: grantIds }, revokedAt: null },
        data: { revokedAt: now, revision: { increment: 1 } },
      });
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function requireFence(
  transaction: Prisma.TransactionClient,
  input: {
    readonly accountId: string;
    readonly generation: bigint;
    readonly authority: ReturnType<typeof hostedCodexMutationLeaseAuthority>;
    readonly now: Date;
  },
) {
  const updated = await transaction.hostedCodexMutationFence.updateMany({
    where: {
      accountId: input.accountId,
      expectedGeneration: input.generation,
      ownerIdHash: input.authority.ownerIdHash,
      fenceEpoch: input.authority.fenceEpoch,
      expiresAt: { gt: input.now },
    },
    data: { updatedAt: input.now },
  });
  if (updated.count !== 1)
    throw new Error("hosted_codex_mutation_fence_invalid");
}

function hashInventory(
  items: readonly {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly accountId: string;
    readonly credentialVersionId: string;
    readonly generation: bigint;
    readonly revision: bigint;
    readonly databaseResourceIdentity: string | null;
    readonly databaseIncarnation: string;
    readonly kmsKeyArn: string | null;
    readonly aadHash: string;
    readonly ciphertextHash: string;
  }[],
): string {
  return sha256(
    items
      .map((item) =>
        [
          item.workspaceId,
          item.poolId,
          item.accountId,
          item.credentialVersionId,
          item.generation.toString(),
          item.revision.toString(),
          item.databaseResourceIdentity ?? "",
          item.databaseIncarnation,
          item.kmsKeyArn ?? "",
          item.aadHash,
          item.ciphertextHash,
        ].join("\u0000"),
      )
      .sort()
      .join("\n"),
  );
}

function restoreEnvelope(value: {
  readonly envelopeVersion: number;
  readonly encryptionAlgorithm: string;
  readonly keyId: string;
  readonly aadHash: string;
  readonly ciphertextHash: string;
  readonly encryptedCiphertext: string;
  readonly envelopeMetadata: unknown;
}): EncryptedCredentialEnvelope {
  const metadata =
    value.envelopeMetadata as Partial<EncryptedCredentialEnvelope>;
  if (
    value.envelopeVersion !== 1 ||
    value.encryptionAlgorithm !== "aes-256-gcm" ||
    typeof metadata.nonce !== "string" ||
    typeof metadata.authenticationTag !== "string" ||
    !metadata.wrappedDataEncryptionKey
  ) {
    throw new Error("hosted_codex_envelope_metadata_invalid");
  }
  return {
    schemaVersion: 1,
    encryptionAlgorithm: "aes-256-gcm",
    keyId: value.keyId,
    nonce: metadata.nonce,
    authenticationTag: metadata.authenticationTag,
    ciphertext: value.encryptedCiphertext,
    wrappedDataEncryptionKey: metadata.wrappedDataEncryptionKey,
    associatedDataHash: value.aadHash,
    ciphertextHash: value.ciphertextHash,
  };
}

function envelopeMetadata(
  envelope: EncryptedCredentialEnvelope,
): Prisma.InputJsonValue {
  return {
    nonce: envelope.nonce,
    authenticationTag: envelope.authenticationTag,
    wrappedDataEncryptionKey: envelope.wrappedDataEncryptionKey,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toSafeNumber(value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("hosted_codex_generation_out_of_range");
  }
  return parsed;
}
