import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  canonicalCodexRotatingProviderId,
  classifyCodexRotatingMutationOwnership,
  codexRotatingAuthMode,
  codexRotatingSetupRecoveryAcknowledgement,
  codexRotatingSecretName,
  codexRotatingWritebackClaimMarker,
  codexRotatingWritebackDispatchedMarker,
  type CodexRotatingIdentityQuarantineReadModel,
  type CodexRotatingSetupRecoveryPort,
  type CodexRotatingSetupRecoveryResult,
  type CodexRotatingSetupRecoveryStatus,
} from "@reviewrouter/features-provider-setup";
import {
  lockCodexRotatingProviderRow,
  lockCodexRotatingSetupProvider,
} from "./codex-rotating-provider-mutation-fence";

const recoveryTransactionTimeoutMs = 10_000;

export class PrismaCodexRotatingSetupRecovery implements CodexRotatingSetupRecoveryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findIdentityQuarantine(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<CodexRotatingIdentityQuarantineReadModel | null> {
    const rows = await this.prisma.$queryRaw<QuarantineRow[]>`
      SELECT "providerInstanceRowId", "observedWorkspaceId",
             "observedRepositoryId", "observedProviderInstanceId",
             "expectedProviderInstanceId", "reason", "quarantinedAt"
      FROM "CodexOAuthProviderIdentityQuarantine" quarantine
      JOIN "RepositoryConnection" repository
        ON repository."id" = quarantine."observedRepositoryId"
      WHERE repository."workspaceId" = ${input.workspaceId}
        AND repository."id" = ${input.repositoryId}
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? {
          providerInstanceRowId: row.providerInstanceRowId,
          workspaceId: row.observedWorkspaceId,
          repositoryId: row.observedRepositoryId,
          observedProviderInstanceId: row.observedProviderInstanceId,
          expectedProviderInstanceId: row.expectedProviderInstanceId,
          reason: row.reason,
          quarantinedAt: row.quarantinedAt,
        }
      : null;
  }

  async inspectStatus(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly issuanceEnabled: boolean;
  }): Promise<CodexRotatingSetupRecoveryStatus> {
    if (!input.issuanceEnabled) return { status: "issuance_quiesced" };
    const quarantine = await this.findIdentityQuarantine(input);
    if (quarantine) return { status: "identity_quarantined", quarantine };
    const provider = await this.prisma.codexOAuthProviderInstance.findFirst({
      where: {
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        authMode: codexRotatingAuthMode,
      },
      select: {
        id: true,
        mutationOwner: true,
        writebackIntents: {
          where: { status: "remote_outcome_unknown" },
          take: 1,
          select: { id: true },
        },
        setupManifests: {
          where: { status: "fetched" },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (provider?.setupManifests.length || provider?.writebackIntents.length) {
      return {
        status: "remote_outcome_unknown",
        reason: "github_secret_put_may_have_completed",
        action: "use_versioned_secret_namespace_or_prove_no_overwrite",
      };
    }
    if (provider?.mutationOwner === "recovery") {
      return { status: "recovery_required" };
    }
    return { status: "ready" };
  }

  async recover(
    input: Parameters<CodexRotatingSetupRecoveryPort["recover"]>[0],
  ): Promise<CodexRotatingSetupRecoveryResult> {
    const expectedProviderInstanceId = canonicalCodexRotatingProviderId(
      input.githubRepositoryId,
    );
    return this.prisma.$transaction(
      async (tx) => {
        await lockCodexRotatingSetupProvider(tx, expectedProviderInstanceId);
        const scopedQuarantine = await findScopedQuarantine(tx, {
          workspaceId: input.workspaceId,
          repositoryId: input.repositoryId,
        });
        if (scopedQuarantine) {
          input.decide({
            canonicalIdentity: false,
            quarantined: true,
            mutationOwnership: "ambiguous",
            recoveryRequestAlreadyApplied: false,
          });
          throw new Error("codex_rotating_identity_quarantined");
        }
        const providerLocator = await tx.codexOAuthProviderInstance.findUnique({
          where: {
            repositoryId_authMode: {
              repositoryId: input.repositoryId,
              authMode: codexRotatingAuthMode,
            },
          },
          select: { id: true },
        });
        if (!providerLocator) {
          throw new Error("codex_rotating_provider_not_found");
        }
        await lockCodexRotatingProviderRow(tx, providerLocator.id);

        // The row lock is the serialization point. Never decide from the
        // locator snapshot read before it was acquired.
        const provider = await tx.codexOAuthProviderInstance.findUniqueOrThrow({
          where: { id: providerLocator.id },
          include: {
            repository: {
              select: { workspaceId: true, githubRepositoryId: true },
            },
          },
        });

        const quarantine = await findQuarantine(tx, provider.id);
        const request = await findRecoveryRequest(
          tx,
          provider.id,
          input.recoveryRequestId,
        );
        const activeOtherRequest = await findOtherActiveRecoveryRequest(
          tx,
          provider.id,
          input.recoveryRequestId,
        );
        if (activeOtherRequest) {
          throw new Error("codex_rotating_setup_recovery_request_conflict");
        }
        if (request && !["active", "manifest_issued"].includes(request.state)) {
          throw new Error("codex_rotating_setup_recovery_already_used");
        }
        const setup = await tx.codexOAuthSetupManifest.findFirst({
          where: {
            providerInstanceRowId: provider.id,
            status: { in: ["issued", "fetched"] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            status: true,
            expiresAt: true,
            lastFetchedAt: true,
          },
        });
        const pendingIntent = await tx.codexOAuthWritebackIntent.findFirst({
          where: {
            providerInstanceRowId: provider.id,
            status: { in: ["pending", "remote_outcome_unknown"] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            leaseId: true,
            status: true,
            createdAt: true,
            safeErrorCode: true,
          },
        });
        const runtimeLease = provider.mutationOwnerId
          ? await tx.codexOAuthLease.findFirst({
              where: {
                id: provider.mutationOwnerId,
                providerInstanceRowId: provider.id,
              },
              select: { id: true, status: true, expiresAt: true },
            })
          : null;
        const canonicalIdentity =
          provider.repository.workspaceId === input.workspaceId &&
          provider.repository.githubRepositoryId?.toString() ===
            input.githubRepositoryId &&
          provider.repositoryId === input.repositoryId &&
          provider.providerInstanceId === expectedProviderInstanceId &&
          provider.authMode === codexRotatingAuthMode &&
          provider.secretName === codexRotatingSecretName;
        const ownership = classifyCodexRotatingMutationOwnership({
          owner: provider.mutationOwner,
          ownerId: provider.mutationOwnerId,
          now: input.now,
          setup,
          writeback: pendingIntent
            ? {
                id: pendingIntent.id,
                leaseId: pendingIntent.leaseId,
                status: pendingIntent.status,
                claimedAt: pendingIntent.createdAt,
                claimMarker:
                  pendingIntent.safeErrorCode ===
                    codexRotatingWritebackClaimMarker ||
                  pendingIntent.safeErrorCode ===
                    codexRotatingWritebackDispatchedMarker,
              }
            : null,
          runtimeLease,
        });
        const decision = input.decide({
          canonicalIdentity,
          quarantined: quarantine !== null,
          mutationOwnership: ownership.classification,
          recoveryRequestAlreadyApplied:
            request?.state === "active" || request?.state === "manifest_issued",
        });
        if (decision.kind === "idempotent_replay") {
          if (!request)
            throw new Error("codex_rotating_setup_recovery_required");
          return {
            status: "idempotent_replay" as const,
            recoveryEpoch: request.mutationEpoch,
          };
        }

        const recoveryOwnerId = `setup-recovery:${input.recoveryRequestId}`;
        const recoveryEpoch = provider.mutationEpoch + 1n;
        const sanitizedActor = sanitizeRecoveryActor(input.actor);
        await tx.codexOAuthProviderInstance.update({
          where: { id: provider.id },
          data: {
            state: "unknown_auth_state",
            activeLeaseId: null,
            activeLeaseExpiresAt: null,
            mutationEpoch: recoveryEpoch,
            mutationOwner: "recovery",
            mutationOwnerId: recoveryOwnerId,
          },
        });
        await insertRecoveryRequest(tx, {
          id: `codex_recovery_${randomUUID()}`,
          providerInstanceRowId: provider.id,
          recoveryRequestId: input.recoveryRequestId,
          actor: sanitizedActor,
          mutationEpoch: recoveryEpoch,
          now: input.now,
        });
        await tx.codexOAuthSetupManifest.updateMany({
          where: {
            providerInstanceRowId: provider.id,
            status: { in: ["issued", "fetched"] },
          },
          data: {
            status: "recovered",
            consumedAt: input.now,
            confirmationJson: {
              recoveryRequestId: input.recoveryRequestId,
              acknowledgedSecretMayHaveChanged: true,
              recoveryEpoch: recoveryEpoch.toString(10),
            },
          },
        });
        await tx.codexOAuthWritebackIntent.updateMany({
          where: { providerInstanceRowId: provider.id, status: "pending" },
          data: {
            status: "failed",
            safeErrorCode: "operator_setup_recovery",
            completedAt: input.now,
          },
        });
        if (provider.activeLeaseId) {
          await tx.codexOAuthLease.updateMany({
            where: { id: provider.activeLeaseId, status: { not: "completed" } },
            data: { status: "abandoned", expiresAt: input.now },
          });
        }
        await tx.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actor: sanitizedActor,
            action: "codex_rotating.setup_recovered",
            targetType: "repository",
            targetId: input.repositoryId,
            metadata: {
              source: "operator",
              recoveryRequestId: input.recoveryRequestId,
              recoveryEpoch: recoveryEpoch.toString(10),
              previousOwnership: ownership.classification,
            },
          },
        });
        return { status: "recovered" as const, recoveryEpoch };
      },
      { timeout: recoveryTransactionTimeoutMs },
    );
  }
}

type RecoveryRequestRow = {
  readonly id: string;
  readonly mutationEpoch: bigint;
  readonly state: string;
};

async function findRecoveryRequest(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
  recoveryRequestId: string,
): Promise<RecoveryRequestRow | null> {
  const rows = await tx.$queryRaw<RecoveryRequestRow[]>`
    SELECT "id", "mutationEpoch", "state"
    FROM "CodexOAuthSetupRecoveryRequest"
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
      AND "recoveryRequestId" = ${recoveryRequestId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function findOtherActiveRecoveryRequest(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
  recoveryRequestId: string,
): Promise<{ readonly id: string } | null> {
  const rows = await tx.$queryRaw<Array<{ readonly id: string }>>`
    SELECT "id" FROM "CodexOAuthSetupRecoveryRequest"
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
      AND "recoveryRequestId" <> ${recoveryRequestId}
      AND "state" IN ('active', 'manifest_issued')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function insertRecoveryRequest(
  tx: Prisma.TransactionClient,
  input: {
    readonly id: string;
    readonly providerInstanceRowId: string;
    readonly recoveryRequestId: string;
    readonly actor: string;
    readonly mutationEpoch: bigint;
    readonly now: Date;
  },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "CodexOAuthSetupRecoveryRequest" (
      "id", "providerInstanceRowId", "recoveryRequestId", "actor",
      "acknowledgement", "mutationEpoch", "mode", "state",
      "requestedAt", "activatedAt", "updatedAt"
    ) VALUES (
      ${input.id}, ${input.providerInstanceRowId}, ${input.recoveryRequestId},
      ${input.actor}, ${codexRotatingSetupRecoveryAcknowledgement},
      ${input.mutationEpoch}, 'forced_reseed', 'active',
      ${input.now}, ${input.now}, ${input.now}
    )
  `;
}

function sanitizeRecoveryActor(actor: string): string {
  const sanitized = actor
    .trim()
    .replace(/[^A-Za-z0-9_.:@+-]/g, "_")
    .slice(0, 200);
  return sanitized || "unknown_operator";
}

type QuarantineRow = {
  readonly providerInstanceRowId: string;
  readonly observedWorkspaceId: string;
  readonly observedRepositoryId: string;
  readonly observedProviderInstanceId: string;
  readonly expectedProviderInstanceId: string | null;
  readonly reason: string;
  readonly quarantinedAt: Date;
};

async function findQuarantine(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
): Promise<QuarantineRow | null> {
  const rows = await tx.$queryRaw<QuarantineRow[]>`
    SELECT "providerInstanceRowId", "observedWorkspaceId",
           "observedRepositoryId", "observedProviderInstanceId",
           "expectedProviderInstanceId", "reason", "quarantinedAt"
    FROM "CodexOAuthProviderIdentityQuarantine"
    WHERE "providerInstanceRowId" = ${providerInstanceRowId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function findScopedQuarantine(
  tx: Prisma.TransactionClient,
  input: { readonly workspaceId: string; readonly repositoryId: string },
): Promise<QuarantineRow | null> {
  const rows = await tx.$queryRaw<QuarantineRow[]>`
    SELECT quarantine."providerInstanceRowId",
           quarantine."observedWorkspaceId",
           quarantine."observedRepositoryId",
           quarantine."observedProviderInstanceId",
           quarantine."expectedProviderInstanceId",
           quarantine."reason", quarantine."quarantinedAt"
    FROM "CodexOAuthProviderIdentityQuarantine" quarantine
    JOIN "RepositoryConnection" repository
      ON repository."id" = quarantine."observedRepositoryId"
    WHERE repository."workspaceId" = ${input.workspaceId}
      AND repository."id" = ${input.repositoryId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
