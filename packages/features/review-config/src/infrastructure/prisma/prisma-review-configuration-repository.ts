import { createHash } from "node:crypto";
import { acquireCurrentScopeGuards } from "@reviewrouter/platform-db";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  parseReviewConfiguration,
  type ReviewConfiguration,
} from "../../domain/review-configuration";
import {
  reviewConfigurationTargetKey,
  type ReviewConfigurationTarget,
} from "../../domain/review-configuration-target";
import type {
  PersistedReviewConfiguration,
  RepositoryReviewConfiguration,
  ReviewConfigurationBatchReaderPort,
  ReviewConfigurationRepositoryPort,
  ReviewConfigurationOperationInput,
  ReviewConfigurationOperationRepositoryPort,
} from "../../application/ports/review-configuration-repository-port";
import {
  snapshotReviewConfigurationOperation,
  snapshotReviewConfigurationOperationLookup,
} from "../../application/use-cases/save-review-configuration";
import {
  isReviewConfigurationWriteConflictError,
  ReviewConfigurationWriteConflictError as WriteConflict,
} from "../../application/ports/review-configuration-repository-port";

export class PrismaReviewConfigurationRepository
  implements
    ReviewConfigurationRepositoryPort,
    ReviewConfigurationOperationRepositoryPort,
    ReviewConfigurationBatchReaderPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly operatorWorkspaceId?: string,
  ) {
    assertOperatorWorkspaceId(operatorWorkspaceId);
  }

  async findLatest(
    target: ReviewConfigurationTarget,
  ): Promise<PersistedReviewConfiguration | null> {
    return findLatestReviewConfiguration(this.prisma, target);
  }

  async findLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }): Promise<readonly RepositoryReviewConfiguration[]> {
    return findLatestReviewConfigurationsForRepositories(this.prisma, input);
  }

  async saveNextVersion(input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
    readonly expectedVersion?: number | null;
  }): Promise<PersistedReviewConfiguration> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) =>
            saveNextReviewConfigurationVersion(
              tx,
              input,
              this.operatorWorkspaceId,
            ),
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (
          isReviewConfigurationWriteConflictError(error) ||
          isPrismaReviewConfigurationWriteConflict(error)
        ) {
          throw new WriteConflict();
        }
        if (
          !isPrismaReviewConfigurationSerializationConflict(error) ||
          attempt === MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new Error("review_configuration_transaction_retry_exhausted");
  }

  async deleteTarget(target: ReviewConfigurationTarget): Promise<boolean> {
    return this.prisma.$transaction((tx) =>
      deleteReviewConfigurationTarget(tx, target),
    );
  }

  async findOperation(
    input: Parameters<
      ReviewConfigurationOperationRepositoryPort["findOperation"]
    >[0],
  ): Promise<PersistedReviewConfiguration | null> {
    const intent = snapshotReviewConfigurationOperationLookup(input);
    const receipt = await findOperationReceipt(
      this.prisma,
      intent.target,
      intent.operationId,
    );
    if (!receipt) return null;
    // Verify the caller's original CAS against the durable complete intent.
    // Clear retains history, so a null-CAS write may have any result version.
    return matchOperationReceipt(
      receipt,
      operationIntentHash({
        target: intent.target,
        expectedVersion: intent.expectedVersion,
        config: toPersistedConfiguration(receipt).config,
      }),
    );
  }

  async saveNextVersionWithOperation(
    input: ReviewConfigurationOperationInput,
  ): Promise<PersistedReviewConfiguration> {
    const intent = snapshotReviewConfigurationOperation(input);
    const receipt = {
      operationId: intent.operationId,
      operationIntentHash: operationIntentHash(intent),
    };
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) =>
            saveNextReviewConfigurationVersion(
              tx,
              intent,
              this.operatorWorkspaceId,
              receipt,
            ),
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        // Resolve races only after rollback, from the original scoped receipt.
        if (
          isPrismaReviewConfigurationWriteConflict(error) ||
          isPrismaReviewConfigurationSerializationConflict(error)
        ) {
          const original = await findOperationReceipt(
            this.prisma,
            intent.target,
            intent.operationId,
          );
          if (original) {
            return matchOperationReceipt(original, receipt.operationIntentHash);
          }
          if (isPrismaReviewConfigurationWriteConflict(error))
            throw new WriteConflict();
        }
        if (
          !isPrismaReviewConfigurationSerializationConflict(error) ||
          attempt === MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new Error("review_configuration_transaction_retry_exhausted");
  }
}

function operationIntentHash(
  intent: Pick<
    ReviewConfigurationOperationInput,
    "target" | "expectedVersion" | "config"
  >,
): string {
  return createHash("sha256")
    .update(
      canonicalIntent({
        target: intent.target,
        expectedVersion: intent.expectedVersion,
        config: intent.config,
      }),
    )
    .digest("hex");
}

function canonicalIntent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIntent).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalIntent(v)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("review_configuration_intent_invalid");
  return encoded;
}

async function findOperationReceipt(
  prisma: ReviewConfigurationPrismaClient,
  target: ReviewConfigurationTarget,
  operationId: string,
) {
  return prisma.reviewConfigurationVersion.findFirst({
    where: {
      operationId,
      configuration: {
        workspaceId: target.workspaceId,
        targetKey: reviewConfigurationTargetKey(target),
      },
    },
    select: { ...versionSelect, operationIntentHash: true },
  });
}

function matchOperationReceipt(
  original: VersionRecord & { readonly operationIntentHash: string | null },
  intentHash: string,
): PersistedReviewConfiguration {
  if (original.operationIntentHash !== intentHash) throw new WriteConflict();
  return toPersistedConfiguration(original);
}

/** Acquire at transaction entry, before any earlier advisory/row locks or reads.
 * Multi-target callers predeclare their complete scope plan with the DB helper.
 */
export async function acquireReviewConfigurationWriteScope(
  transaction: Prisma.TransactionClient,
  target: ReviewConfigurationTarget,
): Promise<void> {
  await acquireCurrentScopeGuards(transaction, [
    { ...target, mode: "exclusive" },
  ]);
}

export class PrismaReviewConfigurationTransactionRepository
  implements
    ReviewConfigurationRepositoryPort,
    ReviewConfigurationBatchReaderPort
{
  constructor(
    private readonly prisma: Prisma.TransactionClient,
    private readonly operatorWorkspaceId?: string,
  ) {
    assertOperatorWorkspaceId(operatorWorkspaceId);
  }

  findLatest(target: ReviewConfigurationTarget) {
    return findLatestReviewConfiguration(this.prisma, target);
  }

  findLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }) {
    return findLatestReviewConfigurationsForRepositories(this.prisma, input);
  }

  saveNextVersion(
    input: Parameters<ReviewConfigurationRepositoryPort["saveNextVersion"]>[0],
  ) {
    return saveNextReviewConfigurationVersion(
      this.prisma,
      input,
      this.operatorWorkspaceId,
    );
  }

  deleteTarget(target: ReviewConfigurationTarget) {
    return deleteReviewConfigurationTarget(this.prisma, target);
  }
}

export function isPrismaReviewConfigurationWriteConflict(
  error: unknown,
): boolean {
  return hasPrismaErrorCode(error, "P2002");
}

export function isPrismaReviewConfigurationSerializationConflict(
  error: unknown,
): boolean {
  return hasPrismaErrorCode(error, "P2034");
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function assertOperatorWorkspaceId(
  operatorWorkspaceId: string | undefined,
): void {
  if (
    operatorWorkspaceId !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.exec(operatorWorkspaceId)?.[0] !==
      operatorWorkspaceId
  ) {
    throw new Error("review_configuration_operator_workspace_id_invalid");
  }
}

const MAX_TRANSACTION_ATTEMPTS = 3;

type ReviewConfigurationPrismaClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  "reviewConfiguration" | "reviewConfigurationVersion"
>;

async function findLatestReviewConfiguration(
  prisma: ReviewConfigurationPrismaClient,
  target: ReviewConfigurationTarget,
): Promise<PersistedReviewConfiguration | null> {
  const record = await prisma.reviewConfiguration.findUnique({
    where: {
      workspaceId_targetKey: {
        workspaceId: target.workspaceId,
        targetKey: reviewConfigurationTargetKey(target),
      },
    },
    select: {
      active: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: versionSelect,
      },
    },
  });
  const version = record?.active ? record.versions[0] : undefined;
  return version ? toPersistedConfiguration(version) : null;
}

async function findLatestReviewConfigurationsForRepositories(
  prisma: ReviewConfigurationPrismaClient,
  input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  },
): Promise<readonly RepositoryReviewConfiguration[]> {
  const repositoryIds = [...new Set(input.repositoryIds)];
  if (repositoryIds.length === 0) {
    return [];
  }

  const records = await prisma.reviewConfiguration.findMany({
    where: {
      workspaceId: input.workspaceId,
      repositoryId: { in: repositoryIds },
      active: true,
    },
    orderBy: { repositoryId: "asc" },
    select: {
      repositoryId: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: versionSelect,
      },
    },
  });

  return records.flatMap((record) => {
    const version = record.versions[0];
    return record.repositoryId && version
      ? [
          {
            repositoryId: record.repositoryId,
            config: toPersistedConfiguration(version),
          },
        ]
      : [];
  });
}

async function saveNextReviewConfigurationVersion(
  prisma: Prisma.TransactionClient,
  input: Parameters<ReviewConfigurationRepositoryPort["saveNextVersion"]>[0],
  operatorWorkspaceId?: string,
  receipt?: {
    readonly operationId: string;
    readonly operationIntentHash: string;
  },
): Promise<PersistedReviewConfiguration> {
  await acquireReviewConfigurationWriteScope(prisma, input.target);
  if (receipt) {
    const original = await findOperationReceipt(
      prisma,
      input.target,
      receipt.operationId,
    );
    if (original)
      return matchOperationReceipt(original, receipt.operationIntentHash);
  }
  const config = parseReviewConfiguration(input.config);
  const targetKey = reviewConfigurationTargetKey(input.target);
  const configuration = await prisma.reviewConfiguration.upsert({
    where: {
      workspaceId_targetKey: {
        workspaceId: input.target.workspaceId,
        targetKey,
      },
    },
    update: {
      repositoryId:
        input.target.scope === "repository" ? input.target.repositoryId : null,
    },
    create: {
      workspaceId: input.target.workspaceId,
      repositoryId:
        input.target.scope === "repository" ? input.target.repositoryId : null,
      targetKey,
    },
    select: { id: true, workspaceId: true, active: true },
  });

  const latest = await prisma.reviewConfigurationVersion.findFirst({
    where: { configurationId: configuration.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const currentVersion = configuration.active
    ? (latest?.version ?? null)
    : null;
  if (
    input.expectedVersion !== undefined &&
    currentVersion !== input.expectedVersion
  ) {
    throw new WriteConflict();
  }
  // Selection only. The safe product mirror cannot authorize execution;
  // next relay admission must independently read live gateway/kernel authority.
  await assertGatewaySelections(
    prisma,
    configuration.workspaceId,
    config,
    operatorWorkspaceId,
  );
  if (!configuration.active) {
    // Reactivate only a NEW, CAS-valid, eligible write. Receipt replay returned
    // above without changing the active override or its retained history.
    await prisma.reviewConfiguration.update({
      where: { id: configuration.id },
      data: { active: true },
    });
  }
  const nextVersion = (latest?.version ?? 0) + 1;
  const saved = await prisma.reviewConfigurationVersion.create({
    data: {
      configurationId: configuration.id,
      ...receipt,
      workspaceId: configuration.workspaceId,
      gatewayBindingId: config.provider.gatewayBindingId ?? null,
      gatewayProfileRef: config.provider.gatewayProfileRef ?? null,
      version: nextVersion,
      schemaVersion: config.schemaVersion,
      providerKind: config.provider.kind,
      providerAuthMode: config.provider.authMode,
      model: config.provider.model,
      reasoningEffort: config.provider.reasoningEffort,
      agenticContext: config.provider.agenticContext,
      fastMode: config.provider.fastMode,
      failOnSeverity: config.blockingPolicy.failOnSeverity,
      inlineMaxComments: config.limits.inlineMaxComments,
      providerLimit: config.execution.providerLimit,
      providerMaxParallel: config.execution.providerMaxParallel,
      inlineMinAgreement: config.execution.inlineMinAgreement,
      targetTokensPerBatch: config.limits.targetTokensPerBatch,
      reviewLanguage: config.reviewLanguage ?? null,
      investigationRecordingEnabled:
        config.investigationRollout.recordingEnabled,
      investigationShadowEnabled: config.investigationRollout.shadowEnabled,
      investigationContextCriticEnabled:
        config.investigationRollout.contextCriticEnabled,
      investigationVerifiedCleanEnabled:
        config.investigationRollout.verifiedCleanEnabled,
      investigationCrossRevisionReplayEnabled:
        config.investigationRollout.crossRevisionReplayEnabled,
      investigationProductionEffectsEnabled:
        config.investigationRollout.productionEffectsEnabled,
      providers: {
        create: config.providers.map((provider, index) => ({
          // Composite parent relation supplies workspaceId from the version.
          order: index,
          gatewayBindingId: provider.gatewayBindingId ?? null,
          gatewayProfileRef: provider.gatewayProfileRef ?? null,
          providerKind: provider.kind,
          providerAuthMode: provider.authMode,
          model: provider.model,
          reasoningEffort: provider.reasoningEffort,
          agenticContext: provider.agenticContext,
          fastMode: provider.fastMode,
          requiredHealthy: provider.requiredHealthy,
        })),
      },
    },
    select: versionSelect,
  });

  return toPersistedConfiguration(saved);
}

async function deleteReviewConfigurationTarget(
  prisma: Prisma.TransactionClient,
  target: ReviewConfigurationTarget,
): Promise<boolean> {
  await acquireReviewConfigurationWriteScope(prisma, target);
  const scope = {
    workspaceId: target.workspaceId,
    targetKey: reviewConfigurationTargetKey(target),
  };
  // Clear the active override without destroying committed operation receipts.
  // History stays scoped to the same parent; a later new write continues its
  // sequence while CAS sees null for an inactive override.
  const retained = await prisma.reviewConfiguration.updateMany({
    where: {
      ...scope,
      active: true,
      versions: { some: { operationId: { not: null } } },
    },
    data: { active: false },
  });
  const result = await prisma.reviewConfiguration.deleteMany({
    where: {
      ...scope,
      versions: { none: { operationId: { not: null } } },
    },
  });
  return retained.count + result.count > 0;
}

const versionSelect = {
  id: true,
  version: true,
  schemaVersion: true,
  providerKind: true,
  providerAuthMode: true,
  gatewayBindingId: true,
  gatewayProfileRef: true,
  model: true,
  reasoningEffort: true,
  agenticContext: true,
  fastMode: true,
  failOnSeverity: true,
  inlineMaxComments: true,
  providerLimit: true,
  providerMaxParallel: true,
  inlineMinAgreement: true,
  targetTokensPerBatch: true,
  reviewLanguage: true,
  investigationRecordingEnabled: true,
  investigationShadowEnabled: true,
  investigationContextCriticEnabled: true,
  investigationVerifiedCleanEnabled: true,
  investigationCrossRevisionReplayEnabled: true,
  investigationProductionEffectsEnabled: true,
  providers: {
    orderBy: { order: "asc" },
    select: {
      providerKind: true,
      providerAuthMode: true,
      gatewayBindingId: true,
      gatewayProfileRef: true,
      model: true,
      reasoningEffort: true,
      agenticContext: true,
      fastMode: true,
      requiredHealthy: true,
    },
  },
} as const;

type VersionRecord = {
  readonly id: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly providerKind: string;
  readonly providerAuthMode: string;
  readonly gatewayBindingId: string | null;
  readonly gatewayProfileRef: string | null;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly agenticContext: boolean;
  readonly fastMode: boolean;
  readonly failOnSeverity: string;
  readonly inlineMaxComments: number;
  readonly providerLimit: number;
  readonly providerMaxParallel: number;
  readonly inlineMinAgreement: number;
  readonly targetTokensPerBatch: number;
  readonly reviewLanguage: string | null;
  readonly investigationRecordingEnabled: boolean;
  readonly investigationShadowEnabled: boolean;
  readonly investigationContextCriticEnabled: boolean;
  readonly investigationVerifiedCleanEnabled: boolean;
  readonly investigationCrossRevisionReplayEnabled: boolean;
  readonly investigationProductionEffectsEnabled: boolean;
  readonly providers: readonly {
    readonly providerKind: string;
    readonly providerAuthMode: string;
    readonly gatewayBindingId: string | null;
    readonly gatewayProfileRef: string | null;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly agenticContext: boolean;
    readonly fastMode: boolean;
    readonly requiredHealthy: boolean;
  }[];
};

function toPersistedConfiguration(
  version: VersionRecord,
): PersistedReviewConfiguration {
  return {
    version: version.version,
    revisionToken: `db:${version.id}`,
    config: parseReviewConfiguration({
      schemaVersion: 2,
      providers: version.providers.length
        ? version.providers.map((provider) => ({
            kind: provider.providerKind,
            authMode: provider.providerAuthMode,
            ...gatewaySelectionFromRecord(provider),
            model: provider.model,
            reasoningEffort: provider.reasoningEffort,
            agenticContext: provider.agenticContext,
            fastMode: provider.fastMode,
            requiredHealthy: provider.requiredHealthy,
          }))
        : [
            {
              kind: version.providerKind,
              authMode: version.providerAuthMode,
              ...gatewaySelectionFromRecord(version),
              model: version.model,
              reasoningEffort: version.reasoningEffort,
              agenticContext: version.agenticContext,
              fastMode: version.fastMode,
              requiredHealthy: true,
            },
          ],
      provider: {
        kind: version.providerKind,
        authMode: version.providerAuthMode,
        ...gatewaySelectionFromRecord(version),
        model: version.model,
        reasoningEffort: version.reasoningEffort,
        agenticContext: version.agenticContext,
        fastMode: version.fastMode,
        requiredHealthy: true,
      },
      execution: {
        providerLimit: version.providerLimit,
        providerMaxParallel: version.providerMaxParallel,
        inlineMinAgreement: version.inlineMinAgreement,
      },
      blockingPolicy: { failOnSeverity: version.failOnSeverity },
      limits: {
        inlineMaxComments: version.inlineMaxComments,
        targetTokensPerBatch: version.targetTokensPerBatch,
      },
      reviewLanguage: version.reviewLanguage ?? undefined,
      investigationRollout: {
        recordingEnabled: version.investigationRecordingEnabled ?? false,
        shadowEnabled: version.investigationShadowEnabled ?? false,
        contextCriticEnabled:
          version.investigationContextCriticEnabled ?? false,
        verifiedCleanEnabled:
          version.investigationVerifiedCleanEnabled ?? false,
        crossRevisionReplayEnabled:
          version.investigationCrossRevisionReplayEnabled ?? false,
        productionEffectsEnabled:
          version.investigationProductionEffectsEnabled ?? false,
      },
    }),
  };
}

function gatewaySelectionFromRecord(record: {
  readonly gatewayBindingId: string | null;
  readonly gatewayProfileRef: string | null;
}) {
  return {
    ...(record.gatewayBindingId != null
      ? { gatewayBindingId: record.gatewayBindingId }
      : {}),
    ...(record.gatewayProfileRef != null
      ? { gatewayProfileRef: record.gatewayProfileRef }
      : {}),
  };
}

async function assertGatewaySelections(
  prisma: Prisma.TransactionClient,
  workspaceId: string,
  config: ReviewConfiguration,
  operatorWorkspaceId?: string,
): Promise<void> {
  for (const provider of config.providers) {
    if (provider.authMode !== "codex_account_gateway") continue;
    const binding = await prisma.workspaceAccountBinding.findUnique({
      where: { id_workspaceId: { id: provider.gatewayBindingId, workspaceId } },
      select: {
        state: true,
        pendingFenceOperationId: true,
        pendingFencePolicySubject: true,
        pendingFencePolicyRevision: true,
        connection: {
          select: {
            ownerWorkspaceId: true,
            ownerUserId: true,
            state: true,
            profileRef: true,
            ownerWorkspace: { select: { personalOwnerUserId: true } },
          },
        },
      },
    });
    if (
      !binding ||
      binding.state !== "active" ||
      binding.pendingFenceOperationId !== null ||
      binding.pendingFencePolicySubject !== null ||
      binding.pendingFencePolicyRevision !== null ||
      (binding.connection.ownerWorkspaceId !== workspaceId &&
        (operatorWorkspaceId === undefined ||
          binding.connection.ownerWorkspaceId !== operatorWorkspaceId)) ||
      binding.connection.ownerUserId !== null ||
      binding.connection.ownerWorkspace?.personalOwnerUserId !== null ||
      binding.connection.state !== "active"
    ) {
      throw new Error("review_configuration_gateway_binding_unavailable");
    }
    if (binding.connection.profileRef !== provider.gatewayProfileRef) {
      throw new Error("review_configuration_gateway_profile_mismatch");
    }
  }
}
