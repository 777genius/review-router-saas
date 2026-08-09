import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  canonicalCodexRotatingProviderId,
  codexRotatingAuthMode,
  codexRotatingSecretName,
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

type RecoveredMarker = {
  readonly mutationEpoch: bigint;
};

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
        setupManifests: {
          where: { status: "fetched" },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (provider?.setupManifests.length) {
      return { status: "fetched_setup_recovery_required" };
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
            hasFetchedManifest: false,
            hasAmbiguousWritebackIntent: false,
            recoveryRequestAlreadyApplied: false,
          });
          throw new Error("codex_rotating_identity_quarantined");
        }
        const provider = await tx.codexOAuthProviderInstance.findUnique({
          where: {
            repositoryId_authMode: {
              repositoryId: input.repositoryId,
              authMode: codexRotatingAuthMode,
            },
          },
          include: {
            repository: {
              select: { workspaceId: true, githubRepositoryId: true },
            },
          },
        });
        if (!provider) {
          throw new Error("codex_rotating_provider_not_found");
        }
        await lockCodexRotatingProviderRow(tx, provider.id);

        const quarantine = await findQuarantine(tx, provider.id);
        const marker = await findRecoveredMarker(
          tx,
          provider.id,
          input.repositoryId,
          input.recoveryRequestId,
        );
        const fetched = await tx.codexOAuthSetupManifest.findFirst({
          where: { providerInstanceRowId: provider.id, status: "fetched" },
          select: { id: true },
        });
        const pendingIntent = await tx.codexOAuthWritebackIntent.findFirst({
          where: { providerInstanceRowId: provider.id, status: "pending" },
          select: { id: true },
        });
        const canonicalIdentity =
          provider.repository.workspaceId === input.workspaceId &&
          provider.repository.githubRepositoryId?.toString() ===
            input.githubRepositoryId &&
          provider.repositoryId === input.repositoryId &&
          provider.providerInstanceId === expectedProviderInstanceId &&
          provider.authMode === codexRotatingAuthMode &&
          provider.secretName === codexRotatingSecretName;
        const decision = input.decide({
          canonicalIdentity,
          quarantined: quarantine !== null,
          hasFetchedManifest: fetched !== null,
          hasAmbiguousWritebackIntent:
            pendingIntent !== null || provider.mutationOwner === "recovery",
          recoveryRequestAlreadyApplied: marker !== null,
        });
        if (decision.kind === "idempotent_replay") {
          return {
            status: "idempotent_replay" as const,
            recoveryEpoch: marker!.mutationEpoch,
          };
        }

        const recoveryOwnerId = `setup-recovery:${input.recoveryRequestId}`;
        const recoveryEpoch = provider.mutationEpoch + 1n;
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
        await tx.codexOAuthSetupManifest.updateMany({
          where: { providerInstanceRowId: provider.id, status: "fetched" },
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
            actor: input.actor,
            action: "codex_rotating.setup_recovered",
            targetType: "repository",
            targetId: input.repositoryId,
            metadata: {
              source: "operator",
              recoveryRequestId: input.recoveryRequestId,
              recoveryEpoch: recoveryEpoch.toString(10),
              fetchedSetupRecovered: fetched !== null,
              pendingIntentRecovered: pendingIntent !== null,
            },
          },
        });
        return { status: "recovered" as const, recoveryEpoch };
      },
      { timeout: recoveryTransactionTimeoutMs },
    );
  }
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

async function findRecoveredMarker(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
  repositoryId: string,
  recoveryRequestId: string,
): Promise<RecoveredMarker | null> {
  const rows = await tx.$queryRaw<RecoveredMarker[]>`
    SELECT marker."mutationEpoch" FROM (
      SELECT ("confirmationJson"->>'recoveryEpoch')::bigint AS "mutationEpoch",
             "consumedAt" AS "recordedAt"
      FROM "CodexOAuthSetupManifest"
      WHERE "providerInstanceRowId" = ${providerInstanceRowId}
        AND "status" = 'recovered'
        AND "confirmationJson"->>'recoveryRequestId' = ${recoveryRequestId}
      UNION ALL
      SELECT ("metadata"->>'recoveryEpoch')::bigint AS "mutationEpoch",
             "createdAt" AS "recordedAt"
      FROM "AuditEvent"
      WHERE "targetType" = 'repository'
        AND "targetId" = ${repositoryId}
        AND "action" = 'codex_rotating.setup_recovered'
        AND "metadata"->>'recoveryRequestId' = ${recoveryRequestId}
    ) marker
    ORDER BY marker."recordedAt" DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
