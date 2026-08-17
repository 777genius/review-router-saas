import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  readCodexAuthJsonFreshness,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "@777genius/subscription-runtime/provider-codex";
import type { HostedAccountRepositoryPort } from "../../application/ports/hosted-account-repository-port";
import type { HostedCredentialEnrollmentPort } from "../../application/ports/hosted-credential-custody-port";
import type {
  HostedPoolBindingRepositoryPort,
  HostedPoolRepositoryPort,
} from "../../application/ports/hosted-pool-repository-port";
import type { HostedPoolQueryPort } from "../../application/ports/hosted-pool-query-port";
import type { RepositoryAuthModeSwitchPort } from "../../application/ports/repository-auth-mode-switch-port";
import type {
  HostedAccountAvailability,
  HostedAccountPool,
  HostedPoolAccount,
  HostedPoolRepositoryBinding,
} from "../../domain/account-pool";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  repositoryId,
  workspaceId,
} from "../../domain/identifiers";
import {
  CredentialEnvelopeVault,
  type EncryptedCredentialEnvelope,
} from "../crypto/credential-envelope-vault";
import { fingerprintCodexAuthJson } from "../security/codex-account-identity.js";

type HostedPoolPrismaClient = Pick<
  PrismaClient,
  | "$transaction"
  | "hostedCodexPool"
  | "hostedCodexAccount"
  | "hostedCodexRepositoryBinding"
>;

/**
 * Application-owned authority for writing the next review-configuration
 * version. The Prisma adapter deliberately cannot mutate configuration rows.
 */
export interface RepositoryReviewConfigurationAuthModeAuthority {
  switchToRepositoryOwnedRotating(input: {
    readonly transaction: Prisma.TransactionClient;
    readonly repositoryId: string;
    readonly workspaceId: string;
    readonly switchedAt: Date;
  }): Promise<boolean>;
}

export class PrismaHostedCredentialEnrollment implements HostedCredentialEnrollmentPort {
  private readonly fingerprintPepper: Uint8Array;

  constructor(
    private readonly prisma: HostedPoolPrismaClient,
    private readonly vault: CredentialEnvelopeVault,
    private readonly databaseIncarnation: string,
    fingerprintPepper: Uint8Array,
  ) {
    if (!databaseIncarnation.trim()) {
      throw new Error("hosted_codex_database_incarnation_missing");
    }
    if (fingerprintPepper.byteLength < 32) {
      throw new Error("hosted_codex_fingerprint_pepper_invalid");
    }
    this.fingerprintPepper = Uint8Array.from(fingerprintPepper);
  }

  async importCodexAuth(
    input: Parameters<HostedCredentialEnrollmentPort["importCodexAuth"]>[0],
  ) {
    const plaintext = Buffer.from(input.authJsonBytes);
    let artifactBytes: Uint8Array | null = null;
    try {
      const artifact = sessionArtifactFromCodexAuthJson(
        plaintext.toString("utf8"),
      );
      artifactBytes = artifact.bytes;
      const validation = validateCodexSessionArtifact(artifact);
      if (validation.status !== "valid") {
        throw new Error("hosted_codex_auth_json_invalid");
      }
      const compactAuthJson = Buffer.from(artifact.bytes).toString("utf8");
      const subjectFingerprint = fingerprintCodexAuthJson(
        artifact.bytes,
        this.fingerprintPepper,
      );
      const expiresAt = readCodexAuthJsonFreshness({
        authJsonBytes: compactAuthJson,
        now: input.now,
      }).expiresAt;
      const envelope = await this.vault.encrypt(artifact.bytes, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        accountId: input.accountId,
        generation: 1,
        databaseIncarnation: this.databaseIncarnation,
      });

      return await this.prisma.$transaction(async (transaction) => {
        const revision = await transaction.hostedCodexPool.updateMany({
          where: {
            id: input.poolId,
            workspaceId: input.workspaceId,
            isDefault: true,
            status: "active",
            tombstonedAt: null,
            revision: BigInt(input.expectedPoolRevision),
          },
          data: { revision: { increment: 1 }, updatedAt: input.now },
        });
        if (revision.count !== 1) {
          throw new Error("hosted_pool_revision_conflict");
        }
        const duplicate = await transaction.hostedCodexAccount.findFirst({
          where: {
            workspaceId: input.workspaceId,
            accountFingerprint: subjectFingerprint,
            tombstonedAt: null,
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new Error("hosted_account_subject_already_enrolled");
        }

        await transaction.hostedCodexAccount.create({
          data: {
            id: input.accountId,
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            label: input.label,
            priority: input.priority,
            accountFingerprint: subjectFingerprint,
            state: "provisioning_pending",
            activeGeneration: null,
            healthVersion: 0n,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        const credentialId = randomUUID();
        const credential =
          await transaction.hostedCodexCredentialVersion.create({
            data: credentialVersionCreateData({
              credentialId,
              workspaceId: input.workspaceId,
              poolId: input.poolId,
              accountId: input.accountId,
              expiresAt,
              envelope,
              databaseIncarnation: this.databaseIncarnation,
              artifactGenerationHash: createHash("sha256")
                .update(artifact.bytes)
                .digest("hex"),
              createdAt: input.now,
            }),
            select: { id: true },
          });
        const createdReceiptHash = receiptHash({
          credentialId: credential.id,
          kind: "credential_created",
          subjectFingerprint,
        });
        await transaction.hostedCodexGenerationReceipt.create({
          data: {
            credentialVersionId: credential.id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            generation: 1n,
            kind: "credential_created",
            mutationFenceEpoch: 1n,
            actorIdHash: subjectFingerprint,
            receiptHash: createdReceiptHash,
            occurredAt: input.now,
          },
        });
        const activated = await transaction.hostedCodexAccount.updateMany({
          where: {
            id: input.accountId,
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            state: "provisioning_pending",
            activeGeneration: null,
          },
          data: {
            state: "healthy",
            activeGeneration: 1n,
            healthVersion: 1n,
            lastHealthyAt: input.now,
            updatedAt: input.now,
          },
        });
        if (activated.count !== 1) {
          throw new Error("hosted_account_activation_conflict");
        }
        await transaction.hostedCodexGenerationReceipt.create({
          data: {
            credentialVersionId: credential.id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            generation: 1n,
            kind: "activated",
            mutationFenceEpoch: 1n,
            actorIdHash: subjectFingerprint,
            receiptHash: receiptHash({
              credentialId: credential.id,
              kind: "activated",
              subjectFingerprint,
            }),
            previousReceiptHash: createdReceiptHash,
            occurredAt: input.now,
          },
        });
        return {
          id: input.accountId,
          label: input.label,
          priority: input.priority,
          availability: { status: "healthy" as const },
          healthVersion: 1,
          authGeneration: 1,
          validatedAt: input.now,
          credentialExpiresAt: expiresAt,
          refreshDue: expiresAt !== null && expiresAt <= input.now,
          createdAt: input.now,
          updatedAt: input.now,
        };
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        throw new Error("hosted_account_enrollment_conflict", { cause: error });
      }
      throw sanitizeEnrollmentError(error);
    } finally {
      plaintext.fill(0);
      artifactBytes?.fill(0);
      input.authJsonBytes.fill(0);
    }
  }
}

export class PrismaHostedAccountRepository implements HostedAccountRepositoryPort {
  constructor(private readonly prisma: HostedPoolPrismaClient) {}

  async findById(id: ReturnType<typeof hostedAccountId>) {
    const account = await this.prisma.hostedCodexAccount.findUnique({
      where: { id },
      include: { credentialVersions: { orderBy: { generation: "desc" } } },
    });
    return account ? restoreAccount(account) : null;
  }

  async findBySubjectFingerprint(
    input: Parameters<
      HostedAccountRepositoryPort["findBySubjectFingerprint"]
    >[0],
  ) {
    const account = await this.prisma.hostedCodexAccount.findFirst({
      where: {
        poolId: input.poolId,
        accountFingerprint: input.subjectFingerprint,
      },
      include: { credentialVersions: { orderBy: { generation: "desc" } } },
    });
    return account ? restoreAccount(account) : null;
  }

  async listByPoolId(poolId: ReturnType<typeof hostedPoolId>) {
    const accounts = await this.prisma.hostedCodexAccount.findMany({
      where: { poolId, tombstonedAt: null },
      include: { credentialVersions: { orderBy: { generation: "desc" } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return accounts.map(restoreAccount);
  }

  async replaceCredential(
    input: Parameters<HostedAccountRepositoryPort["replaceCredential"]>[0],
  ) {
    if (
      input.account.credential.authGeneration !==
      input.expectedAuthGeneration + 1
    ) {
      return false;
    }
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.hostedCodexAccount.findUnique({
        where: { id: input.account.id },
        select: { workspaceId: true, poolId: true },
      });
      if (!current || current.poolId !== input.account.poolId) return false;
      const credential =
        await transaction.hostedCodexCredentialVersion.findFirst({
          where: {
            id: input.account.credential.credentialRef,
            accountId: input.account.id,
            workspaceId: current.workspaceId,
            poolId: current.poolId,
            generation: BigInt(input.account.credential.authGeneration),
          },
          select: { id: true },
        });
      if (!credential) return false;
      const updated = await transaction.hostedCodexAccount.updateMany({
        where: {
          id: input.account.id,
          workspaceId: current.workspaceId,
          poolId: current.poolId,
          activeGeneration: BigInt(input.expectedAuthGeneration),
          accountFingerprint: input.account.credential.subjectFingerprint,
        },
        data: {
          activeGeneration: BigInt(input.account.credential.authGeneration),
          state: "healthy",
          cooldownUntil: null,
          healthVersion: BigInt(input.account.healthVersion),
          lastHealthyAt: input.account.updatedAt,
          updatedAt: input.account.updatedAt,
        },
      });
      return updated.count === 1;
    });
  }

  async saveAvailability(
    input: Parameters<HostedAccountRepositoryPort["saveAvailability"]>[0],
  ) {
    if (input.account.healthVersion !== input.expectedHealthVersion + 1) {
      return false;
    }
    const result = await this.prisma.hostedCodexAccount.updateMany({
      where: {
        id: input.account.id,
        healthVersion: BigInt(input.expectedHealthVersion),
      },
      data: {
        ...availabilityData(input.account.availability),
        healthVersion: BigInt(input.account.healthVersion),
        updatedAt: input.account.updatedAt,
      },
    });
    return result.count === 1;
  }
}

export class PrismaHostedPoolRepository implements HostedPoolRepositoryPort {
  constructor(private readonly prisma: HostedPoolPrismaClient) {}

  async findDefaultByWorkspaceId(id: ReturnType<typeof workspaceId>) {
    const pools = await this.prisma.hostedCodexPool.findMany({
      where: { workspaceId: id, isDefault: true, tombstonedAt: null },
      take: 2,
    });
    if (pools.length > 1) throw new Error("hosted_default_pool_not_unique");
    return pools[0] ? restorePool(pools[0]) : null;
  }

  async findById(id: ReturnType<typeof hostedPoolId>) {
    const pool = await this.prisma.hostedCodexPool.findUnique({
      where: { id },
    });
    return pool && pool.tombstonedAt === null ? restorePool(pool) : null;
  }

  async insertDefault(pool: HostedAccountPool) {
    try {
      const stored = await this.prisma.hostedCodexPool.create({
        data: {
          id: pool.id,
          workspaceId: pool.workspaceId,
          name: "default",
          isDefault: true,
          status: pool.status,
          revision: BigInt(pool.revision),
          createdAt: pool.createdAt,
          updatedAt: pool.updatedAt,
        },
      });
      return restorePool(stored);
    } catch (error) {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      const existing = await this.findDefaultByWorkspaceId(pool.workspaceId);
      if (existing) return existing;
      throw new Error("hosted_default_pool_insert_conflict", { cause: error });
    }
  }

  async advanceRevision(
    input: Parameters<HostedPoolRepositoryPort["advanceRevision"]>[0],
  ) {
    const result = await this.prisma.hostedCodexPool.updateMany({
      where: {
        id: input.poolId,
        revision: BigInt(input.expectedRevision),
        tombstonedAt: null,
      },
      data: { revision: { increment: 1 }, updatedAt: input.updatedAt },
    });
    return result.count === 1 ? this.findById(input.poolId) : null;
  }
}

export class PrismaHostedPoolBindingRepository implements HostedPoolBindingRepositoryPort {
  constructor(private readonly prisma: HostedPoolPrismaClient) {}

  async findByRepositoryId(id: ReturnType<typeof repositoryId>) {
    const binding = await this.prisma.hostedCodexRepositoryBinding.findUnique({
      where: { repositoryConnectionId: id },
    });
    return binding && binding.tombstonedAt === null
      ? restoreBinding(binding)
      : null;
  }

  async save(input: Parameters<HostedPoolBindingRepositoryPort["save"]>[0]) {
    if (
      (input.expectedRevision === null) !==
      (input.expectedStateVersion === null)
    ) {
      return false;
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        if (!(await isEligibleRepository(transaction, input.binding))) {
          return false;
        }
        if (input.expectedRevision === null) {
          await transaction.hostedCodexRepositoryBinding.create({
            data: {
              id: input.binding.bindingId,
              workspaceId: input.binding.workspaceId,
              poolId: input.binding.poolId,
              repositoryConnectionId: input.binding.repositoryId,
              status: input.binding.status,
              revision: BigInt(input.binding.revision),
              stateVersion: BigInt(input.binding.stateVersion),
              attestedBindingRevision:
                input.binding.attestedBindingRevision === null
                  ? null
                  : BigInt(input.binding.attestedBindingRevision),
              activatedAt: input.binding.activatedAt,
              drainingAt: input.binding.drainingAt,
              createdAt: input.binding.boundAt,
              updatedAt: input.binding.updatedAt,
            },
          });
          return true;
        }
        const result =
          await transaction.hostedCodexRepositoryBinding.updateMany({
            where: {
              id: input.binding.bindingId,
              repositoryConnectionId: input.binding.repositoryId,
              workspaceId: input.binding.workspaceId,
              poolId: input.binding.poolId,
              revision: BigInt(input.expectedRevision),
              stateVersion: BigInt(input.expectedStateVersion!),
              tombstonedAt: null,
            },
            data: {
              status: input.binding.status,
              revision: BigInt(input.binding.revision),
              stateVersion: BigInt(input.binding.stateVersion),
              attestedBindingRevision:
                input.binding.attestedBindingRevision === null
                  ? null
                  : BigInt(input.binding.attestedBindingRevision),
              activatedAt: input.binding.activatedAt,
              drainingAt: input.binding.drainingAt,
              ...(input.binding.status === "pending_activation"
                ? {
                    workflowPath: null,
                    workflowActionRef: null,
                    workflowSourceCommitSha: null,
                    workflowSourceBlobSha: null,
                    workflowSourceSha256: null,
                    workflowSemanticSha256: null,
                    workflowSourceTrust: null,
                    attestedGithubRepositoryId: null,
                  }
                : {}),
              updatedAt: input.binding.updatedAt,
            },
          });
        return result.count === 1;
      });
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) return false;
      throw error;
    }
  }
}

export class PrismaHostedPoolQuery implements HostedPoolQueryPort {
  constructor(private readonly prisma: HostedPoolPrismaClient) {}

  async getDefaultPoolSummary(id: ReturnType<typeof workspaceId>) {
    const pool = await this.prisma.hostedCodexPool.findFirst({
      where: { workspaceId: id, isDefault: true, tombstonedAt: null },
      select: {
        id: true,
        workspaceId: true,
        isDefault: true,
        revision: true,
        stateVersion: true,
        activatedAt: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        accounts: {
          where: { tombstonedAt: null },
          select: { state: true },
        },
      },
    });
    if (!pool) return null;
    const restored = restorePool(pool);
    return {
      ...restored,
      accountCount: pool.accounts.length,
      healthyAccountCount: pool.accounts.filter(
        (account) => account.state === "healthy",
      ).length,
    };
  }

  async listAccountSummaries(poolId: ReturnType<typeof hostedPoolId>) {
    const now = new Date();
    const accounts = await this.prisma.hostedCodexAccount.findMany({
      where: { poolId, tombstonedAt: null },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        label: true,
        priority: true,
        state: true,
        cooldownUntil: true,
        healthVersion: true,
        activeGeneration: true,
        createdAt: true,
        updatedAt: true,
        credentialVersions: {
          orderBy: { generation: "desc" },
          select: {
            generation: true,
            credentialExpiresAt: true,
            createdAt: true,
          },
        },
      },
    });
    return accounts.map((account) => {
      const credential = account.credentialVersions.find(
        (candidate) => candidate.generation === account.activeGeneration,
      );
      if (!credential)
        throw new Error("hosted_account_active_credential_missing");
      const expiresAt = credential.credentialExpiresAt;
      return {
        id: hostedAccountId(account.id),
        label: account.label,
        priority: account.priority,
        availability: restoreAvailability(account.state, account.cooldownUntil),
        healthVersion: toSafeNumber(account.healthVersion),
        authGeneration: toSafeNumber(credential.generation),
        validatedAt: credential.createdAt,
        credentialExpiresAt: expiresAt,
        refreshDue: expiresAt !== null && expiresAt <= now,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      };
    });
  }

  async getRepositoryBindingSummary(id: ReturnType<typeof repositoryId>) {
    const binding = await this.prisma.hostedCodexRepositoryBinding.findUnique({
      where: { repositoryConnectionId: id },
      select: {
        id: true,
        repositoryConnectionId: true,
        poolId: true,
        status: true,
        revision: true,
        stateVersion: true,
        activatedAt: true,
        updatedAt: true,
        tombstonedAt: true,
      },
    });
    if (!binding || binding.tombstonedAt !== null) return null;
    const status = bindingStatus(binding.status);
    return {
      id: hostedBindingId(binding.id),
      bindingId: hostedBindingId(binding.id),
      repositoryId: repositoryId(binding.repositoryConnectionId),
      poolId: hostedPoolId(binding.poolId),
      status,
      revision: toSafeNumber(binding.revision),
      stateVersion: toSafeNumber(binding.stateVersion),
      activatedAt: binding.activatedAt,
      updatedAt: binding.updatedAt,
    };
  }
}

export class PrismaRepositoryAuthModeSwitch implements RepositoryAuthModeSwitchPort {
  constructor(
    private readonly prisma: HostedPoolPrismaClient,
    private readonly configurationAuthority?: RepositoryReviewConfigurationAuthModeAuthority,
  ) {}

  async switchToRepositoryOwnedRotating(
    input: Parameters<
      RepositoryAuthModeSwitchPort["switchToRepositoryOwnedRotating"]
    >[0],
  ) {
    const configurationAuthority = this.configurationAuthority;
    if (!configurationAuthority) return false;
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const binding =
          await transaction.hostedCodexRepositoryBinding.findFirst({
            where: {
              repositoryConnectionId: input.repositoryId,
              workspaceId: input.workspaceId,
              revision: BigInt(input.expectedBindingRevision),
              status: "active",
              tombstonedAt: null,
            },
            select: { id: true, poolId: true, stateVersion: true },
          });
        if (!binding) return false;
        if (
          !(await isEligibleRepository(transaction, {
            repositoryId: input.repositoryId,
            workspaceId: input.workspaceId,
            poolId: hostedPoolId(binding.poolId),
          }))
        ) {
          return false;
        }
        const configured =
          await configurationAuthority.switchToRepositoryOwnedRotating({
            transaction,
            repositoryId: input.repositoryId,
            workspaceId: input.workspaceId,
            switchedAt: input.switchedAt,
          });
        if (!configured) throw new ConfigurationAuthorityRejectedError();
        const result =
          await transaction.hostedCodexRepositoryBinding.updateMany({
            where: {
              id: binding.id,
              repositoryConnectionId: input.repositoryId,
              workspaceId: input.workspaceId,
              poolId: binding.poolId,
              revision: BigInt(input.expectedBindingRevision),
              stateVersion: binding.stateVersion,
              status: "active",
              tombstonedAt: null,
            },
            data: {
              status: "draining",
              revision: BigInt(input.nextBindingRevision),
              stateVersion: { increment: 1 },
              drainingAt: input.switchedAt,
              updatedAt: input.switchedAt,
            },
          });
        if (result.count !== 1) {
          throw new Error("hosted_pool_binding_revision_conflict");
        }
        return true;
      });
    } catch (error) {
      if (error instanceof ConfigurationAuthorityRejectedError) return false;
      throw error;
    }
  }
}

export function createPrismaHostedAccountPoolAdapters(input: {
  readonly prisma: PrismaClient;
  readonly vault: CredentialEnvelopeVault;
  readonly databaseIncarnation: string;
  readonly fingerprintPepper: Uint8Array;
  readonly configurationAuthority?: RepositoryReviewConfigurationAuthModeAuthority;
}) {
  return {
    pools: new PrismaHostedPoolRepository(input.prisma),
    accounts: new PrismaHostedAccountRepository(input.prisma),
    bindings: new PrismaHostedPoolBindingRepository(input.prisma),
    queries: new PrismaHostedPoolQuery(input.prisma),
    authModeSwitch: new PrismaRepositoryAuthModeSwitch(
      input.prisma,
      input.configurationAuthority,
    ),
    credentialEnrollment: new PrismaHostedCredentialEnrollment(
      input.prisma,
      input.vault,
      input.databaseIncarnation,
      input.fingerprintPepper,
    ),
  };
}

async function isEligibleRepository(
  transaction: Prisma.TransactionClient,
  binding: {
    readonly repositoryId: string;
    readonly workspaceId: string;
    readonly poolId: string;
  },
): Promise<boolean> {
  const repository = await transaction.repositoryConnection.findFirst({
    where: {
      id: binding.repositoryId,
      workspaceId: binding.workspaceId,
      provider: "github",
      selected: true,
      archived: false,
      visibility: { in: ["private", "internal"] },
      installation: {
        is: { workspaceId: binding.workspaceId, status: "active" },
      },
    },
    select: { id: true },
  });
  if (!repository) return false;
  const pool = await transaction.hostedCodexPool.findFirst({
    where: {
      id: binding.poolId,
      workspaceId: binding.workspaceId,
      isDefault: true,
      status: "active",
      tombstonedAt: null,
    },
    select: { id: true },
  });
  return pool !== null;
}

function restorePool(pool: {
  readonly id: string;
  readonly workspaceId: string;
  readonly isDefault: boolean;
  readonly revision: bigint;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): HostedAccountPool {
  if (!pool.isDefault) throw new Error("hosted_pool_not_default");
  if (pool.status !== "active" && pool.status !== "paused") {
    throw new Error("hosted_pool_state_unsupported");
  }
  return {
    id: hostedPoolId(pool.id),
    workspaceId: workspaceId(pool.workspaceId),
    isDefault: true,
    revision: toSafeNumber(pool.revision),
    status: pool.status,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
  };
}

function restoreBinding(binding: {
  readonly id: string;
  readonly repositoryConnectionId: string;
  readonly workspaceId: string;
  readonly poolId: string;
  readonly status: string;
  readonly revision: bigint;
  readonly stateVersion: bigint;
  readonly attestedBindingRevision: bigint | null;
  readonly activatedAt: Date | null;
  readonly drainingAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): HostedPoolRepositoryBinding {
  return {
    bindingId: hostedBindingId(binding.id),
    repositoryId: repositoryId(binding.repositoryConnectionId),
    workspaceId: workspaceId(binding.workspaceId),
    poolId: hostedPoolId(binding.poolId),
    authMode: "codex_subscription_oauth_hosted_pool",
    status: bindingStatus(binding.status),
    revision: toSafeNumber(binding.revision),
    stateVersion: toSafeNumber(binding.stateVersion),
    attestedBindingRevision:
      binding.attestedBindingRevision === null
        ? null
        : toSafeNumber(binding.attestedBindingRevision),
    activatedAt: binding.activatedAt,
    drainingAt: binding.drainingAt,
    boundAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function bindingStatus(value: string): HostedPoolRepositoryBinding["status"] {
  if (
    value !== "pending_activation" &&
    value !== "active" &&
    value !== "draining"
  ) {
    throw new Error("hosted_pool_binding_inactive");
  }
  return value;
}

function restoreAccount(account: {
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
  readonly credentialVersions: ReadonlyArray<{
    readonly id: string;
    readonly generation: bigint;
    readonly credentialExpiresAt: Date | null;
    readonly createdAt: Date;
  }>;
}): HostedPoolAccount {
  const credential = account.credentialVersions.find(
    (candidate) => candidate.generation === account.activeGeneration,
  );
  if (!credential) throw new Error("hosted_account_active_credential_missing");
  return {
    id: hostedAccountId(account.id),
    poolId: hostedPoolId(account.poolId),
    label: account.label,
    priority: account.priority,
    healthVersion: toSafeNumber(account.healthVersion),
    credential: {
      credentialRef: credential.id,
      subjectFingerprint: account.accountFingerprint,
      authGeneration: toSafeNumber(credential.generation),
      validatedAt: credential.createdAt,
      expiresAt: credential.credentialExpiresAt,
    },
    availability: restoreAvailability(account.state, account.cooldownUntil),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function restoreAvailability(
  state: string,
  cooldownUntil: Date | null,
): HostedAccountAvailability {
  if (state === "healthy") return { status: "healthy" };
  if (state === "cooldown" && cooldownUntil) {
    return {
      status: "cooldown",
      reason: "provider_cooldown",
      until: cooldownUntil,
    };
  }
  if (state === "paused")
    return { status: "paused", reason: "operator_paused" };
  return {
    status: "quarantined",
    reason: `provider_state_${safeState(state)}`,
  };
}

function availabilityData(availability: HostedAccountAvailability) {
  switch (availability.status) {
    case "healthy":
      return { state: "healthy" as const, cooldownUntil: null };
    case "cooldown":
      return { state: "cooldown" as const, cooldownUntil: availability.until };
    case "paused":
      return { state: "paused" as const, cooldownUntil: null };
    case "quarantined":
      return { state: "quarantined" as const, cooldownUntil: null };
  }
}

function credentialVersionCreateData(input: {
  readonly credentialId: string;
  readonly workspaceId: string;
  readonly poolId: string;
  readonly accountId: string;
  readonly expiresAt: Date | null;
  readonly envelope: EncryptedCredentialEnvelope;
  readonly databaseIncarnation: string;
  readonly artifactGenerationHash: string;
  readonly createdAt: Date;
}) {
  return {
    id: input.credentialId,
    workspaceId: input.workspaceId,
    poolId: input.poolId,
    accountId: input.accountId,
    generation: 1n,
    databaseIncarnation: input.databaseIncarnation,
    envelopeVersion: input.envelope.schemaVersion,
    encryptionAlgorithm: input.envelope.encryptionAlgorithm,
    keyId: input.envelope.keyId,
    aadHash: input.envelope.associatedDataHash,
    ciphertextHash: input.envelope.ciphertextHash,
    generationHash: input.artifactGenerationHash,
    encryptedCiphertext: input.envelope.ciphertext,
    credentialExpiresAt: input.expiresAt,
    envelopeMetadata: {
      nonce: input.envelope.nonce,
      authenticationTag: input.envelope.authenticationTag,
      wrappedDataEncryptionKey: input.envelope.wrappedDataEncryptionKey,
    },
    createdAt: input.createdAt,
  };
}

function receiptHash(input: {
  readonly credentialId: string;
  readonly kind: "credential_created" | "activated";
  readonly subjectFingerprint: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.credentialId}\u0000${input.kind}\u00001\u0000${input.subjectFingerprint}`,
      "utf8",
    )
    .digest("hex");
}

function sanitizeEnrollmentError(error: unknown): Error {
  const safeCodes = new Set([
    "hosted_pool_revision_conflict",
    "hosted_account_subject_already_enrolled",
    "hosted_account_enrollment_conflict",
    "hosted_account_activation_conflict",
    "hosted_codex_auth_json_invalid",
    "hosted_codex_identity_token_missing",
    "hosted_codex_identity_token_invalid",
    "hosted_codex_account_identity_invalid",
    "hosted_codex_identity_claim_invalid",
  ]);
  if (error instanceof Error && safeCodes.has(error.message)) return error;
  return new Error("hosted_account_enrollment_failed", { cause: error });
}

class ConfigurationAuthorityRejectedError extends Error {}

function safeState(value: string): string {
  return /^[a-z0-9_]{1,60}$/i.test(value) ? value : "unavailable";
}

function toSafeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("hosted_codex_revision_out_of_range");
  }
  return number;
}

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
